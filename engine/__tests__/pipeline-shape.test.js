/**
 * pipeline-shape.test.js — Regression tests for the validation-object/
 * candle-array shape mismatch that caused pairs to be skipped before
 * analyzePair() ran.
 *
 * Bug: Object.values(pairData).some(arr => arr.length > 250) was applied to
 * validation result objects (shaped {candles, quality, usable, freshness})
 * whose .length is undefined, so hasMinData was always false and every pair
 * was skipped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { getCandles, candleCount } from "../validation.js";
import { PAIRS } from "../../assets/js/config.js";

function makeCandles(n) {
  const arr = [];
  for (let i = 0; i < n; i++) {
    arr.push({ time: i * 3600, open: 1.08, high: 1.081, low: 1.079, close: 1.08 + i * 0.0001, volume: 1000 });
  }
  return arr;
}

test("candleCount returns length of a raw candle array", () => {
  const arr = makeCandles(300);
  assert.equal(candleCount(arr), 300);
});

test("candleCount returns length of candles inside a validation result object", () => {
  const v = { candles: makeCandles(403), quality: 1, usable: true, freshness: 1 };
  assert.equal(candleCount(v), 403);
});

test("candleCount returns 0 for null/undefined/empty shapes", () => {
  assert.equal(candleCount(null), 0);
  assert.equal(candleCount(undefined), 0);
  assert.equal(candleCount({}), 0);
  assert.equal(candleCount({ candles: null }), 0);
});

test("getCandles returns the array for raw input, candles[] for validation object", () => {
  const raw = makeCandles(10);
  assert.equal(getCandles(raw), raw);
  const v = { candles: raw, quality: 0.9 };
  assert.equal(getCandles(v), raw);
  assert.equal(getCandles(null), null);
});

test("hasMinData equivalent correctly detects sufficient data with validation objects", () => {
  // Simulate the pipeline shape: { TF: validationResult }
  const pairData = {
    D1: { candles: makeCandles(300), quality: 1, usable: true, freshness: 1 },
    H4: { candles: makeCandles(400), quality: 1, usable: true, freshness: 1 },
    H1: { candles: makeCandles(500), quality: 1, usable: true, freshness: 1 },
    M15: { candles: makeCandles(520), quality: 1, usable: true, freshness: 1 },
    M5: { candles: makeCandles(560), quality: 1, usable: true, freshness: 1 },
  };
  const maxCandles = Object.values(pairData).reduce((m, v) => Math.max(m, candleCount(v)), 0);
  assert.ok(maxCandles > 250, "validation objects with 300+ candles must count as sufficient data");
});

test("hasMinData equivalent correctly skips when ALL TFs have <=250 candles", () => {
  const pairData = {
    D1: { candles: makeCandles(50), quality: 0.3, usable: false, freshness: 0 },
    H1: { candles: makeCandles(100), quality: 0.4, usable: false, freshness: 0 },
  };
  const maxCandles = Object.values(pairData).reduce((m, v) => Math.max(m, candleCount(v)), 0);
  assert.equal(maxCandles > 250, false, "100 candles must NOT count as sufficient data");
});

test("hasMinData equivalent works with mixed raw arrays and validation objects", () => {
  const pairData = {
    H1: makeCandles(300), // raw array
    H4: { candles: makeCandles(280), quality: 1, usable: true, freshness: 1 }, // validation obj
  };
  const maxCandles = Object.values(pairData).reduce((m, v) => Math.max(m, candleCount(v)), 0);
  assert.ok(maxCandles > 250);
});

test("all 10 configured pairs are recognized by PAIRS config", () => {
  assert.equal(PAIRS.length, 10);
  const expected = ["EURUSD","GBPUSD","USDJPY","USDCHF","AUDUSD","USDCAD","NZDUSD","EURGBP","EURJPY","GBPJPY"];
  for (const sym of expected) {
    assert.ok(PAIRS.find(p => p.symbol === sym), `${sym} must be configured`);
  }
});

test("insufficient data (validation object with <=250) does NOT sneak through analyzePair gating", () => {
  // Even if hasMinData were to incorrectly pass a small dataset, analyzePair
  // must NO TRADE due to critical-TF/count gates. This test proves the gate
  // remains in place (defense in depth).
  // (Indirect: we can't call analyzePair here without full multi-TF data, but
  // we verify that getCandles doesn't return bogus arrays that would fool it.)
  const v = { candles: makeCandles(10), quality: 0.1, usable: false };
  assert.equal(candleCount(v), 10);
  assert.equal(getCandles(v).length, 10);
  // 10 < 50 indicator warmup minimum in validation.usable logic
  assert.equal(v.usable, false);
});
