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
import { STRATEGY_VERSION, INDICATOR_PARAMS, SIGNAL_PARAMS } from "../assets/js/config.js";

/**
 * Analyze a single pair across multiple timeframes.
 *
 * @param {Object} priceData  { TF_ID: [candles], ... } — candles ordered chronologically, oldest first.
 * @param {Object} pair       pair config object ({ symbol, pipSize, ... })
 * @param {Object} options    overrides for defaults
 * @returns {Object}          { signal: 'BUY'|'SELL'|'NO TRADE', strength, dataQuality, reasons, ... }
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
    const candles = priceData[tf];
    const result = analyzeTimeframe(candles, params);
    tfAnalysis[tf] = result;
    if (result.dataQuality !== null) {
      totalQuality += result.dataQuality;
      qualityCount++;
    }
  }

  const overallQuality = qualityCount > 0 ? Math.round((totalQuality / qualityCount) * 100) : 0;

  // ── Phase 2: Hierarchical multi-TF alignment ────────────────────────────
  // Rule: higher TFs must agree on direction for a signal to be valid on lower TFs.
  const alignment = multiTimeframeAlignment(tfAnalysis);
  reasons.push(...alignment.details);

  if (alignment.direction === "MIXED" || alignment.direction === "NONE") {
    return {
      signal: "NO TRADE",
      pair: pair.symbol,
      strength: 0,
      dataQuality: overallQuality,
      strategyVersion: STRATEGY_VERSION,
      reasons: [...reasons, "No aligned setup across timeframes"],
      tfAnalysis,
      timestamp: new Date().toISOString(),
    };
  }

  // ── Phase 3: Entry timing from lowest non-optional TF ────────────────────
  const entryTF = findEntryTF(tfAnalysis, alignment.direction);
  if (!entryTF) {
    return {
      signal: "NO TRADE",
      pair: pair.symbol,
      strength: alignment.confluence,
      dataQuality: overallQuality,
      strategyVersion: STRATEGY_VERSION,
      reasons: [...reasons, "Direction aligned but no entry trigger on confirmation TF"],
      tfAnalysis,
      timestamp: new Date().toISOString(),
    };
  }

  const entryAnalysis = tfAnalysis[entryTF];
  const candles = priceData[entryTF];
  const currentPrice = candles.at(-1).close;
  const atrVal = entryAnalysis.atr;

  // ── Phase 4: Volatility filter ──────────────────────────────────────────
  if (entryAnalysis.volatility.regime === "extreme") {
    return {
      signal: "NO TRADE",
      pair: pair.symbol,
      strength: alignment.confluence,
      dataQuality: overallQuality,
      strategyVersion: STRATEGY_VERSION,
      reasons: [...reasons, "Extreme volatility regime — avoid trading"],
      tfAnalysis,
      timestamp: new Date().toISOString(),
    };
  }
  if (entryAnalysis.volatility.regime === "low" && !entryAnalysis.squeeze?.squeezed) {
    reasons.push("Low volatility regime — require breakout confirmation");
  }

  // ── Phase 5: Confluence scoring ─────────────────────────────────────────
  const score = alignment.score + entryAnalysis.momentum.score * 0.3;
  const strength = Math.max(0, Math.min(100, Math.round(score)));

  if (strength < params.minConfluence) {
    return {
      signal: "NO TRADE",
      pair: pair.symbol,
      strength,
      dataQuality: overallQuality,
      strategyVersion: STRATEGY_VERSION,
      reasons: [...reasons, `Confluence score ${strength} below threshold ${params.minConfluence}`],
      tfAnalysis,
      timestamp: new Date().toISOString(),
    };
  }

  // ── Phase 6: SL / TP / R:R calculation ──────────────────────────────────
  const direction = alignment.direction;
  const zones = entryAnalysis.zones || [];
  const stop = calculateStopLoss(candles, direction, currentPrice, atrVal, params.atrStopMultiplier);
  const tpLevels = calculateTakeProfit(candles, direction, currentPrice, stop, atrVal, zones, params.minRiskReward);
  const primaryTP = tpLevels[0].level;
  const rr = riskReward(direction, currentPrice, stop, primaryTP);

  if (rr < params.minRiskReward) {
    return {
      signal: "NO TRADE",
      pair: pair.symbol,
      strength,
      dataQuality: overallQuality,
      strategyVersion: STRATEGY_VERSION,
      reasons: [...reasons, `Risk/Reward ${rr.toFixed(2)} below minimum ${params.minRiskReward}`],
      tfAnalysis,
      timestamp: new Date().toISOString(),
    };
  }

  reasons.push(`Entry on ${entryTF} at ${currentPrice.toFixed(pair.symbol.includes("JPY") ? 3 : 5)}`);
  reasons.push(`SL: ${stop.toFixed(pair.symbol.includes("JPY") ? 3 : 5)} (${((currentPrice - stop) / pair.pipSize).toFixed(1)} pips)`);
  reasons.push(`TP1: ${primaryTP.toFixed(pair.symbol.includes("JPY") ? 3 : 5)} (R:R ${rr.toFixed(2)})`);
  reasons.push(`Volatility: ${entryAnalysis.volatility.regime} (ATR ${atrVal.toFixed(5)})`);

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
    strength,
    dataQuality: overallQuality,
    strategyVersion: STRATEGY_VERSION,
    reasons,
    tfAnalysis,
    zones,
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

  // Data quality: ratio of candles that have valid indicator values
  const expected = Math.min(c.length, 200);
  const validFrom = Math.max(params.smaLong, params.atrPeriod + params.swingLookback);
  const dataQuality = c.length > validFrom ? Math.min(1, validFrom / c.length) : 0;

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
