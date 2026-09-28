/**
 * Trading Forex with Ndumiso — Mobile App
 *
 * Reads data from the GitHub Pages-hosted JSON (same API as web dashboard).
 * Designed for Android APK wrapping. No GitHub branding visible in-app.
 */

const DATA_BASE = "https://perfectndumiso1-netizen.github.io/Forex-Trading-with-Ndumiso";
// Fallback to relative if opened locally from file:// will fail (expected; APK serves from origin)

const PAIRS = [
  { symbol: "EURUSD", label: "EUR/USD", jpy: false },
  { symbol: "GBPUSD", label: "GBP/USD", jpy: false },
  { symbol: "USDJPY", label: "USD/JPY", jpy: true },
  { symbol: "USDCHF", label: "USD/CHF", jpy: false },
  { symbol: "AUDUSD", label: "AUD/USD", jpy: false },
  { symbol: "USDCAD", label: "USD/CAD", jpy: false },
  { symbol: "NZDUSD", label: "NZD/USD", jpy: false },
  { symbol: "EURGBP", label: "EUR/GBP", jpy: false },
  { symbol: "EURJPY", label: "EUR/JPY", jpy: true },
  { symbol: "GBPJPY", label: "GBP/JPY", jpy: true },
];

const TFS = ["D1", "H4", "H1", "M15", "M5"];

const state = {
  signals: [],
  trades: [],
  prices: {},   // { SYMBOL: { TF: [candles] } }
  meta: {},
  currentPair: "EURUSD",
  currentTF: "H1",
  chart: null,
  candleSeries: null,
};

// ── Init ────────────────────────────────────────────────────────────────
window.addEventListener("load", () => {
  setTimeout(hideSplash, 1500);
});

function hideSplash() {
  document.getElementById("splash").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  init();
}

async function init() {
  setupNav();
  populatePairSelects();
  await loadAll();
  renderDashboard();
  renderMarkets();
  renderJournal();
  renderSettings();
  initChart();
  document.getElementById("refreshBtn").addEventListener("click", async () => {
    const btn = document.getElementById("refreshBtn");
    btn.querySelector("i").classList.add("fa-spin");
    await loadAll();
    renderDashboard(); renderMarkets(); renderJournal(); renderSettings(); refreshChart();
    btn.querySelector("i").classList.remove("fa-spin");
    showToast("Data refreshed");
  });
  // Auto refresh every 5 min
  setInterval(async () => { await loadAll(); renderDashboard(); renderMarkets(); }, 5*60*1000);
}

// ── Navigation ──────────────────────────────────────────────────────────
function setupNav() {
  document.querySelectorAll(".nav-btn").forEach(btn => {
    btn.addEventListener("click", e => {
      const page = btn.dataset.page;
      if (!page) return;
      document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
      // center logo button -> dashboard
      if (!btn.classList.contains("center-btn")) btn.classList.add("active");
      else document.querySelector('.nav-btn[data-page="dashboard"]').classList.add("active");
      document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
      document.getElementById(`page-${page}`).classList.add("active");
      if (page === "markets") setTimeout(() => refreshChart(), 100);
    });
  });
  document.getElementById("centerLogoBtn").addEventListener("click", () => {
    document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
    document.querySelector('.nav-btn[data-page="dashboard"]').classList.add("active");
    document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
    document.getElementById("page-dashboard").classList.add("active");
  });
  document.querySelectorAll(".tf-pills button").forEach(b => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".tf-pills button").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      state.currentTF = b.dataset.tf;
      refreshChart();
    });
  });
}

function populatePairSelects() {
  const opts = PAIRS.map(p => `<option value="${p.symbol}">${p.label}</option>`).join("");
  document.getElementById("chartPair").innerHTML = opts;
  document.getElementById("chartPair").addEventListener("change", e => {
    state.currentPair = e.target.value;
    refreshChart();
  });
}

// ── Data loading ────────────────────────────────────────────────────────
async function fetchJSON(path, fallback) {
  try {
    const cb = Math.floor(Date.now() / (1000*60*5));
    const r = await fetch(`${DATA_BASE}/${path}?t=${cb}`);
    if (!r.ok) throw new Error("HTTP "+r.status);
    return await r.json();
  } catch(e) { return fallback; }
}

async function loadAll() {
  const [sig, trad] = await Promise.all([
    fetchJSON("data/signals/signals.json", {signals:[], meta:{}}),
    fetchJSON("data/trades/trades.json", {trades:[]}),
  ]);
  state.signals = sig.signals || [];
  state.trades = trad.trades || [];
  state.meta = sig.meta || {};

  // Load prices for all pairs & TFs (for ticker + pair tiles)
  const loadPromises = [];
  for (const p of PAIRS) {
    state.prices[p.symbol] = state.prices[p.symbol] || {};
    for (const tf of TFS) {
      loadPromises.push((async () => {
        const d = await fetchJSON(`data/prices/${p.symbol}-${tf}.json`, null);
        if (d?.candles) state.prices[p.symbol][tf] = d.candles;
      })());
    }
  }
  await Promise.all(loadPromises);
  renderTicker();
}

// ── Ticker ──────────────────────────────────────────────────────────────
function renderTicker() {
  const strip = document.getElementById("tickerStrip");
  const items = PAIRS.map(p => {
    const h1 = state.prices[p.symbol]?.H1 || [];
    if (h1.length < 2) return "";
    const cur = h1.at(-1).close, prev = h1.at(-2).close;
    const chg = cur - prev;
    const chgPct = (chg/prev)*100;
    const up = chg >= 0;
    const digits = p.jpy ? 3 : 5;
    return `<div class="ticker-item"><span class="sym">${p.label}</span>
      <span class="px">${cur.toFixed(digits)}</span>
      <span class="chg ${up?'up':'down'}">${up?'+':''}${chgPct.toFixed(2)}%</span></div>`;
  }).join("");
  // Duplicate for seamless scroll
  strip.innerHTML = `<div class="ticker-inner">${items}${items}</div>`;
}

// ── Dashboard ───────────────────────────────────────────────────────────
function renderDashboard() {
  const active = state.signals.filter(s => s.status !== "CLOSED");
  document.getElementById("sigCount").textContent = active.length;
  document.getElementById("h-active").textContent = active.length;
  document.getElementById("h-quality").textContent = active.length
    ? Math.round(active.reduce((s,x)=>s+(x.dataQuality||0),0)/active.length) + "%"
    : "—";

  const status = active.length
    ? `${active.length} live setup${active.length>1?'s':''} across ${new Set(active.map(s=>s.pair)).size} pairs`
    : "No setups at this time — patience is profitable.";
  document.getElementById("heroStatus").textContent = status;

  const list = document.getElementById("signalsList");
  if (!active.length) {
    list.innerHTML = `<div class="no-signals">
      <i class="fa-solid fa-mountain-sun"></i>
      <h3>No active signals right now</h3>
      <p style="font-size:12px;color:var(--text-mute);margin-top:6px">The market isn't giving a high-confluence setup. Wait for the edge.</p></div>`;
    return;
  }
  list.innerHTML = active.map(s => signalCardHTML(s)).join("");
  // Wire up "see reasons"
  list.querySelectorAll(".sig-reasons-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const r = btn.closest(".signal-card").querySelector(".sig-reasons");
      r.classList.toggle("open");
      btn.textContent = r.classList.contains("open") ? "Hide reasons ▲" : "See reasons ▼";
    });
  });
}

function signalCardHTML(s) {
  const p = PAIRS.find(x => x.symbol === s.pair) || PAIRS[0];
  const d = p.jpy ? 3 : 5;
  const tp1 = s.takeProfitLevels?.[0]?.level ?? s.takeProfit;
  return `<div class="signal-card ${s.signal==='BUY'?'buy':'sell'}">
    <div class="sig-head">
      <div class="sig-pair">${s.pair}</div>
      <div class="sig-dir ${s.signal==='BUY'?'buy':'sell'}">${s.signal}</div>
    </div>
    <div class="sig-levels">
      <div class="lvl entry"><div class="lvl-l">Entry</div><div class="lvl-v">${s.entry.toFixed(d)}</div></div>
      <div class="lvl sl"><div class="lvl-l">Stop</div><div class="lvl-v">${s.stopLoss.toFixed(d)}</div></div>
      <div class="lvl tp"><div class="lvl-l">Target</div><div class="lvl-v">${tp1.toFixed(d)}</div></div>
    </div>
    <div class="sig-meta">
      <span><i class="fa-regular fa-clock"></i> ${s.entryTF}</span>
      <span class="sig-rr">1:${s.riskReward?.toFixed(2) ?? '—'}</span>
      <span>Quality ${s.dataQuality ?? '—'}%</span>
    </div>
    <div class="strength-bar"><div class="strength-fill" style="width:${s.strength}%"></div></div>
    <div class="sig-footer">
      <span>Strength <span class="sig-strength-num">${s.strength}/100</span> <span style="color:var(--text-mute)">(confluence)</span></span>
      <button class="sig-reasons-btn">See reasons ▼</button>
    </div>
    <div class="sig-reasons"><ul>${(s.reasons||[]).map(r=>`<li>${r}</li>`).join("")}</ul>
      <div style="margin-top:8px;font-size:10px;color:var(--text-mute);font-family:'Inter',monospace">v${s.strategyVersion} · ${new Date(s.timestamp).toLocaleString()}</div>
    </div>
  </div>`;
}

// ── Markets ─────────────────────────────────────────────────────────────
function renderMarkets() {
  const grid = document.getElementById("pairGrid");
  const active = state.signals.filter(s => s.status !== "CLOSED");
  grid.innerHTML = PAIRS.map(p => {
    const h1 = state.prices[p.symbol]?.H1 || [];
    if (!h1.length) {
      return `<div class="pair-tile"><div class="pt-label">Pair</div><div class="pt-sym">${p.label}</div><div class="pt-price" style="color:var(--text-mute);font-size:14px">Loading…</div></div>`;
    }
    const last = h1.at(-1).close;
    // 24-bar change
    const prev = h1.length > 24 ? h1.at(-25).close : h1[0].close;
    const chgPct = ((last-prev)/prev)*100;
    const up = chgPct >= 0;
    const sig = active.find(s => s.pair === p.symbol);
    // Multi-TF bias (simple: recent close direction on each TF)
    const biases = TFS.slice(0,4).map(tf => {
      const c = state.prices[p.symbol]?.[tf] || [];
      if (c.length < 20) return {label:"—",cls:"neut"};
      const cur = c.at(-1).close, pr = c.at(-20).close;
      const diff = (cur-pr)/pr;
      if (diff > 0.001) return {label:tf.replace("1","")+"▲",cls:"bull"};
      if (diff < -0.001) return {label:tf.replace("1","")+"▼",cls:"bear"};
      return {label:tf.replace("1","")+"—",cls:"neut"};
    });
    return `<div class="pair-tile" data-pair="${p.symbol}">
      <div class="pt-label">${p.label}</div>
      <div class="pt-sym">${p.symbol} ${sig ? `<span class="pt-chg ${sig.signal==='BUY'?'up':'down'}">${sig.signal}</span>` : ''}</div>
      <div class="pt-price">${last.toFixed(p.jpy?3:5)}</div>
      <div class="pt-chg ${up?'up':'down'}">${up?'▲':'▼'} ${Math.abs(chgPct).toFixed(2)}%</div>
      <div class="pt-bias-row">${biases.map(b=>`<div class="pt-bias ${b.cls}">${b.label}</div>`).join("")}</div>
    </div>`;
  }).join("");
  // Pair tile click -> switch chart
  grid.querySelectorAll(".pair-tile").forEach(t => {
    t.addEventListener("click", () => {
      state.currentPair = t.dataset.pair;
      document.getElementById("chartPair").value = state.currentPair;
      // Switch to markets/chart view by scrolling to chart
      document.getElementById("page-markets").scrollIntoView({behavior:"smooth"});
      refreshChart();
    });
  });
}

// ── Chart ───────────────────────────────────────────────────────────────
function initChart() {
  const el = document.getElementById("liveChart");
  if (!el || !window.LightweightCharts) return;
  state.chart = LightweightCharts.createChart(el, {
    layout: {
      background: {type:"solid", color:"#0c0f15"},
      textColor: "#8b95a8",
      fontFamily: "'Inter', monospace", fontSize: 10,
    },
    grid: {
      vertLines: { color: "rgba(35,42,58,0.5)" },
      horzLines: { color: "rgba(35,42,58,0.5)" },
    },
    rightPriceScale: { borderColor: "#232a3a" },
    timeScale: { borderColor: "#232a3a", timeVisible: true, secondsVisible: false },
    width: el.clientWidth, height: 320,
  });
  state.candleSeries = state.chart.addCandlestickSeries({
    upColor:"#22c55e", downColor:"#ef4545",
    borderUpColor:"#22c55e", borderDownColor:"#ef4545",
    wickUpColor:"#22c55e", wickDownColor:"#ef4545",
  });
  window.addEventListener("resize", () => {
    state.chart?.applyOptions({width: el.clientWidth});
  });
}

function refreshChart() {
  if (!state.candleSeries) return;
  const c = state.prices[state.currentPair]?.[state.currentTF] || [];
  if (!c.length) {
    document.getElementById("chartInfo").textContent = "No data yet. Wait for next sync.";
    return;
  }
  state.candleSeries.setData(c.map(x => ({time:x.time,open:x.open,high:x.high,low:x.low,close:x.close})));
  state.chart.timeScale().fitContent();
  const last = c.at(-1);
  const pair = PAIRS.find(p=>p.symbol===state.currentPair);
  const d = pair?.jpy?3:5;
  const sig = state.signals.find(s=>s.pair===state.currentPair&&s.status!=='CLOSED');
  document.getElementById("chartInfo").innerHTML =
    `<strong>${state.currentPair}</strong> ${state.currentTF} | O ${last.open.toFixed(d)} H ${last.high.toFixed(d)} L ${last.low.toFixed(d)} C <strong>${last.close.toFixed(d)}</strong>
    ${sig?` | <span style="color:var(--${sig.signal==='BUY'?'green':'red'})">${sig.signal} @ ${sig.entry.toFixed(d)}</span>`:''}
    | ${c.length} bars loaded`;
}

// ── Journal ─────────────────────────────────────────────────────────────
function renderJournal() {
  const stats = calcStats(state.trades);
  document.getElementById("journalStats").innerHTML = `
    <div class="stat-card"><div class="sv">${stats.total}</div><div class="sl">Trades</div></div>
    <div class="stat-card"><div class="sv ${stats.winrate>=50?'pos':'neg'}">${stats.winrate}%</div><div class="sl">Win Rate</div></div>
    <div class="stat-card"><div class="sv ${stats.pf>=1?'pos':'neg'}">${stats.pf}</div><div class="sl">Profit Factor</div></div>
    <div class="stat-card"><div class="sv ${stats.pips>=0?'pos':'neg'}">${stats.pips>0?'+':''}${stats.pips.toFixed(0)}</div><div class="sl">Pips</div></div>
  `;
  const tl = document.getElementById("tradeList");
  if (!state.trades.length) {
    tl.innerHTML = `<div class="empty-journal"><i class="fa-solid fa-book-open"></i>
      <div style="font-size:14px;color:var(--text-dim);font-weight:600">No closed trades yet</div>
      <p style="font-size:11px;color:var(--text-mute);margin-top:6px;max-width:250px">As signals hit TP or SL, log them here. Your stats will build over time.</p></div>`;
    return;
  }
  tl.innerHTML = state.trades.slice().reverse().map(t => {
    const isWin = t.result === "WIN";
    return `<div class="trade-row">
      <div class="trade-icon ${isWin?'win':'loss'}"><i class="fa-solid ${isWin?'fa-trophy':'fa-xmark'}"></i></div>
      <div class="trade-meta"><div class="t-pair">${t.pair || "—"} · ${t.result}</div>
        <div class="t-date">${t.closedAt ? new Date(t.closedAt).toLocaleDateString() : ""}</div></div>
      <div class="trade-result">
        <div class="t-pips ${isWin?'win':'loss'}">${isWin?'+':'-'}${Math.abs(t.pips||0).toFixed(0)}</div>
        <div class="t-rr">${isWin ? '1:'+ (t.rr||'—') +'R' : '1R'}</div>
      </div>
    </div>`;
  }).join("");
}

function calcStats(trades) {
  if (!trades.length) return {total:0, winrate:"—", pf:"—", pips:0};
  const wins = trades.filter(t=>t.result==="WIN").length;
  const losses = trades.filter(t=>t.result==="LOSS").length;
  const total = wins+losses;
  const winrate = total?Math.round(wins/total*100):0;
  const totalWinR = trades.filter(t=>t.result==="WIN").reduce((s,t)=>s+(t.rr||1),0);
  const pf = losses? (totalWinR/losses).toFixed(2) : (wins?"∞":"—");
  const pips = trades.reduce((s,t)=>s+((t.pips||0)*(t.result==="LOSS"?-1:1)),0);
  return {total:wins+losses+trades.filter(t=>t.result==="BREAKEVEN").length, winrate, pf, pips};
}

// ── Settings ────────────────────────────────────────────────────────────
function renderSettings() {
  document.getElementById("s-version").textContent = state.meta.strategyVersion || "1.0.0";
  document.getElementById("s-lastupdate").textContent = state.meta.lastUpdated ? new Date(state.meta.lastUpdated).toLocaleString() : "—";
}

// ── Toast ───────────────────────────────────────────────────────────────
function showToast(msg) {
  let t = document.querySelector(".toast");
  if (!t) { t = document.createElement("div"); t.className = "toast"; document.body.appendChild(t); }
  t.textContent = msg;
  setTimeout(()=>t.classList.add("show"), 10);
  setTimeout(()=>t.classList.remove("show"), 2200);
}
