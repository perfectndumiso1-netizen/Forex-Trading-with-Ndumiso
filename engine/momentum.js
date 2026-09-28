/**
 * momentum.js — Momentum & divergence analysis (pure functions).
 */

import { rsi, macd } from "./indicators.js";

/**
 * Evaluate RSI posture at the latest bar.
 * Returns { state: 'overbought'|'oversold'|'neutral'|'bullish_divergence'|'bearish_divergence',
 *            value, details }
 */
export function rsiMomentum(closes, period = 14, obLevel = 70, osLevel = 30) {
  const r = rsi(closes, period);
  const i = r.length - 1;
  const value = r[i];
  if (value === null) return { state: "neutral", value: null, details: ["RSI not ready"] };
  if (value >= obLevel) return { state: "overbought", value, details: [`RSI ${value.toFixed(1)} — overbought (>${obLevel})`] };
  if (value <= osLevel) return { state: "oversold",   value, details: [`RSI ${value.toFixed(1)} — oversold (<${osLevel})`] };
  // Direction
  const prev = r[i - 1];
  if (prev !== null) {
    if (value > 50 && value > prev) return { state: "bullish", value, details: [`RSI ${value.toFixed(1)} rising above midline`] };
    if (value < 50 && value < prev) return { state: "bearish", value, details: [`RSI ${value.toFixed(1)} falling below midline`] };
  }
  return { state: "neutral", value, details: [`RSI ${value.toFixed(1)} in mid-range`] };
}

/**
 * MACD posture at latest bar.
 */
export function macdMomentum(closes, fast = 12, slow = 26, sig = 9) {
  const m = macd(closes, fast, slow, sig);
  const i = closes.length - 1;
  const macdVal = m.macdLine[i];
  const sigVal = m.signalLine[i];
  const hist = m.histogram[i];
  if (macdVal === null || sigVal === null) {
    return { state: "neutral", details: ["MACD not ready"] };
  }
  // Detect recent crossover within last 3 bars
  let crossover = null;
  for (let b = Math.max(0, i - 2); b < i; b++) {
    if (m.macdLine[b] === null || m.signalLine[b] === null) continue;
    const wasAbove = m.macdLine[b] > m.signalLine[b];
    const isAbove = macdVal > sigVal;
    if (wasAbove !== isAbove) {
      crossover = isAbove ? "bullish_cross" : "bearish_cross";
    }
  }
  const histogramRising = m.histogram[i - 1] !== null && hist > m.histogram[i - 1];
  if (crossover === "bullish_cross") return { state: "bullish_cross", macd: macdVal, signal: sigVal, histogram: hist, details: ["Bullish MACD crossover (0-3 bars ago)"] };
  if (crossover === "bearish_cross") return { state: "bearish_cross", macd: macdVal, signal: sigVal, histogram: hist, details: ["Bearish MACD crossover (0-3 bars ago)"] };
  if (macdVal > sigVal && histogramRising)  return { state: "bullish", macd: macdVal, signal: sigVal, histogram: hist, details: ["MACD above signal, histogram rising"] };
  if (macdVal < sigVal && !histogramRising) return { state: "bearish", macd: macdVal, signal: sigVal, histogram: hist, details: ["MACD below signal, histogram falling"] };
  if (macdVal > sigVal) return { state: "bullish_fading", macd: macdVal, signal: sigVal, histogram: hist, details: ["MACD above signal but momentum fading"] };
  return { state: "bearish_fading", macd: macdVal, signal: sigVal, histogram: hist, details: ["MACD below signal, weakening"] };
}

/**
 * Composite momentum score combining RSI + MACD.
 * Returns { score: -100..+100, details: [] }
 * Positive = bullish momentum, negative = bearish.
 */
export function compositeMomentum(closes, params = {}) {
  const {
    rsiPeriod = 14, rsiOB = 70, rsiOS = 30,
    macdFast = 12, macdSlow = 26, macdSig = 9,
  } = params;
  const rsiRes = rsiMomentum(closes, rsiPeriod, rsiOB, rsiOS);
  const macdRes = macdMomentum(closes, macdFast, macdSlow, macdSig);
  let score = 0;
  const details = [];

  // RSI contribution (±40 max)
  if (rsiRes.state === "oversold")         { score += 35; details.push(...rsiRes.details); }
  else if (rsiRes.state === "bullish")     { score += 25; details.push(...rsiRes.details); }
  else if (rsiRes.state === "overbought")  { score -= 35; details.push(...rsiRes.details); }
  else if (rsiRes.state === "bearish")     { score -= 25; details.push(...rsiRes.details); }
  else                                     { details.push(...rsiRes.details); }

  // MACD contribution (±60 max)
  if (macdRes.state === "bullish_cross")     { score += 55; details.push(...macdRes.details); }
  else if (macdRes.state === "bullish")      { score += 35; details.push(...macdRes.details); }
  else if (macdRes.state === "bearish_cross"){ score -= 55; details.push(...macdRes.details); }
  else if (macdRes.state === "bearish")      { score -= 35; details.push(...macdRes.details); }
  else if (macdRes.state === "bullish_fading")  { score += 10; details.push(...macdRes.details); }
  else if (macdRes.state === "bearish_fading")  { score -= 10; details.push(...macdRes.details); }
  else                                       { details.push(...macdRes.details); }

  return { score: Math.max(-100, Math.min(100, score)), details, rsi: rsiRes, macd: macdRes };
}
