/**
 * backtest.js — Walk-forward backtesting engine (pure functions).
 *
 * Walks historical candles bar-by-bar, calling analyzePair at each step
 * with only data available up to that bar (no look-ahead bias).
 * Tracks simulated trades from entry to SL/TP.
 */

import { analyzePair, isDuplicate } from "./signals.js";

/**
 * Run a backtest on a single pair.
 *
 * @param {Object} data         { TF_ID: [all historical candles] }
 * @param {Object} pair         pair config
 * @param {Object} options      { startIndex, initialCapital, comissionPips }
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
      const closed = evaluateTradeOnBar(openTrade, bar, commissionPips);
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
      openedAt: primaryCandles[i].time,
      barsInTrade: 0,
    };
  }
  return { signals, trades, openTrade };
}

// ── Slice multi-TF data to only candles at or before a given timestamp ──────
function sliceCandlesToTime(candles, time) {
  let lo = 0, hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time <= time) lo = mid + 1; else hi = mid;
  }
  return candles.slice(0, lo);
}

// ── Check if an open trade hits SL or TP on a given bar ─────────────────────
function evaluateTradeOnBar(trade, bar, commissionPips) {
  trade.barsInTrade++;
  if (trade.direction === "BUY") {
    if (bar.low <= trade.stopLoss) {
      return { ...trade, result: "LOSS", exitPrice: trade.stopLoss, pips: -(Math.abs(trade.entry - trade.stopLoss) / 0.0001) - commissionPips, closedAt: bar.time };
    }
    if (bar.high >= trade.takeProfit) {
      return { ...trade, result: "WIN", exitPrice: trade.takeProfit, pips: (Math.abs(trade.takeProfit - trade.entry) / 0.0001) - commissionPips, closedAt: bar.time, rr: trade.rr };
    }
  } else {
    if (bar.high >= trade.stopLoss) {
      return { ...trade, result: "LOSS", exitPrice: trade.stopLoss, pips: -(Math.abs(trade.stopLoss - trade.entry) / 0.0001) - commissionPips, closedAt: bar.time };
    }
    if (bar.low <= trade.takeProfit) {
      return { ...trade, result: "WIN", exitPrice: trade.takeProfit, pips: (Math.abs(trade.entry - trade.takeProfit) / 0.0001) - commissionPips, closedAt: bar.time, rr: trade.rr };
    }
  }
  return null;
}
