/**
 * risk.js — Entry, stop-loss, take-profit and risk/reward calculation (pure functions).
 *
 * SL uses ATR + nearest market structure level (swing high/low or S/R zone).
 * TP uses nearest opposing structure level, ATR extension, and enforces min R:R.
 */

import { swingHighs, swingLows } from "./structure.js";

/**
 * Calculate stop-loss distance.
 * For BUY: stop = min( entry - atrMult*ATR, nearest swing low buffer )
 * For SELL: stop = max( entry + atrMult*ATR, nearest swing high buffer )
 */
export function calculateStopLoss(candles, direction, entry, atrValue, atrMult = 1.5, structureBufferPct = 0.001) {
  const i = candles.length - 1;
  const lookback = 20;
  if (direction === "BUY") {
    const atrStop = entry - atrValue * atrMult;
    // Find nearest swing low within lookback
    const sl = swingLows(candles, 5);
    let nearestLow = Infinity;
    for (let j = Math.max(0, i - lookback); j <= i; j++) {
      if (sl[j] && sl[j].price < entry && sl[j].price < nearestLow && entry - sl[j].price < atrValue * atrMult * 1.8) {
        nearestLow = sl[j].price;
      }
    }
    const structureStop = nearestLow < Infinity ? nearestLow * (1 - structureBufferPct) : atrStop;
    const stop = Math.min(atrStop, structureStop);
    return stop;
  } else {
    const atrStop = entry + atrValue * atrMult;
    const sh = swingHighs(candles, 5);
    let nearestHigh = -Infinity;
    for (let j = Math.max(0, i - lookback); j <= i; j++) {
      if (sh[j] && sh[j].price > entry && sh[j].price > nearestHigh && sh[j].price - entry < atrValue * atrMult * 1.8) {
        nearestHigh = sh[j].price;
      }
    }
    const structureStop = nearestHigh > -Infinity ? nearestHigh * (1 + structureBufferPct) : atrStop;
    const stop = Math.max(atrStop, structureStop);
    return stop;
  }
}

/**
 * Calculate take-profit targets. Returns an array of TP levels (TP1, TP2, TP3).
 * Considers structure levels if available, else uses ATR multiples.
 */
export function calculateTakeProfit(candles, direction, entry, stop, atrValue, zones = [], minRR = 1.5) {
  const risk = Math.abs(entry - stop);
  const tpLevels = [];
  const i = candles.length - 1;
  const lookforward = 50;

  // TP1: minimum R:R target
  const tp1RR = minRR;
  let tp1 = direction === "BUY" ? entry + risk * tp1RR : entry - risk * tp1RR;

  // Try to find a structure level near TP1-TP3 that acts as a natural target
  const sortedZones = [...zones].sort((a, b) =>
    direction === "BUY" ? a.price - b.price : b.price - a.price
  );
  let structureTp = null;
  for (const z of sortedZones) {
    const beyond = direction === "BUY" ? z.price > entry : z.price < entry;
    const withinRange = direction === "BUY"
      ? z.price - entry < atrValue * 5
      : entry - z.price < atrValue * 5;
    if (beyond && withinRange) {
      const rr = Math.abs(z.price - entry) / risk;
      if (rr >= minRR) { structureTp = z.price; break; }
    }
  }
  if (structureTp !== null) {
    tp1 = structureTp;
  }
  tpLevels.push({ level: tp1, rr: Math.abs(tp1 - entry) / risk, label: "TP1 (structure/1R)" });

  // TP2: 2R extension
  const tp2 = direction === "BUY" ? entry + risk * 2.2 : entry - risk * 2.2;
  tpLevels.push({ level: tp2, rr: 2.2, label: "TP2 (2.2R)" });

  // TP3: 3R extension
  const tp3 = direction === "BUY" ? entry + risk * 3.5 : entry - risk * 3.5;
  tpLevels.push({ level: tp3, rr: 3.5, label: "TP3 (3.5R)" });

  return tpLevels;
}

/**
 * Calculate risk/reward for a trade setup.
 */
export function riskReward(direction, entry, stop, tp) {
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(tp - entry);
  if (risk === 0) return 0;
  return reward / risk;
}

/**
 * Position size (lot or units) based on account risk %.
 * pipValuePerLot is approximate; user can override.
 */
export function positionSize(accountBalance, riskPercent, entry, stop, pipSize = 0.0001, pipValuePerLot = 10) {
  const riskAmount = accountBalance * (riskPercent / 100);
  const pipsRisked = Math.abs(entry - stop) / pipSize;
  if (pipsRisked === 0) return 0;
  // Standard lot = 100,000 units, pip value ~$10/pip for EURUSD (varies)
  const lots = riskAmount / (pipsRisked * pipValuePerLot);
  return Math.round(lots * 100) / 100; // round to 0.01 lot
}
