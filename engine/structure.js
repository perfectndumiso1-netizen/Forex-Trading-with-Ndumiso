/**
 * structure.js — Market structure analysis (pure functions).
 *
 * Detects:
 *   - Swing highs / swing lows
 *   - Support & resistance levels (zone-based)
 *   - Trend classification via HH/HL/LH/LL sequencing
 *   - Breakouts & retests
 */

import { closes, highs, lows } from "./indicators.js";

// ── Swing High / Swing Low detection ────────────────────────────────────────
/**
 * A swing high at index i requires:
 *   candle[i] has the highest high in [i-lookback .. i+lookback].
 * A swing low is the mirror.
 *
 * Returns arrays of { index, price } for each swing point (null elsewhere).
 */
export function swingHighs(candles, lookback = 5) {
  const n = candles.length;
  const points = new Array(n).fill(null);
  for (let i = lookback; i < n - lookback; i++) {
    let isHigh = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) { isHigh = false; break; }
    }
    if (isHigh) points[i] = { index: i, price: candles[i].high, time: candles[i].time };
  }
  return points;
}

export function swingLows(candles, lookback = 5) {
  const n = candles.length;
  const points = new Array(n).fill(null);
  for (let i = lookback; i < n - lookback; i++) {
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].low <= candles[i].low) { isLow = false; break; }
    }
    if (isLow) points[i] = { index: i, price: candles[i].low, time: candles[i].time };
  }
  return points;
}

// ── Support & Resistance zones ──────────────────────────────────────────────
/**
 * Cluster swing highs/lows into price zones. Zones within `tolerancePct`
 * of each other are merged. Each zone tracks how many times it was touched.
 *
 * Returns [{ price, type: 'support'|'resistance'|'zone', touches, strength }]
 * sorted by proximity to current price.
 */
export function supportResistance(candles, lookback = 5, tolerancePct = 0.0015, minTouches = 2) {
  const sh = swingHighs(candles, lookback).filter(Boolean);
  const sl = swingLows(candles, lookback).filter(Boolean);
  const allPoints = [
    ...sh.map(p => ({ price: p.price, type: "resistance" })),
    ...sl.map(p => ({ price: p.price, type: "support" })),
  ];
  if (allPoints.length === 0) return [];

  // Sort by price and cluster
  allPoints.sort((a, b) => a.price - b.price);
  const zones = [];
  let current = { prices: [allPoints[0].price], types: [allPoints[0].type] };

  for (let i = 1; i < allPoints.length; i++) {
    const mid = current.prices.reduce((a, b) => a + b, 0) / current.prices.length;
    const tol = mid * tolerancePct;
    if (Math.abs(allPoints[i].price - mid) <= tol) {
      current.prices.push(allPoints[i].price);
      current.types.push(allPoints[i].type);
    } else {
      zones.push(finalizeZone(current));
      current = { prices: [allPoints[i].price], types: [allPoints[i].type] };
    }
  }
  zones.push(finalizeZone(current));

  return zones
    .filter(z => z.touches >= minTouches)
    .sort((a, b) => Math.abs(a.price - candles.at(-1).close) - Math.abs(b.price - candles.at(-1).close));
}

function finalizeZone(current) {
  const avg = current.prices.reduce((a, b) => a + b, 0) / current.prices.length;
  const supports = current.types.filter(t => t === "support").length;
  const resistances = current.types.filter(t => t === "resistance").length;
  let type = "zone";
  if (supports > resistances * 1.5) type = "support";
  else if (resistances > supports * 1.5) type = "resistance";
  return {
    price: avg,
    type,
    touches: current.prices.length,
    high: Math.max(...current.prices),
    low: Math.min(...current.prices),
    strength: Math.min(100, current.prices.length * 20), // 0-100
  };
}

// ── Trend detection via HH/HL/LH/LL ────────────────────────────────────────
/**
 * Examines recent swing structure. Returns:
 *   { direction: 'UP'|'DOWN'|'SIDEWAYS', confidence: 0-100, details: [...] }
 */
export function trendStructure(candles, lookback = 5, swings = 8) {
  const sh = swingHighs(candles, lookback).filter(Boolean).slice(-swings);
  const sl = swingLows(candles, lookback).filter(Boolean).slice(-swings);
  if (sh.length < 2 || sl.length < 2) {
    return { direction: "SIDEWAYS", confidence: 0, details: ["Insufficient swing points"] };
  }
  let higherHighs = 0, lowerHighs = 0, higherLows = 0, lowerLows = 0;
  for (let i = 1; i < sh.length; i++) {
    if (sh[i].price > sh[i - 1].price) higherHighs++;
    else lowerHighs++;
  }
  for (let i = 1; i < sl.length; i++) {
    if (sl[i].price > sl[i - 1].price) higherLows++;
    else lowerLows++;
  }
  const totalSwings = sh.length + sl.length - 2;
  const upScore = higherHighs + higherLows;
  const downScore = lowerHighs + lowerLows;
  let direction = "SIDEWAYS";
  let confidence = 0;
  const details = [];
  if (upScore > downScore * 1.5) {
    direction = "UP";
    confidence = Math.round((upScore / totalSwings) * 100);
    details.push(`${higherHighs} HH, ${higherLows} HL vs ${lowerHighs} LH, ${lowerLows} LL`);
  } else if (downScore > upScore * 1.5) {
    direction = "DOWN";
    confidence = Math.round((downScore / totalSwings) * 100);
    details.push(`${lowerHighs} LH, ${lowerLows} LL vs ${higherHighs} HH, ${higherLows} HL`);
  } else {
    direction = "SIDEWAYS";
    confidence = Math.round((1 - Math.abs(upScore - downScore) / totalSwings) * 100);
    details.push("Mixed structure — ranging");
  }
  return { direction, confidence, details, higherHighs, lowerHighs, higherLows, lowerLows };
}

// ── EMA/SMA alignment ──────────────────────────────────────────────────────
/**
 * Returns { alignment: 'BULL'|'BEAR'|'NEUTRAL', details } based on whether
 * fast > slow > long in a bullish stack, or reverse in bearish.
 */
export function maAlignment(emaFast, emaSlow, smaTrend, smaLong) {
  const i = emaFast.length - 1;
  if ([emaFast[i], emaSlow[i], smaTrend[i], smaLong[i]].some(v => v === null || v === undefined)) {
    return { alignment: "NEUTRAL", score: 0, details: ["Insufficient MA data"] };
  }
  const bull = emaFast[i] > emaSlow[i] && emaSlow[i] > smaTrend[i] && smaTrend[i] > smaLong[i];
  const bear = emaFast[i] < emaSlow[i] && emaSlow[i] < smaTrend[i] && smaTrend[i] < smaLong[i];
  // Partial alignment scoring
  const orderBull = [emaFast[i], emaSlow[i], smaTrend[i], smaLong[i]];
  const orderBear = [...orderBull].reverse();
  let bullScore = 0;
  for (let j = 0; j < orderBull.length - 1; j++) {
    if (orderBull[j] > orderBull[j + 1]) bullScore++;
  }
  let bearScore = 0;
  for (let j = 0; j < orderBear.length - 1; j++) {
    if (orderBear[j] > orderBear[j + 1]) bearScore++;
  }
  if (bull) return { alignment: "BULL", score: 100, details: ["Full bullish MA alignment: fast > slow > trend > long"] };
  if (bear) return { alignment: "BEAR", score: 100, details: ["Full bearish MA alignment: fast < slow < trend < long"] };
  if (bullScore >= bearScore) return { alignment: "BULL", score: Math.round(bullScore / 3 * 100), details: [`Partial bullish alignment (${bullScore}/3)`] };
  return { alignment: "BEAR", score: Math.round(bearScore / 3 * 100), details: [`Partial bearish alignment (${bearScore}/3)`] };
}

// ── Breakout / Retest detection ────────────────────────────────────────────
/**
 * Check if current price has broken a level and is now retesting it.
 * Returns { type: 'breakout_bull'|'breakout_bear'|'retest_bull'|'retest_bear'|null, level }
 */
export function breakoutRetest(candles, zones, atrValue) {
  if (zones.length === 0 || !atrValue) return { type: null, level: null };
  const current = candles.at(-1);
  const prev = candles.at(-2);
  if (!prev) return { type: null, level: null };
  const threshold = atrValue * 0.2;
  for (const zone of zones.slice(0, 5)) {
    // Bullish breakout: closed above resistance zone
    if (zone.type !== "support" && prev.close <= zone.high && current.close > zone.high + threshold) {
      return { type: "breakout_bull", level: zone };
    }
    // Bearish breakout
    if (zone.type !== "resistance" && prev.close >= zone.low && current.close < zone.low - threshold) {
      return { type: "breakout_bear", level: zone };
    }
    // Bullish retest: broke above, now pulling back to zone from above
    if (zone.type !== "support") {
      const brokeAbove = candles.slice(-10).some(c => c.close > zone.high + threshold);
      const nowTesting = current.low <= zone.high + threshold && current.close > zone.low - threshold && current.close > current.open;
      if (brokeAbove && nowTesting) return { type: "retest_bull", level: zone };
    }
    // Bearish retest
    if (zone.type !== "resistance") {
      const brokeBelow = candles.slice(-10).some(c => c.close < zone.low - threshold);
      const nowTesting = current.high >= zone.low - threshold && current.close < zone.high + threshold && current.close < current.open;
      if (brokeBelow && nowTesting) return { type: "retest_bear", level: zone };
    }
  }
  return { type: null, level: null };
}
