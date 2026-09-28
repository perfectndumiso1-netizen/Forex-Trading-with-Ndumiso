import { test } from "node:test";
import assert from "node:assert/strict";
import { swingHighs, swingLows, supportResistance, trendStructure, maAlignment } from "../structure.js";

function candle(i, o, h, l, c) {
  return { time: i * 3600, open: o, high: h, low: l, close: c, volume: 0 };
}

test("swingHighs detects local peaks", () => {
  // Create a clear peak at index 5: ... 1.09, 1.10, 1.12(peak), 1.10, 1.09 ...
  const prices = [1.08, 1.09, 1.10, 1.11, 1.115, 1.12, 1.115, 1.11, 1.10, 1.09, 1.08, 1.07, 1.06, 1.05, 1.04];
  const candles = prices.map((p, i) => candle(i, p, p + 0.001, p - 0.001, p));
  // Adjust candles[5] to be clearly the highest
  candles[5] = candle(5, 1.115, 1.125, 1.115, 1.12);
  const sh = swingHighs(candles, 3);
  const peaks = sh.map((p, i) => p ? i : -1).filter(i => i >= 0);
  assert.ok(peaks.includes(5), `Should find swing high at index 5; peaks found at ${peaks}`);
});

test("swingLows detects local troughs", () => {
  const prices = [1.08, 1.07, 1.06, 1.05, 1.04, 1.03, 1.04, 1.05, 1.06, 1.07, 1.08, 1.09, 1.10];
  const candles = prices.map((p, i) => candle(i, p, p + 0.001, p - 0.001, p));
  candles[5] = candle(5, 1.04, 1.041, 1.028, 1.03);
  const sl = swingLows(candles, 3);
  const troughs = sl.map((p, i) => p ? i : -1).filter(i => i >= 0);
  assert.ok(troughs.includes(5), `Should find swing low at index 5; troughs at ${troughs}`);
});

test("trendStructure detects uptrend via HH/HL", () => {
  // Build a clean stair-step uptrend: each swing high is higher than the last,
  // each swing low (pullback) is higher than the previous low.
  // Pattern: 4 bars up, 2 bars pullback (to higher low), repeat.
  const candles = [];
  let price = 1.05;
  const lookback = 2;
  for (let cycle = 0; cycle < 12; cycle++) {
    const baseLow = price;
    // Up leg (4 bars rising)
    for (let j = 0; j < 4; j++) {
      const o = price, c = price + 0.004;
      candles.push({
        time: candles.length * 3600,
        open: o, high: c + 0.001, low: o - 0.0005, close: c, volume: 0,
      });
      price = c;
    }
    const swingHigh = price;
    // Pullback (2 bars down, but not below previous baseLow)
    for (let j = 0; j < 2; j++) {
      const o = price, c = price - 0.002;
      candles.push({
        time: candles.length * 3600,
        open: o, high: o + 0.0005, low: Math.max(c - 0.001, baseLow + 0.001), close: c, volume: 0,
      });
      price = c;
    }
  }
  const t = trendStructure(candles, lookback, 8);
  assert.equal(t.direction, "UP", `Expected UP trend, got ${t.direction} (${t.details})`);
});

test("maAlignment detects bullish stack", () => {
  // Mock aligned EMAs/SMAs: fast > slow > trend > long
  const n = 250;
  const emaFast = new Array(n).fill(null).map((_, i) => i < 8 ? null : 1.10 + i * 0.0005);
  const emaSlow = new Array(n).fill(null).map((_, i) => i < 20 ? null : 1.09 + i * 0.0005);
  const smaTrend = new Array(n).fill(null).map((_, i) => i < 49 ? null : 1.08 + i * 0.0005);
  const smaLong  = new Array(n).fill(null).map((_, i) => i < 199 ? null : 1.07 + i * 0.0005);
  const result = maAlignment(emaFast, emaSlow, smaTrend, smaLong);
  assert.equal(result.alignment, "BULL", `Expected BULL, got ${result.alignment}: ${result.details}`);
});

test("supportResistance returns zones with touch counts", () => {
  const prices = [1.08, 1.09, 1.10, 1.09, 1.08, 1.09, 1.10, 1.11, 1.10, 1.09, 1.08, 1.09, 1.10, 1.11, 1.12, 1.11, 1.10, 1.09, 1.08, 1.09];
  const candles = prices.map((p, i) => candle(i, p, p + 0.002, p - 0.002, p));
  const zones = supportResistance(candles, 2, 0.005, 2);
  assert.ok(Array.isArray(zones));
  assert.ok(zones.length > 0, "Should detect at least one S/R zone");
});
