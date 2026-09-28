/**
 * api.js — Data loading from the GitHub Pages-hosted JSON files.
 *
 * The browser ONLY reads already-processed data from the repo. It never
 * touches API keys, provider credentials, or PATs (per architecture rule A & B).
 */

import { PAIRS, TIMEFRAMES, PATHS } from "./config.js";

/**
 * Fetch JSON file from the repo (relative path).
 * Returns parsed JSON, or fallback on failure.
 */
export async function fetchJSON(path, fallback = null) {
  try {
    // Cache-bust with hourly timestamp so fresh data loads after Actions run
    const cb = Math.floor(Date.now() / (1000 * 60 * 5)); // 5-min cache
    const res = await fetch(`${path}?t=${cb}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.warn(`Failed to fetch ${path}:`, e);
    return fallback;
  }
}

/**
 * Load candles for a given pair and timeframe from data/prices/.
 */
export async function loadCandles(pair, tf) {
  const file = `${PATHS.pricesDir}/${pair}-${tf}.json`;
  const data = await fetchJSON(file);
  if (!data || !data.candles) return { candles: [], meta: null };
  return { candles: data.candles, meta: data.meta };
}

/**
 * Load all signals.
 */
export async function loadSignals() {
  const data = await fetchJSON(PATHS.signalsFile, { signals: [], meta: {} });
  return data;
}

/**
 * Load all closed trades.
 */
export async function loadTrades() {
  const data = await fetchJSON(PATHS.tradesFile, { trades: [], meta: {} });
  return data;
}

/**
 * Load multi-TF data for a single pair (all TFs).
 */
export async function loadPairData(pair) {
  const result = {};
  const meta = {};
  for (const tf of TIMEFRAMES) {
    const { candles, meta: m } = await loadCandles(pair, tf.id);
    result[tf.id] = candles;
    meta[tf.id] = m;
  }
  return { candles: result, meta };
}

/**
 * Check whether current data is demo/mock data by inspecting meta.
 */
export function isDemoData(signalsData, pairData) {
  if (signalsData?.meta?.isMockData) return true;
  for (const tf in pairData?.meta || {}) {
    if (pairData.meta[tf]?.isDemoData || pairData.meta[tf]?.provider === "synthetic") return true;
  }
  return false;
}

export { PAIRS, TIMEFRAMES };
