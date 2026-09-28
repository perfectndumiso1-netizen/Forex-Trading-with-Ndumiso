/**
 * backtest.js — Walk-forward backtesting engine (pure functions).
 *
 * Walks historical candles bar-by-bar, calling analyzePair at each step
 * with only data available up to that bar (no look-ahead bias).
 * Tracks simulated trades from entry to SL/TP.
 */

import { analyzePair, isDuplicate } from "./signals.js";

/**
 * Resolve pip size for a pair. Defaults to 0.0001 (standard 4-digit pairs).
 * Pair configs from assets/js/config.js carry pipSize explicitly.
 */
function pairPipSize(pair) {
  return (pair && typeof pair.pipSize === "number") ? pair.pipSize : 0.0001;
}

/**
 * Run a backtest on a single pair.
 *
 * @param {Object} data         { TF_ID: [all historical candles] }
 * @param {Object} pair         pair config (must include at minimum { symbol, pipSize })
 * @param {Object} options      { startIndex, initialCapital, commissionPips }
 * @returns {Object}            { signals, trades, equity }
 */
export function backtest(data, pair, options = {}) {
  const { warmup = 300, commissionPips = 0 } = options;
  const tfIds = Object.keys(data);
  const primaryTF = "H1"; // walk-forward on H1 bars
  const primaryCandles = data[primaryTF] || [];
  const signals = [];
  const trades = [];
  let openTrade = null;
  const pip = pairPipSize(pair);

  if (primaryCandles.length < warmup + 50) {
    return { signals, trades, error: "Insufficient data for backtest" };
  }

  for (let i = warmup; i < primaryCandles.length; i++) {
    // Build sliced data up to bar i (no future data)
    const sliceData = {};
    for (const tf of tfIds) {
      sliceData[tf] = sliceCandlesToTime(data[tf], primaryCandles[i].time);
    }
    // Check existing open trade against current bar
    if (openTrade) {
      const bar = primaryCandles[i];
      const closed = evaluateTradeOnBar(openTrade, bar, pip, commissionPips);
      if (closed) {
        trades.push(closed);
        openTrade = null;
      } else {
        continue; // don't generate new signals while in a trade
      }
    }
    // Skip if duplicate
    const activeSignals = signals.filter(s => s.status === "ACTIVE");
    const result = analyzePair(sliceData, pair);
    if (result.signal === "NO TRADE") continue;
    if (isDuplicate(result, activeSignals, 4)) continue;

    result.id = `bt-${pair.symbol}-${i}`;
    result.status = "ACTIVE";
    signals.push(result);
    // Open a simulated trade
    openTrade = {
      signalId: result.id,
      pair: pair.symbol,
      direction: result.signal,
      entry: result.entry,
      stopLoss: result.stopLoss,
      takeProfit: result.takeProfit,
      rr: result.riskReward,
      pipSize: pip,
      openedAt: primaryCandles[i].time,
      barsInTrade: 0,
    };
  }
  return { signals, trades, openTrade };
}

// ── Slice multi-TF data to only candles at or before a given timestamp ──────
function sliceCandlesToTime(candles, time) {
  // Support both raw array and validation-result shape
  const arr = Array.isArray(candles) ? candles : (candles && candles.candles) || [];
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].time <= time) lo = mid + 1; else hi = mid;
  }
  return arr.slice(0, lo);
}

// ── Check if an open trade hits SL or TP on a given bar ─────────────────────
function evaluateTradeOnBar(trade, bar, pipSize, commissionPips) {
  trade.barsInTrade++;
  const pip = (typeof pipSize === "number" && pipSize > 0) ? pipSize : (trade.pipSize || 0.0001);
  if (trade.direction === "BUY") {
    if (bar.low <= trade.stopLoss) {
      return { ...trade, result: "LOSS", exitPrice: trade.stopLoss, pips: -(Math.abs(trade.entry - trade.stopLoss) / pip) - commissionPips, closedAt: bar.time };
    }
    if (bar.high >= trade.takeProfit) {
      return { ...trade, result: "WIN", exitPrice: trade.takeProfit, pips: (Math.abs(trade.takeProfit - trade.entry) / pip) - commissionPips, closedAt: bar.time, rr: trade.rr };
    }
  } else {
    if (bar.high >= trade.stopLoss) {
      return { ...trade, result: "LOSS", exitPrice: trade.stopLoss, pips: -(Math.abs(trade.stopLoss - trade.entry) / pip) - commissionPips, closedAt: bar.time };
    }
    if (bar.low <= trade.takeProfit) {
      return { ...trade, result: "WIN", exitPrice: trade.takeProfit, pips: (Math.abs(trade.entry - trade.takeProfit) / pip) - commissionPips, closedAt: bar.time, rr: trade.rr };
    }
  }
  return null;
}
