#!/usr/bin/env node
/**
 * Generate clearly-labeled DEMO candle data for UI development.
 * Run: node scripts/generate-demo-data.mjs
 * This data will be replaced by real fetched data once Actions runs.
 */
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const PAIRS = [
  { symbol: "EURUSD", start: 1.08, drift: 0.00001, vol: 0.0005 },
  { symbol: "GBPUSD", start: 1.26, drift: -0.000005, vol: 0.0007 },
  { symbol: "USDJPY", start: 148.5, drift: 0.002, vol: 0.05 },
  { symbol: "USDCHF", start: 0.85, drift: 0.00001, vol: 0.0004 },
  { symbol: "AUDUSD", start: 0.66, drift: 0.000005, vol: 0.0005 },
  { symbol: "USDCAD", start: 1.35, drift: -0.00001, vol: 0.0005 },
  { symbol: "NZDUSD", start: 0.60, drift: 0.000008, vol: 0.0005 },
  { symbol: "EURGBP", start: 0.857, drift: 0.000005, vol: 0.0003 },
  { symbol: "EURJPY", start: 160.5, drift: 0.003, vol: 0.08 },
  { symbol: "GBPJPY", start: 187.0, drift: 0.002, vol: 0.10 },
];

const TIMEFRAMES = [
  { id: "D1",  bars: 300, mins: 1440 },
  { id: "H4",  bars: 400, mins: 240 },
  { id: "H1",  bars: 500, mins: 60 },
  { id: "M15", bars: 500, mins: 15 },
  { id: "M5",  bars: 500, mins: 5 },
];

function generateCandles(start, drift, vol, count, stepMin) {
  const candles = [];
  let price = start;
  const now = Math.floor(Date.now() / 1000);
  const startTime = now - count * stepMin * 60;
  for (let i = 0; i < count; i++) {
    const time = startTime + i * stepMin * 60;
    // Add some trending + mean-reversion + randomness
    const cycle = Math.sin(i / 20) * vol * 3;
    const noise = (Math.random() - 0.5) * vol;
    const driftComp = drift * i;
    const open = price;
    const close = open + drift + cycle * 0.1 + noise;
    const high = Math.max(open, close) + Math.random() * vol * 0.7;
    const low = Math.min(open, close) - Math.random() * vol * 0.7;
    candles.push({
      time, open: +open.toFixed(6), high: +high.toFixed(6), low: +low.toFixed(6), close: +close.toFixed(6), volume: 0,
    });
    price = close;
  }
  return candles;
}

const outDir = join(ROOT, "data/prices");
mkdirSync(outDir, { recursive: true });

for (const pair of PAIRS) {
  for (const tf of TIMEFRAMES) {
    // Scale drift/vol per timeframe
    const scale = Math.sqrt(tf.mins / 60);
    const candles = generateCandles(pair.start, pair.drift * scale, pair.vol * scale, tf.bars, tf.mins);
    const payload = {
      meta: {
        pair: pair.symbol, timeframe: tf.id,
        lastUpdated: new Date().toISOString(),
        provider: "synthetic",
        providersAttempted: ["synthetic"],
        quality: 1.0,
        count: candles.length,
        issues: ["DEMO DATA — generated synthetically for UI development"],
        isDemoData: true,
        strategyVersion: "1.0.0",
      },
      candles,
    };
    writeFileSync(join(outDir, `${pair.symbol}-${tf.id}.json`), JSON.stringify(payload));
    console.log(`  wrote ${pair.symbol}-${tf.id}.json (${candles.length} candles)`);
  }
}
console.log("\n✓ Demo data generated.");
