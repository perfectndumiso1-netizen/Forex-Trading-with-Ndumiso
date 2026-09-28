/**
 * validation.js — Candle data validation and normalization (pure functions).
 *
 * Ensures candles from any provider conform to the expected format before
 * they reach the signal engine. Records provider provenance and data quality.
 */

/**
 * Validate and normalize a batch of candles from a data provider.
 *
 * @param {Array} rawCandles  Provider candles (format varies by provider)
 * @param {string} provider   Provider name ('twelvedata' | 'yahoo' | 'synthetic' | ...)
 * @param {Object} meta       { pair, timeframe, expectedCount, fetchedAt }
 * @returns {Object}          { candles, quality, provider, meta, issues }
 */
export function validateCandles(rawCandles, provider, meta = {}) {
  const issues = [];
  const { pair, timeframe, expectedCount, fetchedAt } = meta;

  if (!Array.isArray(rawCandles) || rawCandles.length === 0) {
    return {
      candles: [],
      quality: 0,
      provider,
      meta,
      issues: ["No candles returned"],
    };
  }

  // Normalize to { time, open, high, low, close, volume }
  const normalized = [];
  for (const raw of rawCandles) {
    const c = normalizeCandle(raw, provider);
    if (c) normalized.push(c);
    else issues.push(`Invalid candle: ${JSON.stringify(raw).slice(0, 120)}`);
  }

  // Sort ascending by time
  normalized.sort((a, b) => a.time - b.time);

  // Check for gaps
  let gaps = 0;
  const expectedMinutes = timeframeToMinutes(timeframe);
  for (let i = 1; i < normalized.length; i++) {
    const gap = (normalized[i].time - normalized[i - 1].time) / 60;
    if (expectedMinutes && gap > expectedMinutes * 1.8) gaps++;
  }
  if (gaps > 0) issues.push(`${gaps} gap(s) detected in candle sequence`);

  // Check for invalid OHLC (high < low, etc.)
  let ohlcErrors = 0;
  for (const c of normalized) {
    if (c.high < c.low) ohlcErrors++;
    if (c.open > c.high || c.open < c.low) ohlcErrors++;
    if (c.close > c.high || c.close < c.low) ohlcErrors++;
  }
  if (ohlcErrors > 0) issues.push(`${ohlcErrors} OHLC inconsistency(ies)`);

  // Data quality score (0-1)
  const denom = expectedCount || normalized.length;
  const completeness = Math.min(1, normalized.length / denom);
  const gapPenalty = Math.max(0, 1 - gaps / normalized.length);
  const ohlcPenalty = Math.max(0, 1 - ohlcErrors / normalized.length);
  const quality = Math.round(completeness * gapPenalty * ohlcPenalty * 100) / 100;

  return {
    candles: normalized,
    quality,
    provider,
    completeness,
    meta: { pair, timeframe, fetchedAt: fetchedAt || new Date().toISOString(), count: normalized.length },
    issues,
  };
}

function normalizeCandle(raw, provider) {
  // Twelve Data: { datetime, open, high, low, close, volume }
  // Yahoo (yfinance): { Date, Open, High, Low, Close, Volume } or { timestamp, open, ... }
  // Generic fallback: try all reasonable key combinations
  let time, open, high, low, close, volume;
  if (raw.time !== undefined) time = raw.time;
  else if (raw.datetime !== undefined) time = Math.floor(new Date(raw.datetime).getTime() / 1000);
  else if (raw.Date !== undefined) time = Math.floor(new Date(raw.Date).getTime() / 1000);
  else if (raw.timestamp !== undefined) time = raw.timestamp;
  if (typeof time === "string") time = Math.floor(new Date(time).getTime() / 1000);

  open = Number(raw.open ?? raw.Open);
  high = Number(raw.high ?? raw.High);
  low  = Number(raw.low  ?? raw.Low);
  close= Number(raw.close?? raw.Close);
  volume = Number(raw.volume ?? raw.Volume ?? 0);

  if ([open, high, low, close].some(v => isNaN(v) || v === 0)) return null;
  return { time, open, high, low, close, volume };
}

function timeframeToMinutes(tf) {
  const map = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440, W1: 10080, MN1: 43200 };
  return map[tf] || null;
}
