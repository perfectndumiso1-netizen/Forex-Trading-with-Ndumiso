import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCandles } from "../validation.js";

test("validateCandles normalizes Twelve Data format", () => {
  const raw = [
    { datetime: "2024-01-01 00:00:00", open: "1.08", high: "1.09", low: "1.07", close: "1.085", volume: "1000" },
    { datetime: "2024-01-01 01:00:00", open: "1.085", high: "1.095", low: "1.08", close: "1.09", volume: "1200" },
  ];
  const result = validateCandles(raw, "twelvedata", { pair: "EURUSD", timeframe: "H1", expectedCount: 2 });
  assert.equal(result.candles.length, 2);
  assert.equal(typeof result.candles[0].time, "number");
  assert.equal(typeof result.candles[0].close, "number");
  assert.equal(result.candles[0].close, 1.085);
  assert.ok(result.quality > 0.5);
});

test("validateCandles returns 0 quality for empty input", () => {
  const result = validateCandles([], "twelvedata");
  assert.equal(result.candles.length, 0);
  assert.equal(result.quality, 0);
});

test("validateCandles rejects invalid OHLC", () => {
  const raw = [
    { datetime: "2024-01-01", open: 1.08, high: 1.07, low: 1.09, close: 1.085 }, // high < low, bad OHLC
  ];
  const result = validateCandles(raw, "twelvedata");
  assert.ok(result.issues.length > 0 || result.candles.length === 0);
});

test("validateCandles records provider provenance", () => {
  const raw = [
    { datetime: "2024-01-01", open: 1.08, high: 1.09, low: 1.07, close: 1.085 },
  ];
  const result = validateCandles(raw, "yahoo", { pair: "EURUSD", timeframe: "H1" });
  assert.equal(result.provider, "yahoo");
  assert.ok(result.meta.pair === "EURUSD");
});
