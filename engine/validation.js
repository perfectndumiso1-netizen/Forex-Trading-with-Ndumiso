/**
 * validation.js — Candle data validation and normalization (pure functions).
 *
 * Ensures candles from any provider conform to the expected format before
 * they reach the signal engine. Records provider provenance and data quality.
 *
 * Checks performed:
 *   - Empty / non-array input
 *   - OHLC sanity (high >= all, low <= all, positive values)
 *   - Timestamp normalization (grid-aligned per timeframe)
 *   - Duplicate timestamps (dedup by keeping latest)
 *   - Gap detection
 *   - Outlier detection (single-candle spikes > 5× ATR)
 *   - Freshness (latest candle within expected age for the timeframe)
 *   - Future-candle rejection
 *   - Completeness vs expected count
 */

/**
 * Validate and normalize a batch of candles from a data provider.
 *
 * @param {Array} rawCandles  Provider candles (format varies by provider)
 * @param {string} provider   Provider name ('twelvedata' | 'yahoo' | 'demo' | ...)
 * @param {Object} meta       { pair, timeframe, expectedCount, fetchedAt, now }
 * @returns {Object}          { candles, quality, provider, usable, meta, issues }
 */
export function validateCandles(rawCandles, provider, meta = {}) {
  const issues = [];
  const { pair, timeframe, expectedCount, fetchedAt } = meta;
  const now = meta.now || Math.floor(Date.now() / 1000);
  const tfMinutes = timeframeToMinutes(timeframe);

  if (!Array.isArray(rawCandles) || rawCandles.length === 0) {
    return {
      candles: [],
      quality: 0,
      provider,
      usable: false,
      meta,
      issues: ["No candles returned"],
    };
  }

  // ── Normalize to { time, open, high, low, close, volume } ──────────────
  const normalized = [];
  for (const raw of rawCandles) {
    const c = normalizeCandle(raw, provider);
    if (c) normalized.push(c);
    else issues.push(`Invalid candle: ${JSON.stringify(raw).slice(0, 120)}`);
  }

  if (normalized.length === 0) {
    return { candles: [], quality: 0, provider, usable: false, meta, issues: [...issues, "All candles failed normalization"] };
  }

  // ── Grid-align timestamps ─────────────────────────────────────────────
  // Some providers return timestamps with seconds offset (e.g. :25 past the
  // hour) or timestamps slightly off the TF boundary. Snap to nearest grid
  // point so duplicates collapse correctly.
  if (tfMinutes) {
    const grid = tfMinutes * 60;
    for (const c of normalized) {
      c.time = Math.round(c.time / grid) * grid;
    }
  }

  // ── Reject future-dated candles ───────────────────────────────────────
  // Allow up to 1 TF of slack (the most recent in-progress bar can be near
  // "now" even after rounding).
  const futureThreshold = now + (tfMinutes ? tfMinutes * 60 : 0);
  const beforeLen = normalized.length;
  const filtered = [];
  for (const c of normalized) {
    if (c.time > futureThreshold) {
      issues.push(`Rejected future-dated candle at ${c.time} (${new Date(c.time * 1000).toISOString()})`);
      continue;
    }
    filtered.push(c);
  }
  normalized.length = 0;
  normalized.push(...filtered);

  // ── Deduplicate by timestamp (keep the last occurrence — fresh data) ─
  const byTime = new Map();
  for (const c of normalized) byTime.set(c.time, c);
  const deduped = Array.from(byTime.values()).sort((a, b) => a.time - b.time);

  // ── Gap detection ─────────────────────────────────────────────────────
  let gaps = 0;
  if (tfMinutes) {
    for (let i = 1; i < deduped.length; i++) {
      const gapMin = (deduped[i].time - deduped[i - 1].time) / 60;
      if (gapMin > tfMinutes * 1.8) gaps++;
    }
  }
  if (gaps > 0) issues.push(`${gaps} gap(s) detected in candle sequence`);

  // ── OHLC sanity ───────────────────────────────────────────────────────
  let ohlcErrors = 0;
  const clean = [];
  for (const c of deduped) {
    if (c.high < c.low) { ohlcErrors++; continue; }
    if (c.open > c.high || c.open < c.low) { ohlcErrors++; continue; }
    if (c.close > c.high || c.close < c.low) { ohlcErrors++; continue; }
    if (c.open <= 0 || c.high <= 0 || c.low <= 0 || c.close <= 0) { ohlcErrors++; continue; }
    clean.push(c);
  }
  if (ohlcErrors > 0) issues.push(`${ohlcErrors} OHLC inconsistency(ies) removed`);

  // ── Outlier / spike detection ────────────────────────────────────────
  // Remove single-candle spikes where the price moves more than 5× recent
  // ATR away from neighbors in BOTH directions (i.e. an isolated spike that
  // immediately snaps back). These are provider corruptions (e.g. misaligned
  // TF buckets), not real price action.
  const cleaned = removeSpikeOutliers(clean, issues);

  // ── Freshness check ──────────────────────────────────────────────────
  const latest = cleaned.length ? cleaned[cleaned.length - 1].time : 0;
  let freshness = 1.0;
  if (tfMinutes && cleaned.length > 1) {
    const ageMin = (now - latest) / 60;
    // Max acceptable age depends on TF. Allow up to 3 bars of delay for
    // lower TFs; more for D1 (weekend/holiday).
    const maxAgeMin = {
      M5:  4 * 5,
      M15: 4 * 15,
      M30: 4 * 30,
      H1:  4 * 60,
      H4:  4 * 240,
      D1:  3 * 1440,   // weekends/holidays
    }[timeframe] || tfMinutes * 4;
    // A candle not yet closed shouldn't be required (Twelve Data returns
    // completed bars only, Yahoo includes current bar).
    if (ageMin > maxAgeMin) {
      issues.push(`Stale data: latest candle is ${Math.round(ageMin)} min old (max ${maxAgeMin})`);
      freshness = Math.max(0, 1 - (ageMin - maxAgeMin) / maxAgeMin);
    }
    // Must have at least one recent candle (within 2× TF window)
    if (ageMin > maxAgeMin * 2) freshness = 0;
  }

  // ── Quality score (0–1) ──────────────────────────────────────────────
  const denom = expectedCount || cleaned.length;
  const completeness = Math.min(1, cleaned.length / denom);
  const gapPenalty = cleaned.length > 1 ? Math.max(0, 1 - gaps / cleaned.length) : 0;
  const ohlcPenalty = deduped.length ? Math.max(0, 1 - ohlcErrors / deduped.length) : 0;
  const structuralQuality = Math.round(completeness * gapPenalty * ohlcPenalty * 100) / 100;
  const quality = Math.round(structuralQuality * freshness * 100) / 100;

  // Usable if quality is >= 0.6 AND freshness > 0 AND we have enough candles
  // for basic indicator warmup (smaLong=200 is the deepest, but lower TFs can
  // still be directionally useful with fewer). The signal engine enforces its
  // own stricter gating (MIN_TF_QUALITY, critical TF requirements).
  const usable = quality >= 0.6 && freshness > 0 && cleaned.length >= 30;

  return {
    candles: cleaned,
    quality,
    freshness,
    provider,
    usable,
    completeness,
    meta: {
      pair, timeframe,
      fetchedAt: fetchedAt || new Date().toISOString(),
      count: cleaned.length,
      latestTime: latest,
      latestAgeMinutes: latest ? Math.round((now - latest) / 60) : null,
    },
    issues,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────
function normalizeCandle(raw, provider) {
  // Twelve Data: { datetime, open, high, low, close, volume }
  // Yahoo: { timestamp (sec), open, high, low, close, volume }
  // Generic fallback: try all reasonable key combinations
  let time, open, high, low, close, volume;
  if (raw.time !== undefined) time = raw.time;
  else if (raw.datetime !== undefined) time = Math.floor(new Date(raw.datetime).getTime() / 1000);
  else if (raw.Date !== undefined) time = Math.floor(new Date(raw.Date).getTime() / 1000);
  else if (raw.timestamp !== undefined) time = raw.timestamp;
  if (typeof time === "string") time = Math.floor(new Date(time).getTime() / 1000);
  if (typeof time !== "number" || isNaN(time)) return null;

  open = Number(raw.open ?? raw.Open);
  high = Number(raw.high ?? raw.High);
  low  = Number(raw.low  ?? raw.Low);
  close= Number(raw.close?? raw.Close);
  volume = Number(raw.volume ?? raw.Volume ?? 0);
  if ([open, high, low, close].some(v => isNaN(v) || v <= 0)) return null;
  return { time, open, high, low, close, volume };
}

function timeframeToMinutes(tf) {
  const map = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440, W1: 10080, MN1: 43200 };
  return map[tf] || null;
}

/**
 * Return the candle array from either a raw array or a validation result
 * object shaped { candles, quality, usable, freshness, ... }.
 *
 * Used by the fetch pipeline and downstream consumers so they never have to
 * branch on shape — a single bug caused by treating validation objects as
 * arrays (e.g. arr.length on an object returning undefined) is the regression
 * this guards against.
 */
export function getCandles(entry) {
  if (Array.isArray(entry)) return entry;
  if (entry && Array.isArray(entry.candles)) return entry.candles;
  return null;
}

export function candleCount(entry) {
  const c = getCandles(entry);
  return c ? c.length : 0;
}

/**
 * Remove isolated single-candle spikes (>5× ATR move that immediately reverses).
 * These are almost always data feed corruptions (e.g. misaligned timeframe
 * bucket leaking a different-TF candle into the series). We don't want them
 * to poison ATR / structure / SL calculations.
 */
function removeSpikeOutliers(candles, issues) {
  if (candles.length < 30) return candles;
  // Compute rolling ATR (14) to establish expected move size
  const period = 14;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const atrs = [];
  let sum = 0;
  for (let i = 0; i < trs.length; i++) {
    sum += trs[i];
    if (i >= period) sum -= trs[i - period];
    atrs.push(i >= period - 1 ? sum / period : null);
  }
  // Walk and remove candles where BOTH neighbors are >5× ATR away AND
  // the candle is an "isolated excursion" (returned to within 1× of prior close)
  const result = [];
  let removed = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i === 0 || i === candles.length - 1) { result.push(candles[i]); continue; }
    const prev = candles[i - 1], next = candles[i + 1], c = candles[i];
    const atrIdx = Math.min(i - 1, atrs.length - 1);
    const atr = atrs[atrIdx];
    if (!atr || atr <= 0) { result.push(c); continue; }
    const moveUp = Math.abs(c.high - prev.close);
    const moveDn = Math.abs(c.low - prev.close);
    const nextReverseUp = next.close <= prev.close + atr * 1.5;
    const nextReverseDn = next.close >= prev.close - atr * 1.5;
    const isolated = (moveUp > atr * 5 && nextReverseUp) || (moveDn > atr * 5 && nextReverseDn);
    if (isolated && Math.abs(next.close - prev.close) < atr * 1.5) {
      removed++;
      issues.push(`Removed spike outlier at t=${c.time} (move ${Math.max(moveUp, moveDn).toFixed(5)} > 5× ATR ${atr.toFixed(5)})`);
      continue;
    }
    result.push(c);
  }
  return result;
}
