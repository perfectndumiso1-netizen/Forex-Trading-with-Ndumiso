import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzePair, isDuplicate } from "../signals.js";

// Generate multi-timeframe synthetic data where higher TFs trend up
// and lower TFs show bullish momentum
function generateUptrendData(barsD1 = 250, barsH4 = 1000, barsH1 = 4000, barsM15 = 8000) {
  const mk = (n, drift, vol) => {
    const candles = [];
    let price = 1.0800;
    for (let i = 0; i < n; i++) {
      const open = price;
      const noise = (Math.sin(i * 0.1) + (Math.random() - 0.5)) * vol;
      const close = open + drift + noise;
      const high = Math.max(open, close) + vol * 0.5;
      const low = Math.min(open, close) - vol * 0.5;
      candles.push({ time: i, open, high, low, close, volume: 0 });
      price = close;
    }
    return candles;
  };
  return {
    D1:  mk(barsD1,  0.0008, 0.003),
    H4:  mk(barsH4,  0.0002, 0.0015),
    H1:  mk(barsH1,  0.00005, 0.0008),
    M15: mk(barsM15, 0.000012, 0.0004),
  };
}

test("analyzePair returns a valid signal object structure (NO TRADE is acceptable)", () => {
  const data = generateUptrendData();
  const pair = { symbol: "EURUSD", pipSize: 0.0001 };
  const result = analyzePair(data, pair);
  assert.ok(["BUY", "SELL", "NO TRADE"].includes(result.signal),
    `Signal must be BUY/SELL/NO TRADE, got ${result.signal}`);
  assert.ok(typeof result.strength === "number");
  assert.ok(result.strength >= 0 && result.strength <= 100);
  assert.ok(result.strategyVersion, "Must include strategy version");
  assert.ok(Array.isArray(result.reasons));
  assert.ok(result.timestamp);
  assert.ok(result.pair === "EURUSD");
});

test("analyzePair includes dataQuality field", () => {
  const data = generateUptrendData();
  const pair = { symbol: "EURUSD", pipSize: 0.0001 };
  const result = analyzePair(data, pair);
  assert.ok(typeof result.dataQuality === "number");
  assert.ok(result.dataQuality >= 0 && result.dataQuality <= 100);
});

test("analyzePair with insufficient data returns NO TRADE, never crashes", () => {
  const tinyData = {
    D1: Array.from({ length: 10 }, (_, i) => ({ time: i, open: 1.1, high: 1.11, low: 1.09, close: 1.1 + i * 0.001, volume: 0 })),
    H4: Array.from({ length: 10 }, (_, i) => ({ time: i, open: 1.1, high: 1.11, low: 1.09, close: 1.1 + i * 0.001, volume: 0 })),
    H1: Array.from({ length: 10 }, (_, i) => ({ time: i, open: 1.1, high: 1.11, low: 1.09, close: 1.1 + i * 0.001, volume: 0 })),
  };
  const pair = { symbol: "EURUSD", pipSize: 0.0001 };
  const result = analyzePair(tinyData, pair);
  assert.equal(result.signal, "NO TRADE", "Should return NO TRADE on tiny dataset");
});

test("isDuplicate detects same-pair same-direction signal within cooldown", () => {
  const now = new Date().toISOString();
  const existing = [{
    pair: "EURUSD", signal: "BUY", entry: 1.0850, entryTF: "H1", atr: 0.001,
    status: "ACTIVE", timestamp: now,
  }];
  const candidate = {
    pair: "EURUSD", signal: "BUY", entry: 1.0852, entryTF: "H1", atr: 0.001,
    timestamp: new Date(Date.now() + 3600 * 1000).toISOString(),
  };
  assert.ok(isDuplicate(candidate, existing, 4), "Should detect duplicate");
});

test("isDuplicate allows different-direction signals", () => {
  const now = new Date().toISOString();
  const existing = [{
    pair: "EURUSD", signal: "BUY", entry: 1.0850, entryTF: "H1", atr: 0.001,
    status: "ACTIVE", timestamp: now,
  }];
  const candidate = {
    pair: "EURUSD", signal: "SELL", entry: 1.0850, entryTF: "H1", atr: 0.001,
    timestamp: new Date(Date.now() + 3600 * 1000).toISOString(),
  };
  assert.ok(!isDuplicate(candidate, existing, 4), "Opposite direction should not be duplicate");
});
