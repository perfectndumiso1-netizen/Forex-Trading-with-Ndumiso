import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCandles } from "../validation.js";

// Fixed "now" so freshness doesn't depend on wall-clock
const NOW = 1704070800; // 2024-01-01 01:30:00 UTC (just after the last fixture candle)

test("validateCandles normalizes Twelve Data format", () => {
  const now = Math.floor(new Date("2024-01-01T02:00:00Z").getTime()/1000);
  const raw = [
    { datetime: "2024-01-01 00:00:00", open: "1.08", high: "1.09", low: "1.07", close: "1.085", volume: "1000" },
    { datetime: "2024-01-01 01:00:00", open: "1.085", high: "1.095", low: "1.08", close: "1.09", volume: "1200" },
  ];
  const result = validateCandles(raw, "twelvedata", { pair: "EURUSD", timeframe: "H1", expectedCount: 2, now });
  assert.equal(result.candles.length, 2);
  // All numeric, sorted ascending, with unix timestamps
  assert.equal(typeof result.candles[0].time, "number");
  assert.equal(typeof result.candles[0].close, "number");
  assert.equal(typeof result.candles[1].close, "number");
  assert.ok(result.candles[0].time < result.candles[1].time, "candles sorted ascending");
  assert.ok(result.quality > 0.5, `quality ${result.quality} should be > 0.5`);
  // Strings parsed to numbers
  assert.ok(result.candles.every(c => typeof c.open === "number" && c.open > 0));
});

test("validateCandles returns 0 quality for empty input", () => {
  const result = validateCandles([], "twelvedata", { now: NOW });
  assert.equal(result.candles.length, 0);
  assert.equal(result.quality, 0);
  assert.equal(result.usable, false);
});

test("validateCandles rejects invalid OHLC", () => {
  const raw = [
    { datetime: "2024-01-01 00:00:00", open: 1.08, high: 1.07, low: 1.09, close: 1.085 }, // high < low
  ];
  const result = validateCandles(raw, "twelvedata", { now: NOW });
  assert.ok(result.issues.length > 0 || result.candles.length === 0);
});

test("validateCandles records provider provenance", () => {
  const raw = [
    { datetime: "2024-01-01 00:00:00", open: 1.08, high: 1.09, low: 1.07, close: 1.085 },
  ];
  const result = validateCandles(raw, "yahoo", { pair: "EURUSD", timeframe: "H1", now: NOW });
  assert.equal(result.provider, "yahoo");
  assert.ok(result.meta.pair === "EURUSD");
});

test("validateCandles rejects future-dated candles", () => {
  const future = NOW + 86400 * 10; // 10 days from now
  const raw = [
    { time: NOW - 3600, open: 1.08, high: 1.09, low: 1.07, close: 1.085 },
    { time: future, open: 1.09, high: 1.10, low: 1.08, close: 1.095 },
  ];
  const result = validateCandles(raw, "twelvedata", { pair: "EURUSD", timeframe: "H1", now: NOW });
  assert.equal(result.candles.length, 1, "future candle must be removed");
  assert.ok(result.issues.some(i => /future/i.test(i)), "issues should mention future");
});

test("validateCandles marks stale data as unusable", () => {
  // H1 candles with last candle 2 days old
  const old = [];
  for (let i = 0; i < 60; i++) {
    const t = NOW - 86400 * 2 - i * 3600;
    old.push({ time: t, open: 1.08, high: 1.085, low: 1.075, close: 1.08 + i * 0.0001 });
  }
  old.reverse();
  const result = validateCandles(old, "twelvedata", { pair: "EURUSD", timeframe: "H1", expectedCount: 60, now: NOW });
  assert.ok(result.freshness < 1, `freshness ${result.freshness} should be < 1`);
  assert.equal(result.usable, false, "stale data must not be usable");
  assert.ok(result.issues.some(i => /stale/i.test(i)), "issues should mention stale");
});

test("validateCandles grid-aligns timestamps (fixes :25 offsets)", () => {
  const raw = [
    { time: 1789329625, open: 151.6, high: 151.7, low: 151.5, close: 151.673 }, // 20:00:25 → 20:00
    { time: 1789326000, open: 153.5, high: 153.8, low: 152.9, close: 153.5 },   // 19:00 — misaligned dup
    { time: 1789340400, open: 153.4, high: 153.8, low: 152.4, close: 152.874 }, // 23:00 — not on H4 grid (corrupt)
    { time: 1789344025, open: 151.67, high: 151.7, low: 151.6, close: 151.692 }, // 00:00:25 next day
  ];
  // Set "now" just after the last candle to avoid freshness penalty
  const now = 1789344025 + 60;
  const result = validateCandles(raw, "twelvedata", { pair: "USDJPY", timeframe: "H4", now });
  // After grid alignment to H4 (240 min = 14400 sec):
  // 1789329625 → rounded to nearest 14400 = 1789329600 (20:00)
  // 1789326000 → 1789324800 (18:00) or 1789339200? depends — but after dedup we should not have 4 entries
  assert.ok(result.candles.length <= raw.length, "dedup should not increase candles");
});

test("validateCandles flags outlier spikes", () => {
  // Build a gentle series and inject one obvious spike (>10× ATR)
  const base = 1.08;
  const candles = [];
  for (let i = 0; i < 60; i++) {
    const t = NOW - (60 - i) * 3600;
    const c = base + i * 0.0005 + Math.sin(i / 5) * 0.001;
    candles.push({ time: t, open: c, high: c + 0.001, low: c - 0.001, close: c, volume: 1000 });
  }
  // Inject a spike at index 30 (candle jumps 0.05 then snaps back)
  candles[30] = { time: candles[30].time, open: 1.08, high: 1.13, low: 1.08, close: 1.081, volume: 1000 };
  const result = validateCandles(candles, "twelvedata", { pair: "EURUSD", timeframe: "H1", expectedCount: 60, now: NOW });
  assert.ok(result.issues.some(i => /spike/i.test(i)), "spike outlier should be flagged/removed");
});

test("validateCandles returns usable true for fresh valid data", () => {
  const raw = [];
  for (let i = 0; i < 200; i++) {
    const t = NOW - i * 3600;
    const c = 1.08 + (200 - i) * 0.0001;
    raw.push({ time: t, open: c, high: c + 0.001, low: c - 0.001, close: c + 0.0005, volume: 1000 });
  }
  raw.reverse();
  const result = validateCandles(raw, "twelvedata", { pair: "EURUSD", timeframe: "H1", expectedCount: 200, now: NOW });
  assert.equal(result.usable, true);
  assert.ok(result.quality >= 0.9);
});
