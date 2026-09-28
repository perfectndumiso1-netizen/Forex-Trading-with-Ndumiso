/**
 * config.js — Central, user-editable configuration.
 *
 * The signal engine never hard-codes pairs or timeframes; it reads from here.
 * Add/remove pairs or adjust parameters without touching engine logic.
 */

export const STRATEGY_VERSION = "1.0.0";

// ── Timeframes (hierarchical: higher TFs establish context first) ────────────
export const TIMEFRAMES = [
  { id: "D1",  label: "Daily",    minutes: 1440, context: "major market context" },
  { id: "H4",  label: "4 Hour",   minutes: 240,  context: "primary trend/structure" },
  { id: "H1",  label: "1 Hour",   minutes: 60,   context: "setup confirmation" },
  { id: "M15", label: "15 Min",   minutes: 15,   context: "entry timing" },
  { id: "M5",  label: "5 Min",    minutes: 5,    context: "optional precision entry", optional: true },
];

// Hierarchy order (highest → lowest). Engine processes in this order.
export const TF_HIERARCHY = ["D1", "H4", "H1", "M15", "M5"];

// ── Currency pairs ───────────────────────────────────────────────────────────
// Add/remove here; engine discovers pairs automatically.
export const PAIRS = [
  { symbol: "EURUSD", label: "EUR/USD", pipSize: 0.0001, pipette: true },
  { symbol: "GBPUSD", label: "GBP/USD", pipSize: 0.0001, pipette: true },
  { symbol: "USDJPY", label: "USD/JPY", pipSize: 0.01,   pipette: true },
  { symbol: "USDCHF", label: "USD/CHF", pipSize: 0.0001, pipette: true },
  { symbol: "AUDUSD", label: "AUD/USD", pipSize: 0.0001, pipette: true },
  { symbol: "USDCAD", label: "USD/CAD", pipSize: 0.0001, pipette: true },
  { symbol: "NZDUSD", label: "NZD/USD", pipSize: 0.0001, pipette: true },
  { symbol: "EURGBP", label: "EUR/GBP", pipSize: 0.0001, pipette: true },
  { symbol: "EURJPY", label: "EUR/JPY", pipSize: 0.01,   pipette: true },
  { symbol: "GBPJPY", label: "GBP/JPY", pipSize: 0.01,   pipette: true },
];

// ── Indicator parameters ─────────────────────────────────────────────────────
export const INDICATOR_PARAMS = {
  emaFast:     9,
  emaSlow:     21,
  smaTrend:    50,
  smaLong:     200,
  rsiPeriod:   14,
  rsiOverbought: 70,
  rsiOversold:   30,
  macdFast:    12,
  macdSlow:    26,
  macdSignal:  9,
  atrPeriod:   14,
  bbPeriod:    20,
  bbStdDev:    2.0,
  swingLookback: 5,       // bars left/right for swing detection
  srTouches:   2,         // minimum touches to validate a level
  srZonePips:  5,         // tolerance band around S/R in pips
};

// ── Signal generation thresholds ─────────────────────────────────────────────
export const SIGNAL_PARAMS = {
  minConfluence:     60,   // minimum strength (0-100) to emit BUY/SELL
  atrStopMultiplier: 1.5,  // SL distance = N × ATR
  atrTpMultiplier:   3.0,  // base TP distance = N × ATR
  minRiskReward:     1.5,  // minimum acceptable R:R
  maxSpreadPips:     3,    // skip if estimated spread > this
  duplicateWindowH:  4,    // prevent duplicate signals within N hours on same pair/TF
  cooldownBars:      4,    // wait N bars after a signal before re-evaluating same direction
};

// ── Risk defaults (adjustable in UI later) ───────────────────────────────────
export const RISK_PARAMS = {
  riskPercentPerTrade: 1.0,   // % of account risked per trade
  accountBalance:      10000, // demo default; user changes in UI
};

// ── Data acquisition ─────────────────────────────────────────────────────────
export const DATA_PARAMS = {
  primaryProvider: "twelvedata",
  backupProvider:  "yahoo",
  maxCandlesPerFile: 5000,   // cap history depth per pair/TF
  fetchRetries: 3,
  minCandleQuality: 0.95,    // require 95% of expected candles present
};

// ── GitHub Pages paths ───────────────────────────────────────────────────────
export const PATHS = {
  pricesDir:  "data/prices",
  signalsFile: "data/signals/signals.json",
  tradesFile:  "data/trades/trades.json",
  economicFile: "data/economic.json",
};

// ── Helpers ──────────────────────────────────────────────────────────────────
export function getPair(symbol) {
  return PAIRS.find(p => p.symbol === symbol);
}

export function getTF(id) {
  return TIMEFRAMES.find(t => t.id === id);
}

export function pipsToPrice(pips, symbol) {
  const pair = getPair(symbol);
  return pips * pair.pipSize;
}

export function priceToPips(priceDiff, symbol) {
  const pair = getPair(symbol);
  return priceDiff / pair.pipSize;
}
