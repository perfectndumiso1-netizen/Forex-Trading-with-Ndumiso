/**
 * indicators.js — Pure technical indicator functions.
 *
 * Every function is deterministic, side-effect free, and works on plain arrays
 * of numbers or normalized candle objects. Callable from browser, Node/Actions,
 * backtester, and unit tests alike.
 *
 * Candle format: { time, open, high, low, close, volume }
 */

// ── Simple Moving Average ────────────────────────────────────────────────────
export function sma(values, period) {
  if (period <= 0) throw new Error("SMA period must be > 0");
  const result = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) result[i] = sum / period;
  }
  return result;
}

// ── Exponential Moving Average ──────────────────────────────────────────────
export function ema(values, period) {
  if (period <= 0) throw new Error("EMA period must be > 0");
  const result = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  // Seed with SMA of first `period` values
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  result[period - 1] = seed / period;
  for (let i = period; i < values.length; i++) {
    result[i] = values[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

// ── Relative Strength Index ─────────────────────────────────────────────────
export function rsi(closes, period = 14) {
  const result = new Array(closes.length).fill(null);
  if (closes.length <= period) return result;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) avgGain += diff; else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

// ── MACD ────────────────────────────────────────────────────────────────────
export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = closes.map((_, i) => {
    if (emaFast[i] === null || emaSlow[i] === null) return null;
    return emaFast[i] - emaSlow[i];
  });
  // EMA of MACD line for signal line (skip nulls)
  const macdVals = macdLine.map(v => v === null ? 0 : v); // temp; we'll null properly
  const signalLine = new Array(closes.length).fill(null);
  const histogram = new Array(closes.length).fill(null);
  // Find first valid MACD index
  const firstValid = macdLine.findIndex(v => v !== null);
  if (firstValid === -1) return { macdLine, signalLine, histogram };
  const k = 2 / (signal + 1);
  let sig = macdLine[firstValid];
  signalLine[firstValid] = sig;
  for (let i = firstValid + 1; i < closes.length; i++) {
    if (macdLine[i] === null) continue;
    sig = macdLine[i] * k + sig * (1 - k);
    signalLine[i] = sig;
    histogram[i] = macdLine[i] - sig;
  }
  // Null out seed region properly
  for (let i = 0; i < firstValid; i++) {
    macdVals[i] = null;
  }
  return { macdLine, signalLine, histogram };
}

// ── Average True Range ──────────────────────────────────────────────────────
export function atr(candles, period = 14) {
  const result = new Array(candles.length).fill(null);
  if (candles.length <= period) return result;
  const trs = [];
  trs[0] = candles[0].high - candles[0].low;
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    trs[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  // First ATR = simple average of first `period` TRs
  let sum = 0;
  for (let i = 0; i < period; i++) sum += trs[i];
  result[period - 1] = sum / period;
  for (let i = period; i < candles.length; i++) {
    result[i] = (result[i - 1] * (period - 1) + trs[i]) / period;
  }
  return result;
}

// ── Bollinger Bands ─────────────────────────────────────────────────────────
export function bollinger(closes, period = 20, stdDev = 2.0) {
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) {
      variance += (closes[j] - mid[i]) ** 2;
    }
    const sd = Math.sqrt(variance / period);
    upper[i] = mid[i] + stdDev * sd;
    lower[i] = mid[i] - stdDev * sd;
  }
  return { upper, middle: mid, lower };
}

// ── Stochastic Oscillator ──────────────────────────────────────────────────
export function stoch(candles, kPeriod = 14, dPeriod = 3) {
  const k = new Array(candles.length).fill(null);
  for (let i = kPeriod - 1; i < candles.length; i++) {
    let high = -Infinity, low = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (candles[j].high > high) high = candles[j].high;
      if (candles[j].low < low) low = candles[j].low;
    }
    k[i] = high === low ? 50 : ((candles[i].close - low) / (high - low)) * 100;
  }
  const kVals = k.map(v => v === null ? 0 : v);
  const d = sma(kVals, dPeriod);
  // Null out where K is null
  for (let i = 0; i < k.length; i++) if (k[i] === null) d[i] = null;
  return { k, d };
}

// ── Utility: extract close prices ───────────────────────────────────────────
export function closes(candles) {
  return candles.map(c => c.close);
}

// ── Utility: extract highs/lows ─────────────────────────────────────────────
export function highs(candles) { return candles.map(c => c.high); }
export function lows(candles)  { return candles.map(c => c.low); }
