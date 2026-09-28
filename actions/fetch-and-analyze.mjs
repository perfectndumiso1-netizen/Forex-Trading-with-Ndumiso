#!/usr/bin/env node
/**
 * fetch-and-analyze.mjs — GitHub Actions entry point.
 *
 * Pipeline (as specified in architecture correction C & D):
 *   1. Fetch candles from primary provider (Twelve Data)
 *   2. Validate + normalize (recording provider, timestamp, quality)
 *   3. Fall back to secondary provider on failure, with provenance
 *   4. Persist to data/prices/{PAIR}-{TF}.json
 *   5. Run signal engine
 *   6. Append new signals (never overwrite historical ones)
 *   7. Save results
 *
 * No API keys are ever sent to or stored in the browser.
 * Reads TWELVEDATA_API_KEY from env (set as GitHub Actions secret).
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ── Dynamic imports from the engine (ESM) ───────────────────────────────────
// We need to import config and engine modules. Since this is an .mjs file in
// /actions, we resolve relative to the repo root.
const configPath = join(ROOT, "assets/js/config.js");
const enginePath = join(ROOT, "engine/signals.js");
const validationPath = join(ROOT, "engine/validation.js");
const { PAIRS, TIMEFRAMES, DATA_PARAMS, STRATEGY_VERSION } = await import(configPath);
const { analyzePair, isDuplicate } = await import(enginePath);
const { validateCandles } = await import(validationPath);

// ── CLI flags ───────────────────────────────────────────────────────────────
const DRY_RUN = process.argv.includes("--dry-run");
const VERBOSE = process.argv.includes("--verbose");
const log = (...args) => VERBOSE && console.log(...args);

// ── Fetch implementation ────────────────────────────────────────────────────
async function fetchTwelveData(symbol, interval, apiKey, outputSize = 200) {
  // Twelve Data interval mapping
  const intervalMap = { M5: "5min", M15: "15min", H1: "1h", H4: "4h", D1: "1day" };
  const tdInterval = intervalMap[interval];
  if (!tdInterval) throw new Error(`Unsupported TF for Twelve Data: ${interval}`);
  // Twelve Data uses symbol format like EUR/USD
  const tdSymbol = symbol.slice(0, 3) + "/" + symbol.slice(3);
  const url = `https://api.twelvedata.com/time_series?symbol=${tdSymbol}&interval=${tdInterval}&outputsize=${outputSize}&apikey=${apiKey}`;
  const resp = await fetch(url);
  const json = await resp.json();
  if (json.status === "error") throw new Error(`Twelve Data error: ${json.message}`);
  if (!json.values) throw new Error("Twelve Data returned no values");
  // Twelve Data returns newest-first; reverse to oldest-first
  return json.values.map(v => ({
    datetime: v.datetime,
    open: v.open, high: v.high, low: v.low, close: v.close, volume: v.volume,
  })).reverse();
}

async function fetchYahoo(symbol, interval, outputSize = 200) {
  // Yahoo Finance via the public query1 API (no key needed).
  const intervalMap = { M5: "5m", M15: "15m", H1: "1h", H4: "4h", D1: "1d" };
  const yInterval = intervalMap[interval];
  if (!yInterval) throw new Error(`Unsupported TF for Yahoo: ${interval}`);
  const yahooSymbol = `${symbol}=X`;
  const rangeMap = { M5: "5d", M15: "10d", H1: "30d", H4: "60d", D1: "730d" };
  const range = rangeMap[interval];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?interval=${yInterval}&range=${range}`;
  const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const json = await resp.json();
  const result = json.chart?.result?.[0];
  if (!result) throw new Error("Yahoo returned no result");
  const { timestamp, indicators } = result;
  const q = indicators.quote[0];
  const candles = [];
  for (let i = 0; i < timestamp.length; i++) {
    if (q.open[i] == null || q.close[i] == null) continue;
    candles.push({
      time: timestamp[i],
      open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0,
    });
  }
  return candles;
}

// ── Fetch with fallback & provenance ────────────────────────────────────────
async function fetchCandles(symbol, tf, expectedCount) {
  const apiKey = process.env.TWELVEDATA_API_KEY;
  const providers = [];
  const fetchedAt = new Date().toISOString();
  let rawCandles = null;
  let providerUsed = null;
  let issues = [];

  // Primary: Twelve Data (if key available)
  if (apiKey) {
    providers.push("twelvedata");
    try {
      rawCandles = await fetchTwelveData(symbol, tf, apiKey, expectedCount);
      providerUsed = "twelvedata";
    } catch (e) {
      issues.push(`Twelve Data failed: ${e.message}`);
      log(`[${symbol}/${tf}] Twelve Data failed: ${e.message}`);
    }
  }

  // Backup: Yahoo
  if (!rawCandles) {
    providers.push("yahoo");
    try {
      rawCandles = await fetchYahoo(symbol, tf, expectedCount);
      providerUsed = "yahoo";
    } catch (e) {
      issues.push(`Yahoo failed: ${e.message}`);
      log(`[${symbol}/${tf}] Yahoo failed: ${e.message}`);
    }
  }

  if (!rawCandles) {
    return { candles: [], quality: 0, provider: null, issues, meta: { pair: symbol, timeframe: tf, fetchedAt } };
  }

  const validated = validateCandles(rawCandles, providerUsed, {
    pair: symbol, timeframe: tf, expectedCount, fetchedAt,
    now: Math.floor(Date.now() / 1000),
  });
  validated.issues.push(...issues);
  validated.providersAttempted = providers;
  return validated;
}

// ── Merge new candles with existing file ────────────────────────────────────
function mergeCandles(existing, newCandles, maxCandles) {
  const byTime = new Map();
  for (const c of existing) byTime.set(c.time, c);
  for (const c of newCandles) byTime.set(c.time, c); // overwrite with fresh data
  const merged = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
  if (merged.length > maxCandles) return merged.slice(-maxCandles);
  return merged;
}

// ── Read/write helpers ──────────────────────────────────────────────────────
function readJSON(path, fallback) {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) { /* fall through */ }
  return fallback;
}
function writeJSON(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║   Forex Signal Engine — Data Fetch & Analyze  ║`);
  console.log(`║   Strategy version: ${STRATEGY_VERSION.padEnd(23)}║`);
  console.log(`╚══════════════════════════════════════════════╝\n`);

  const pricesDir = join(ROOT, "data/prices");
  const signalsFile = join(ROOT, "data/signals/signals.json");
  const outputSize = 200;

  const allData = {}; // { PAIR: { TF: [candles] } }
  const validationMeta = {}; // { PAIR: { TF: validationResult } }

  // ── Step 1: Fetch all pairs & timeframes ────────────────────────────────
  for (const pair of PAIRS) {
    allData[pair.symbol] = {};
    validationMeta[pair.symbol] = {};
    for (const tf of TIMEFRAMES) {
      const file = join(pricesDir, `${pair.symbol}-${tf.id}.json`);
      const existing = readJSON(file, { candles: [] }).candles || [];
      log(`Fetching ${pair.symbol} ${tf.id}...`);
      const result = await fetchCandles(pair.symbol, tf.id, outputSize);
      validationMeta[pair.symbol][tf.id] = result;
      if (result.candles.length === 0) {
        console.warn(`  ⚠ ${pair.symbol}/${tf.id}: no data — ${result.issues.join("; ")}`);
        // Use existing data if available so engine can still run, BUT mark as
        // not usable (we construct a validation object that is usable=false
        // so analyzePair will reject it).
        allData[pair.symbol][tf.id] = existing;
        if (existing.length === 0) {
          validationMeta[pair.symbol][tf.id] = { candles: [], quality: 0, usable: false, freshness: 0, issues: result.issues, meta: {pair:pair.symbol,timeframe:tf.id} };
        } else {
          validationMeta[pair.symbol][tf.id] = { candles: existing, quality: 0.5, usable: false, freshness: 0, issues: [...result.issues, "using stale existing data"], meta: {pair:pair.symbol,timeframe:tf.id} };
        }
        continue;
      }
      const merged = mergeCandles(existing, result.candles, DATA_PARAMS.maxCandlesPerFile);
      allData[pair.symbol][tf.id] = merged;
      // Build a combined validation result: usable only if freshness/quality OK
      const combinedValidation = {
        ...result,
        candles: merged,
        meta: { ...result.meta, count: merged.length },
      };
      validationMeta[pair.symbol][tf.id] = combinedValidation;
      if (!DRY_RUN) {
        writeJSON(file, {
          meta: {
            pair: pair.symbol, timeframe: tf.id,
            lastUpdated: new Date().toISOString(),
            provider: result.provider,
            providersAttempted: result.providersAttempted,
            quality: result.quality,
            freshness: result.freshness,
            usable: result.usable,
            count: merged.length,
            issues: result.issues,
            strategyVersion: STRATEGY_VERSION,
          },
          candles: merged,
        });
      }
      const status = result.usable ? "✓" : "⚠";
      console.log(`  ${status} ${pair.symbol}/${tf.id}: ${result.candles.length} new, ${merged.length} total, provider=${result.provider}, quality=${(result.quality*100).toFixed(0)}%, fresh=${(result.freshness*100).toFixed(0)}%, usable=${result.usable}`);
      // Respect Twelve Data rate limit (8 req/min free) — brief pause
      if (result.provider === "twelvedata") await new Promise(r => setTimeout(r, 7500 + Math.random() * 500));
    }
  }

  // Build engine input using validation results (not raw merged arrays) so
  // that analyzePair sees usable/freshness/quality metadata per TF.
  const engineInput = {};
  for (const pair of PAIRS) {
    engineInput[pair.symbol] = {};
    for (const tf of TIMEFRAMES) {
      const v = validationMeta[pair.symbol][tf.id];
      engineInput[pair.symbol][tf.id] = v || allData[pair.symbol][tf.id];
    }
  }

  // ── Step 2: Run signal engine on each pair ──────────────────────────────
  const signalsData = readJSON(signalsFile, { meta: {}, signals: [] });
  // Strip any legacy demo/mock signals from the dataset. Demo signals must
  // never be treated as live. We drop them instead of displaying them as
  // "active" — the dashboard already handles "no active signals" correctly.
  const existingSignals = (signalsData.signals || []).filter(s => {
    if (s.provider === "demo" || s.id?.startsWith("demo-")) return false;
    if (s._note && /demo|mock/i.test(s._note)) return false;
    return true;
  });
  let newCount = 0;
  for (const pair of PAIRS) {
    const pairData = engineInput[pair.symbol];
    // Skip pairs with insufficient data
    const hasMinData = Object.values(pairData).some(arr => arr.length > 250);
    if (!hasMinData) {
      console.log(`  ⊘ ${pair.symbol}: insufficient data, skipping signal analysis`);
      continue;
    }
    try {
      const result = analyzePair(pairData, pair);
      log(`  ${pair.symbol}: ${result.signal} (strength ${result.strength}, quality ${result.dataQuality}%)`);
      if (result.signal === "NO TRADE") continue;
      // Hard data-integrity gate: never emit a signal with suspicious SL/ATR.
      if (result.atr && result.entry && result.stopLoss) {
        const pipsRisk = Math.abs(result.entry - result.stopLoss) / (pair.pipSize || 0.0001);
        if (pipsRisk < 5 || pipsRisk > 500) {
          console.log(`  ⊘ ${pair.symbol}: rejecting signal — stop distance ${pipsRisk.toFixed(1)} pips outside sane range`);
          continue;
        }
      }
      // Deduplicate against existing active signals
      if (isDuplicate(result, existingSignals, 4)) {
        log(`  ${pair.symbol}: duplicate signal, skipping`);
        continue;
      }
      result.id = `sig-${result.timestamp.slice(0, 10)}-${newCount.toString().padStart(3, "0")}-${pair.symbol}`;
      result.status = "ACTIVE";
      result.closedAt = null;
      result.pipsResult = null;
      result.provider = "engine"; // explicit: not demo, not mock
      existingSignals.push(result);
      newCount++;
      const d = pair.symbol.includes("JPY") ? 3 : 5;
      console.log(`  🚩 ${pair.symbol} ${result.signal} @ ${result.entry.toFixed(d)} | SL=${result.stopLoss.toFixed(d)} | TP=${result.takeProfit.toFixed(d)} | R:R=${result.riskReward.toFixed(2)} | strength=${result.strength} | quality=${result.dataQuality}%`);
    } catch (e) {
      console.error(`  ✗ ${pair.symbol}: analysis error: ${e.message}`);
      if (VERBOSE) console.error(e.stack);
    }
  }

  // ── Step 3: Save signals file ───────────────────────────────────────────
  signalsData.signals = existingSignals;
  signalsData.meta = {
    ...signalsData.meta,
    description: "Live signal output from engine v" + STRATEGY_VERSION + ". Generated from validated market data. Demo/mock signals are excluded.",
    lastUpdated: new Date().toISOString(),
    strategyVersion: STRATEGY_VERSION,
    totalSignals: existingSignals.length,
    newSignalsThisRun: newCount,
    activeSignals: existingSignals.filter(s => s.status === "ACTIVE").length,
    isMockData: false,
    containsDemoSignals: false,
  };
  if (!DRY_RUN) {
    writeJSON(signalsFile, signalsData);
  }
  console.log(`\n  Done. ${newCount} new signal(s). Total signals stored: ${existingSignals.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
