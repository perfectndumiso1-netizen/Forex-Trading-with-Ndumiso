/**
 * signals.js — Signal generation orchestrator (pure functions).
 *
 * Pipeline:
 *   candles (per TF) → validate → indicators → structure → momentum → volatility
 *   → multi-TF alignment → confluence scoring → BUY / SELL / NO TRADE
 *
 * Signal engine has NO knowledge of APIs, filesystem, or GitHub. It receives
 * normalized candle objects and returns signal objects. This makes it
 * runnable in browser, Actions, backtester, and tests with identical results.
 */

import { ema, sma, rsi, atr, closes } from "./indicators.js";
import {
  swingHighs, swingLows, supportResistance, trendStructure, maAlignment, breakoutRetest,
} from "./structure.js";
import { compositeMomentum } from "./momentum.js";
import { volatilityRegime, volatilitySqueeze } from "./volatility.js";
import { calculateStopLoss, calculateTakeProfit, riskReward } from "./risk.js";
import { STRATEGY_VERSION, INDICATOR_PARAMS, SIGNAL_PARAMS, TIMEFRAMES } from "../assets/js/config.js";

// Minimum per-timeframe data quality required to emit a signal.
// Below this we return NO TRADE even if confluence appears high, because
// indicators computed on bad/incomplete/stale data are not trustworthy.
const MIN_TF_QUALITY = 0.6;
// Minimum overall data quality to emit a signal.
const MIN_OVERALL_QUALITY = 60; // as percentage (0-100)
// Critical (non-optional) TFs — if any of these is unusable we cannot trade.
// Optional TFs (M5) can be missing/unusable without blocking signals.
const CRITICAL_TFS = TIMEFRAMES.filter(t => !t.optional).map(t => t.id);

/**
 * Get the pip size for a pair config. Falls back to 0.0001 if pair isn't found.
 */
function pipSizeFor(pair) {
  return (pair && typeof pair.pipSize === "number") ? pair.pipSize : 0.0001;
}

/**
 * Analyze a single pair across multiple timeframes.
 *
 * @param {Object} priceData  { TF_ID: [candles] | validationResult, ... }
 *   Each entry may be either a raw candle array or a {candles, quality, usable}
 *   validation result (preferred — gives us freshness/usable flags).
 * @param {Object} pair       pair config object ({ symbol, pipSize, ... })
 * @param {Object} options    overrides for defaults
 * @returns {Object}          { signal: 'BUY'|'SELL'|'NO TRADE', ... }
 */
export function analyzePair(priceData, pair, options = {}) {
  const params = { ...INDICATOR_PARAMS, ...SIGNAL_PARAMS, ...options };
  const tfIds = Object.keys(priceData).sort(tfOrder);
  const tfAnalysis = {};
  const reasons = [];
  let totalQuality = 0;
  let qualityCount = 0;

  // ── Phase 1: Per-timeframe analysis (higher → lower) ────────────────────
  for (const tf of tfIds) {
    const entry = priceData[tf];
    // Accept either raw array or validation result object
    const candles = Array.isArray(entry) ? entry : (entry && entry.candles) || [];
    const vQuality = (!Array.isArray(entry) && entry && typeof entry.quality === "number") ? entry.quality : null;
    const vUsable = (!Array.isArray(entry) && entry && typeof entry.usable === "boolean") ? entry.usable : null;
    const vFresh = (!Array.isArray(entry) && entry && typeof entry.freshness === "number") ? entry.freshness : null;
    const isOptional = TIMEFRAMES.find(t => t.id === tf)?.optional;

    // For non-optional TFs: unusable data blocks the pair entirely.
    // For optional TFs (M5): skip if unusable but don't fail the pair.
    if (vUsable === false) {
      reasons.push(`${tf}: data not usable${entry && entry.issues && entry.issues.length ? " (" + entry.issues[0] + ")" : ""}`);
      if (!isOptional) {
        return noTrade(pair, reasons, {});
      }
      continue;
    }
    if (candles.length < 50) {
      reasons.push(`${tf}: insufficient candles (${candles.length})`);
      if (!isOptional) {
        return noTrade(pair, reasons, {});
      }
      continue;
    }
    const result = analyzeTimeframe(candles, params);
    if (vQuality !== null) result.dataQuality = vQuality;
    if (vFresh !== null && vFresh < 1) result.freshness = vFresh;
    tfAnalysis[tf] = result;
    if (result.dataQuality !== null) {
      totalQuality += result.dataQuality * 100; // convert 0-1 → 0-100
      qualityCount++;
    }
  }

  // All critical (non-optional) TFs must be present with acceptable quality
  for (const tf of CRITICAL_TFS) {
    const a = tfAnalysis[tf];
    if (!a) {
      return noTrade(pair, reasons.concat([`${tf}: missing or unusable — cannot confirm hierarchy`]), tfAnalysis);
    }
    if (a.dataQuality < MIN_TF_QUALITY) {
      return noTrade(pair, reasons.concat([`${tf}: data quality ${Math.round(a.dataQuality*100)}% below threshold ${Math.round(MIN_TF_QUALITY*100)}%`]), tfAnalysis);
    }
  }

  const overallQuality = qualityCount > 0 ? Math.round(totalQuality / qualityCount) : 0;

  if (overallQuality < MIN_OVERALL_QUALITY) {
    return noTrade(pair, reasons.concat([`Overall data quality ${overallQuality}% below ${MIN_OVERALL_QUALITY}%`]), tfAnalysis);
  }

  // ── Phase 2: Hierarchical multi-TF alignment ────────────────────────────
  const alignment = multiTimeframeAlignment(tfAnalysis);
  reasons.push(...alignment.details);

  if (alignment.direction === "MIXED" || alignment.direction === "NONE") {
    return noTrade(pair, reasons.concat(["No aligned setup across timeframes"]), tfAnalysis);
  }

  // ── Phase 3: Entry timing from lowest non-optional TF ────────────────────
  const entryTF = findEntryTF(tfAnalysis, alignment.direction);
  if (!entryTF) {
    return noTrade(pair, reasons.concat(["Direction aligned but no entry trigger on confirmation TF"]), tfAnalysis);
  }

  const entryAnalysis = tfAnalysis[entryTF];
  const candles = priceData[entryTF];
  // If priceData was a validation result, use the candles array inside it
  const candlesArr = Array.isArray(candles) ? candles : (candles && candles.candles) || [];
  const currentPrice = candlesArr[candlesArr.length - 1].close;
  const atrVal = entryAnalysis.atr;

  // ── Phase 4: Volatility filter ──────────────────────────────────────────
  if (entryAnalysis.volatility.regime === "extreme") {
    return noTrade(pair, reasons.concat(["Extreme volatility regime — avoid trading"]), tfAnalysis);
  }
  if (entryAnalysis.volatility.regime === "low" && !entryAnalysis.squeeze?.squeezed) {
    reasons.push("Low volatility regime — require breakout confirmation");
  }

  // ── Phase 5: Confluence scoring ─────────────────────────────────────────
  const score = alignment.score + entryAnalysis.momentum.score * 0.3;
  const strength = Math.max(0, Math.min(100, Math.round(score)));

  if (strength < params.minConfluence) {
    return noTrade(pair, reasons.concat([`Confluence score ${strength} below threshold ${params.minConfluence}`]), tfAnalysis);
  }

  // ── Phase 6: SL / TP / R:R calculation ──────────────────────────────────
  const direction = alignment.direction;
  const zones = entryAnalysis.zones || [];
  const stop = calculateStopLoss(candles, direction, currentPrice, atrVal, params.atrStopMultiplier);
  const tpLevels = calculateTakeProfit(candles, direction, currentPrice, stop, atrVal, zones, params.minRiskReward);
  const primaryTP = tpLevels[0].level;
  const rr = riskReward(direction, currentPrice, stop, primaryTP);

  if (rr < params.minRiskReward) {
    return noTrade(pair, reasons.concat([`Risk/Reward ${rr.toFixed(2)} below minimum ${params.minRiskReward}`]), tfAnalysis);
  }

  // Validate that SL/TP/risk are sensible (no NaN, no absurd distances > 15% of price)
  if (!isFinite(stop) || !isFinite(primaryTP) || !isFinite(atrVal) || atrVal <= 0) {
    return noTrade(pair, reasons.concat(["Invalid SL/TP/ATR computed — possible bad data"]), tfAnalysis);
  }
  const pip = pipSizeFor(pair);
  const priceDecimals = pip < 0.001 ? 5 : 3;
  const pipsRisk = Math.abs(currentPrice - stop) / pip;
  // Sanity: SL must be between 5 and 500 pips for any pair (rejects corrupted data)
  if (pipsRisk < 5 || pipsRisk > 500) {
    return noTrade(pair, reasons.concat([`Rejected: stop distance ${pipsRisk.toFixed(1)} pips outside sane range (5-500)`]), tfAnalysis);
  }

  reasons.push(`Entry on ${entryTF} at ${currentPrice.toFixed(priceDecimals)}`);
  reasons.push(`SL: ${stop.toFixed(priceDecimals)} (${pipsRisk.toFixed(1)} pips)`);
  reasons.push(`TP1: ${primaryTP.toFixed(priceDecimals)} (R:R ${rr.toFixed(2)})`);
  reasons.push(`Volatility: ${entryAnalysis.volatility.regime} (ATR ${atrVal.toFixed(priceDecimals)})`);

  return {
    signal: direction,
    pair: pair.symbol,
    entryTF,
    entry: currentPrice,
    stopLoss: stop,
    takeProfit: primaryTP,
    takeProfitLevels: tpLevels,
    riskReward: rr,
    atr: atrVal,
    pipSize: pip,
    strength,
    dataQuality: overallQuality,
    strategyVersion: STRATEGY_VERSION,
    reasons,
    tfAnalysis,
    zones,
    timestamp: new Date().toISOString(),
  };
}

// ── Helper: construct a NO TRADE result ─────────────────────────────────────
function noTrade(pair, reasons, tfAnalysis) {
  return {
    signal: "NO TRADE",
    pair: pair.symbol,
    strength: 0,
    dataQuality: 0,
    strategyVersion: STRATEGY_VERSION,
    reasons,
    tfAnalysis: tfAnalysis || {},
    timestamp: new Date().toISOString(),
  };
}

// ── Single-timeframe analysis ────────────────────────────────────────────────
function analyzeTimeframe(candles, params) {
  const c = closes(candles);
  const ef = ema(c, params.emaFast);
  const es = ema(c, params.emaSlow);
  const st = sma(c, params.smaTrend);
  const sl = sma(c, params.smaLong);
  const a  = atr(candles, params.atrPeriod);
  const i = c.length - 1;

  const ma = maAlignment(ef, es, st, sl);
  const trend = trendStructure(candles, params.swingLookback);
  const zones = supportResistance(candles, params.swingLookback, 0.0015, params.srTouches);
  const vol = volatilityRegime(candles, params.atrPeriod);
  const sqz = volatilitySqueeze(candles, params.atrPeriod);
  const mom = compositeMomentum(c, {
    rsiPeriod: params.rsiPeriod, rsiOB: params.rsiOverbought, rsiOS: params.rsiOversold,
    macdFast: params.macdFast, macdSlow: params.macdSlow, macdSig: params.macdSignal,
  });
  const br = breakoutRetest(candles, zones, a[i] || 0);

  // Data quality: ratio of candles that have valid indicator values.
  // Once we have enough bars to warm up all indicators, quality is 1.
  const validFrom = Math.max(params.smaLong, params.atrPeriod + params.swingLookback);
  const dataQuality = c.length >= validFrom ? 1 : c.length / validFrom;

  return {
    ma, trend, zones, volatility: vol, squeeze: sqz, momentum: mom, breakout: br,
    atr: a[i], emaFast: ef[i], emaSlow: es[i], smaTrend: st[i], smaLong: sl[i],
    close: c[i], dataQuality,
  };
}

// ── Multi-timeframe alignment ───────────────────────────────────────────────
function multiTimeframeAlignment(tfAnalysis) {
  const tfs = Object.keys(tfAnalysis).sort(tfOrder);
  const scores = { BUY: 0, SELL: 0 };
  const details = [];
  const weights = { D1: 4, H4: 3, H1: 2, M15: 1.5, M5: 0.8 };

  for (const tf of tfs) {
    const a = tfAnalysis[tf];
    if (!a) continue;
    const w = weights[tf] || 1;
    let tfDir = null;
    // Combine MA alignment + trend structure
    if (a.ma.alignment === "BULL" && a.trend.direction !== "DOWN") {
      tfDir = "BUY";
    } else if (a.ma.alignment === "BEAR" && a.trend.direction !== "UP") {
      tfDir = "SELL";
    } else if (a.ma.alignment === "BULL" && a.trend.direction === "DOWN") {
      tfDir = null; // conflict
    } else if (a.ma.alignment === "BEAR" && a.trend.direction === "UP") {
      tfDir = null; // conflict
    } else if (a.trend.direction === "UP") tfDir = "BUY";
    else if (a.trend.direction === "DOWN") tfDir = "SELL";
    if (tfDir) {
      scores[tfDir] += w * (a.ma.score / 100) * (a.trend.confidence / 100);
      details.push(`${tf}: ${tfDir} bias (MA ${a.ma.alignment}, trend ${a.trend.direction} ${a.trend.confidence}%)`);
    } else {
      details.push(`${tf}: neutral/conflicting`);
    }
  }

  const total = scores.BUY + scores.SELL;
  if (total === 0) return { direction: "NONE", score: 0, confluence: 0, details };
  const buyShare = scores.BUY / total;
  const sellShare = scores.SELL / total;
  // Require at least 65% weight in one direction AND higher TFs agree
  const d1 = tfAnalysis.D1;
  const h4 = tfAnalysis.H4;
  let direction = "MIXED";
  if (buyShare > 0.65) {
    // Higher TF confirmation
    const d1Ok = !d1 || d1.ma.alignment !== "BEAR";
    const h4Ok = !h4 || h4.ma.alignment !== "BEAR" || h4.trend.direction !== "DOWN";
    if (d1Ok && h4Ok) direction = "BUY";
  } else if (sellShare > 0.65) {
    const d1Ok = !d1 || d1.ma.alignment !== "BULL";
    const h4Ok = !h4 || h4.ma.alignment !== "BULL" || h4.trend.direction !== "UP";
    if (d1Ok && h4Ok) direction = "SELL";
  }
  const confluence = Math.round(Math.max(buyShare, sellShare) * 100);
  const score = Math.round((Math.max(scores.BUY, scores.SELL) / total) * 60); // up to 60 from alignment
  return { direction, score, confluence, details };
}

// ── Find the lowest TF with an entry trigger ────────────────────────────────
function findEntryTF(tfAnalysis, direction) {
  // Entry triggers: momentum crossover or breakout/retest on confirmation TF
  const entryTfOrder = ["M15", "H1", "H4"];
  for (const tf of entryTfOrder) {
    const a = tfAnalysis[tf];
    if (!a) continue;
    const mom = a.momentum;
    const br = a.breakout;
    if (direction === "BUY") {
      if (mom.rsi?.state === "oversold" || mom.rsi?.state === "bullish") {
        if (mom.macd?.state === "bullish_cross" || mom.macd?.state === "bullish") return tf;
      }
      if (br.type === "breakout_bull" || br.type === "retest_bull") return tf;
    } else {
      if (mom.rsi?.state === "overbought" || mom.rsi?.state === "bearish") {
        if (mom.macd?.state === "bearish_cross" || mom.macd?.state === "bearish") return tf;
      }
      if (br.type === "breakout_bear" || br.type === "retest_bear") return tf;
    }
  }
  // Fallback: if momentum strongly aligned on H1, allow entry
  const h1 = tfAnalysis.H1;
  if (h1) {
    const momAligned = direction === "BUY" ? h1.momentum.score > 20 : h1.momentum.score < -20;
    if (momAligned) return "H1";
  }
  return null;
}

// ── TF ordering helper (highest to lowest) ──────────────────────────────────
const TF_RANK = { D1: 0, H4: 1, H1: 2, M15: 3, M5: 4 };
function tfOrder(a, b) { return (TF_RANK[a] ?? 99) - (TF_RANK[b] ?? 99); }

// ── Duplicate detection ─────────────────────────────────────────────────────
/**
 * Check if a proposed signal is a duplicate of an existing active signal
 * within the cooldown window.
 */
export function isDuplicate(signal, existingSignals, cooldownHours = 4) {
  for (const s of existingSignals) {
    if (s.pair !== signal.pair) continue;
    if (s.signal !== signal.signal) continue;
    if (s.status !== "ACTIVE") continue;
    const ageH = (new Date(signal.timestamp) - new Date(s.timestamp)) / (1000 * 60 * 60);
    if (Math.abs(ageH) < cooldownHours) return true;
    if (s.entryTF === signal.entryTF) {
      const priceDiff = Math.abs(s.entry - signal.entry);
      const atr = s.atr || 0.001;
      if (priceDiff < atr * 0.5) return true;
    }
  }
  return false;
}
