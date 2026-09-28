import { test } from "node:test";
import assert from "node:assert/strict";
import { sma, ema, rsi, macd, atr, bollinger } from "../indicators.js";

// Generate synthetic trending data for testing
function generateTrendCandles(n, start = 1.1000, drift = 0.0001, vol = 0.0003) {
  const candles = [];
  let price = start;
  for (let i = 0; i < n; i++) {
    const open = price;
    const noise = (Math.random() - 0.5) * vol;
    const close = open + drift + noise;
    const high = Math.max(open, close) + Math.random() * vol * 0.5;
    const low = Math.min(open, close) - Math.random() * vol * 0.5;
    candles.push({ time: i * 3600, open, high, low, close, volume: 0 });
    price = close;
  }
  return candles;
}

function closesOf(candles) { return candles.map(c => c.close); }

test("SMA calculates correctly on a simple series", () => {
  const vals = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const s = sma(vals, 3);
  assert.equal(s[2], 2);   // (1+2+3)/3
  assert.equal(s[3], 3);   // (2+3+4)/3
  assert.equal(s[9], 9);   // (8+9+10)/3
  assert.equal(s[0], null);
  assert.equal(s[1], null);
});

test("EMA responds faster than SMA to price changes", () => {
  const c = generateTrendCandles(100);
  const closes = closesOf(c);
  const e = ema(closes, 20);
  const s = sma(closes, 20);
  // In an uptrend EMA should be above SMA (faster to react)
  assert.ok(e[99] > s[99], "EMA should be above SMA in uptrend");
});

test("RSI ranges 0-100", () => {
  const c = generateTrendCandles(200, 1.1000, 0.0002, 0.0005);
  const r = rsi(closesOf(c), 14);
  const last = r.at(-1);
  assert.ok(last >= 0 && last <= 100, `RSI ${last} out of range`);
});

test("RSI hits high values in strong uptrend", () => {
  const c = generateTrendCandles(200, 1.1000, 0.0005, 0.0001);
  const r = rsi(closesOf(c), 14);
  const recent = r.slice(-30).filter(v => v !== null);
  assert.ok(recent.some(v => v > 60), "RSI should reach above 60 in strong uptrend");
});

test("MACD returns all three lines with correct length", () => {
  const c = generateTrendCandles(200);
  const m = macd(closesOf(c), 12, 26, 9);
  assert.equal(m.macdLine.length, 200);
  assert.equal(m.signalLine.length, 200);
  assert.equal(m.histogram.length, 200);
  assert.ok(m.macdLine.at(-1) !== null);
  assert.ok(m.signalLine.at(-1) !== null);
});

test("ATR is always positive", () => {
  const c = generateTrendCandles(100);
  const a = atr(c, 14);
  assert.ok(a.at(-1) > 0, `ATR should be positive, got ${a.at(-1)}`);
});

test("Bollinger Bands: upper > middle > lower", () => {
  const c = generateTrendCandles(100);
  const bb = bollinger(closesOf(c), 20, 2);
  assert.ok(bb.upper.at(-1) > bb.middle.at(-1));
  assert.ok(bb.middle.at(-1) > bb.lower.at(-1));
});
