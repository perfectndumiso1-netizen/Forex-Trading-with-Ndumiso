/**
 * volatility.js — Volatility regime detection & ATR-based sizing (pure functions).
 */

import { atr, bollinger, closes } from "./indicators.js";

/**
 * Classify the current volatility regime by comparing recent ATR to a
 * longer-term average.
 * Returns { regime: 'low'|'normal'|'high'|'extreme', atr, atrPercent, details }
 */
export function volatilityRegime(candles, atrPeriod = 14, lookbackLong = 100) {
  const a = atr(candles, atrPeriod);
  const i = candles.length - 1;
  const curAtr = a[i];
  if (curAtr === null) return { regime: "unknown", atr: null, atrPercent: null, details: ["ATR not ready"] };
  const price = candles[i].close;
  const atrPercent = (curAtr / price) * 100;
  // Build a trailing average of ATR values
  const start = Math.max(atrPeriod - 1, i - lookbackLong);
  let sum = 0, count = 0;
  for (let j = start; j <= i; j++) {
    if (a[j] !== null) { sum += a[j]; count++; }
  }
  const avgAtr = sum / count;
  const ratio = curAtr / avgAtr;
  let regime = "normal";
  if (ratio < 0.6)      regime = "low";
  else if (ratio > 1.5) regime = "high";
  else if (ratio > 2.2) regime = "extreme";
  const bb = bollinger(closes(candles), 20, 2);
  const bbWidth = bb.upper[i] !== null ? (bb.upper[i] - bb.lower[i]) / bb.middle[i] * 100 : null;
  const details = [
    `ATR ${curAtr.toFixed(5)} (${atrPercent.toFixed(2)}% of price)`,
    `ATR/avg ratio ${ratio.toFixed(2)} → ${regime} regime`,
  ];
  if (bbWidth !== null) details.push(`BB width ${bbWidth.toFixed(2)}%`);
  return { regime, atr: curAtr, atrPercent, atrRatio: ratio, bbWidth, details };
}

/**
 * Check for volatility squeeze (Bollinger Band width inside Keltner-like ATR band).
 * Useful precursor to breakouts.
 */
export function volatilitySqueeze(candles, atrPeriod = 14, bbMult = 2.0, atrMult = 1.5) {
  const bb = bollinger(closes(candles), 20, bbMult);
  const a = atr(candles, atrPeriod);
  const i = candles.length - 1;
  if (bb.upper[i] === null || a[i] === null) return { squeezed: false, details: ["Data not ready"] };
  const bbWidth = bb.upper[i] - bb.lower[i];
  const keltnerWidth = a[i] * 2 * atrMult;
  const squeezed = bbWidth < keltnerWidth;
  return {
    squeezed,
    bbWidth,
    keltnerWidth,
    details: [squeezed ? "Volatility squeeze (BB inside Keltner)" : "No squeeze — normal/expanding volatility"],
  };
}
