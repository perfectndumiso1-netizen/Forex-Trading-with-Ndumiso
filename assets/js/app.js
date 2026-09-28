/**
 * app.js — Dashboard initialization and event wiring.
 *
 * The browser reads only pre-processed JSON from the repo (api.js).
 * It renders charts and signal cards. It does NOT call data providers directly,
 * does NOT store API keys or PATs, and cannot write back to the repo.
 * All writes happen via GitHub Actions.
 */

import { STRATEGY_VERSION } from "./config.js";
import { fetchJSON, loadCandles, loadSignals, loadTrades, isDemoData, PAIRS } from "./api.js";
import { createChart, setCandles, setIndicatorsVisible, setZones } from "./charts.js";
import {
  renderSignals, populatePairSelect, populateFilterSelect,
  renderPairsTable, renderStats, renderTradesLog, fmtTime,
} from "./ui.js";

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  signals: [],
  signalsMeta: {},
  trades: [],
  allPairData: {},   // { SYMBOL: { candles: {TF: []}, meta: {TF: {}}} }
  currentPair: "EURUSD",
  currentTF: "H1",
  showIndicators: true,
};

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $ = sel => document.querySelector(sel);
const els = {
  dataStatus: $("#data-status"),
  lastUpdate: $("#last-update"),
  demoBanner: $("#demo-banner"),
  signalsGrid: $("#signals-grid"),
  filterPair: $("#filter-pair"),
  filterDir: $("#filter-direction"),
  chart: $("#main-chart"),
  chartPair: $("#chart-pair"),
  chartInfo: $("#chart-info"),
  tfPills: document.querySelectorAll(".tf-pill"),
  showIndicators: $("#show-indicators"),
  pairsTbody: $("#pairs-tbody"),
  equityChart: $("#equity-chart"),
  tradesLog: $("#trades-log"),
  btPair: $("#bt-pair"),
  btRun: $("#bt-run"),
  btResults: $("#bt-results"),
  statTotal: $("#stat-total"),
  statWinrate: $("#stat-winrate"),
  statPf: $("#stat-pf"),
  statPips: $("#stat-pips"),
  statExpectancy: $("#stat-expectancy"),
  statDd: $("#stat-dd"),
  statAvgwin: $("#stat-avgwin"),
  statAvgloss: $("#stat-avgloss"),
  aboutVersion: $("#about-version"),
  btStrategy: $("#bt-strategy"),
};

// ── Tab switching ────────────────────────────────────────────────────────────
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    tab.classList.add("active");
    const panel = document.getElementById(`tab-${tab.dataset.tab}`);
    panel.classList.add("active");
    // Resize chart if we're switching to chart tab
    if (tab.dataset.tab === "chart") {
      setTimeout(() => loadAndRenderChart(), 50);
    }
  });
});

// ── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  // Version labels
  $("#strategy-version").textContent = `v${STRATEGY_VERSION}`;
  els.aboutVersion.textContent = STRATEGY_VERSION;
  els.btStrategy.textContent = `v${STRATEGY_VERSION}`;

  // Populate selects
  populatePairSelect(els.chartPair);
  populatePairSelect(els.btPair);
  populateFilterSelect(els.filterPair);

  // TF pill switching
  els.tfPills.forEach(pill => {
    pill.addEventListener("click", () => {
      els.tfPills.forEach(p => p.classList.remove("active"));
      pill.classList.add("active");
      state.currentTF = pill.dataset.tf;
      loadAndRenderChart();
    });
  });

  // Chart pair switcher
  els.chartPair.addEventListener("change", e => {
    state.currentPair = e.target.value;
    loadAndRenderChart();
  });

  // Indicator toggle
  els.showIndicators.addEventListener("change", e => {
    state.showIndicators = e.target.checked;
    renderChartOverlay();
  });

  // Filters
  els.filterPair.addEventListener("change", () => renderCurrentSignals());
  els.filterDir.addEventListener("change", () => renderCurrentSignals());

  // Backtest button (Phase 2 stub)
  els.btRun.addEventListener("click", runBacktestStub);

  // Load everything
  await loadAllData();

  // Auto-refresh every 5 minutes to pick up Actions-updated data
  setInterval(loadAllData, 5 * 60 * 1000);
}

// ── Load all data ────────────────────────────────────────────────────────────
async function loadAllData() {
  els.dataStatus.textContent = "Loading…";
  els.dataStatus.className = "data-status";

  try {
    // Load signals and trades
    const [sigData, tradeData] = await Promise.all([loadSignals(), loadTrades()]);
    state.signals = sigData.signals || [];
    state.signalsMeta = sigData.meta || {};
    state.trades = tradeData.trades || [];

    // Load price data for all pairs
    const pairLoads = PAIRS.map(async pair => {
      const pairResult = { candles: {}, meta: {} };
      for (const tf of ["D1", "H4", "H1", "M15", "M5"]) {
        const { candles, meta } = await loadCandles(pair.symbol, tf);
        pairResult.candles[tf] = candles;
        pairResult.meta[tf] = meta;
      }
      state.allPairData[pair.symbol] = pairResult;
    });
    await Promise.all(pairLoads);

    // Status
    els.dataStatus.textContent = "Connected";
    els.dataStatus.className = "data-status connected";
    els.lastUpdate.textContent = `Updated ${fmtTime(state.signalsMeta.lastUpdated || new Date().toISOString())}`;

    // Demo banner
    if (isDemoData(sigData, state.allPairData[state.currentPair])) {
      els.demoBanner.classList.remove("hidden");
    } else {
      els.demoBanner.classList.add("hidden");
    }

    // Render
    renderCurrentSignals();
    renderPairs();
    renderPerformance();
    loadAndRenderChart();
  } catch (e) {
    console.error("Load error:", e);
    els.dataStatus.textContent = "Error";
    els.dataStatus.className = "data-status error";
  }
}

// ── Render signal cards ─────────────────────────────────────────────────────
function renderCurrentSignals() {
  const active = state.signals.filter(s => s.status !== "CLOSED");
  renderSignals(active, els.signalsGrid, els.filterPair.value, els.filterDir.value);
}

// ── Render pairs overview ───────────────────────────────────────────────────
function renderPairs() {
  renderPairsTable(state.allPairData, state.signals, els.pairsTbody);
}

// ── Render performance ──────────────────────────────────────────────────────
async function renderPerformance() {
  const { calculatePerformance, equityCurve } = await import("../../engine/performance.js");
  const stats = calculatePerformance(state.trades);
  renderStats(stats, {
    total: els.statTotal, winrate: els.statWinrate, pf: els.statPf,
    pips: els.statPips, expectancy: els.statExpectancy, dd: els.statDd,
    avgwin: els.statAvgwin, avgloss: els.statAvgloss,
  });
  renderTradesLog(state.trades, els.tradesLog);
  renderEquityCurve(equityCurve(state.trades));
}

function renderEquityCurve(equity) {
  // Clear previous chart
  els.equityChart.innerHTML = "";
  if (!equity.length) {
    els.equityChart.innerHTML = `<div class="loading" style="padding:20px">No equity data yet — close trades to build the curve.</div>`;
    return;
  }
  const ecChart = LightweightCharts.createChart(els.equityChart, {
    layout: { background: { type: "solid", color: "#1a1f26" }, textColor: "#8b949e" },
    grid: { vertLines: { color: "rgba(48,54,61,0.3)" }, horzLines: { color: "rgba(48,54,61,0.3)" } },
    rightPriceScale: { borderColor: "#30363d" },
    timeScale: { borderColor: "#30363d", timeVisible: false },
    width: els.equityChart.clientWidth,
    height: 250,
  });
  const line = ecChart.addAreaSeries({
    topColor: "rgba(88,166,255,0.4)",
    bottomColor: "rgba(88,166,255,0.0)",
    lineColor: "#58a6ff",
    lineWidth: 2,
  });
  line.setData(equity.map(p => ({
    time: Math.floor(new Date(p.time).getTime() / 1000),
    value: p.equity,
  })));
  ecChart.timeScale().fitContent();
}

// ── Render chart ─────────────────────────────────────────────────────────────
function loadAndRenderChart() {
  if (!els.chart.clientWidth) return; // not visible yet
  const pair = state.currentPair;
  const tf = state.currentTF;
  const data = state.allPairData[pair]?.candles?.[tf] || [];
  if (!data.length) {
    els.chartInfo.textContent = `No data for ${pair} ${tf}`;
    return;
  }
  if (!chart) {
    createChart(els.chart);
  }
  setCandles(data);
  renderChartOverlay();
  const last = data.at(-1);
  const meta = state.allPairData[pair]?.meta?.[tf];
  els.chartInfo.innerHTML = `
    <strong>${pair}</strong> ${tf} &nbsp;|&nbsp;
    O: ${last.open} &nbsp; H: ${last.high} &nbsp; L: ${last.low} &nbsp; C: <strong>${last.close}</strong>
    &nbsp;|&nbsp; Data source: <code>${meta?.provider || "unknown"}</code>
    &nbsp;|&nbsp; Quality: ${meta?.quality != null ? (meta.quality * 100).toFixed(0) + "%" : "?"}
    ${meta?.issues?.length ? `&nbsp;|&nbsp; <span style="color:var(--accent-yellow)">${meta.issues.length} note(s)</span>` : ""}
  `;
}

// Lazy-load chart singleton
let chart = null;
async function renderChartOverlay() {
  if (!chart) {
    chart = createChart(els.chart);
    // re-set candles
    const data = state.allPairData[state.currentPair]?.candles?.[state.currentTF] || [];
    setCandles(data);
  }
  const data = state.allPairData[state.currentPair]?.candles?.[state.currentTF] || [];
  setIndicatorsVisible(data, state.showIndicators);
  // Show active signal's S/R zones if any
  const active = state.signals.find(s => s.pair === state.currentPair && s.status === "ACTIVE");
  if (active?.zones) setZones(active.zones);
  else setZones([]);
}

// ── Backtest stub (Phase 2-3) ──────────────────────────────────────────────
async function runBacktestStub() {
  const pair = els.btPair.value;
  els.btResults.innerHTML = `<p>Loading pair data for ${pair} and running backtest…</p>`;
  try {
    const { backtest } = await import("../../engine/backtest.js");
    const { calculatePerformance } = await import("../../engine/performance.js");
    const pairConf = PAIRS.find(p => p.symbol === pair);
    const data = state.allPairData[pair]?.candles || {};
    if (!data.H1 || data.H1.length < 350) {
      els.btResults.innerHTML = `<p style="color:var(--accent-yellow)">Insufficient historical data for ${pair}. Need at least 350 H1 candles; have ${data.H1?.length || 0}. Run the data fetcher for longer to accumulate history, or use D1 for a quicker test.</p>`;
      return;
    }
    const result = backtest(data, pairConf, { warmup: 300 });
    const stats = calculatePerformance(result.trades);
    els.btResults.innerHTML = `
      <h3 style="margin-bottom:12px">${pair} — Walk-Forward Backtest (v${STRATEGY_VERSION})</h3>
      <div class="stats-grid" style="margin-bottom:16px">
        <div class="stat-card"><div class="stat-label">Signals Generated</div><div class="stat-value">${result.signals.length}</div></div>
        <div class="stat-card"><div class="stat-label">Closed Trades</div><div class="stat-value">${result.trades.length}</div></div>
        <div class="stat-card"><div class="stat-label">Win Rate</div><div class="stat-value ${stats.winRate >= 50 ? "positive" : "negative"}">${stats.winRate}%</div></div>
        <div class="stat-card"><div class="stat-label">Profit Factor</div><div class="stat-value ${stats.profitFactor >= 1 ? "positive" : "negative"}">${stats.profitFactor}</div></div>
        <div class="stat-card"><div class="stat-label">Total Pips</div><div class="stat-value ${stats.totalPips >= 0 ? "positive" : "negative"}">${stats.totalPips.toFixed(1)}</div></div>
        <div class="stat-card"><div class="stat-label">Max Drawdown</div><div class="stat-value negative">${stats.maxDrawdown}R</div></div>
      </div>
      <p class="panel-hint"><strong>⚠️ Note:</strong> This backtest runs on currently-available data (which may be demo/synthetic at this stage). Results are only meaningful once real historical data has been accumulated by the Actions pipeline. All metrics are based on raw SL/TP hits — no slippage, spread, or commission model applied yet.</p>
    `;
  } catch (e) {
    els.btResults.innerHTML = `<p style="color:var(--accent-red)">Backtest error: ${e.message}</p>`;
    console.error(e);
  }
}

// Boot
init();
