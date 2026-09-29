/**
 * Trading Forex with Ndumiso — Mobile App
 *
 * Fixes applied:
 * - Classic script (no type=module) for old Android WebView
 * - No .at() (uses last()/prev() helpers) for older WebViews
 * - Bounded parallel fetch (max 3-4 at once) to avoid connection exhaustion
 * - Dashboard loads first; remaining price TFs lazy-load in background
 * - Lightweight Charts lazy-loaded only when Markets tab opens
 * - Try/catch guards on all renders prevent cascade failures
 * - AbortController 8s timeout on every fetch
 */

const DATA_BASE = "https://perfectndumiso1-netizen.github.io/Forex-Trading-with-Ndumiso";

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

var state = {
  signals: [],
  trades: [],
  prices: {},
  meta: {},
  currentPair: "EURUSD",
  currentTF: "H1",
  chart: null,
  candleSeries: null,
  pricesLoaded: false,
  chartLibLoaded: false,
};

function last(arr) { return arr && arr.length ? arr[arr.length - 1] : null; }
function prevN(arr, n) { return arr && arr.length > n ? arr[arr.length - 1 - n] : (arr && arr.length ? arr[0] : null); }
function fmt(n, d) { return (typeof n === 'number' && isFinite(n)) ? n.toFixed(d) : '—'; }

window.addEventListener("load", function() {
  setTimeout(hideSplash, 1200);
});

function hideSplash() {
  var s = document.getElementById("splash");
  var a = document.getElementById("app");
  if (s) s.classList.add("hidden");
  if (a) a.classList.remove("hidden");
  init();
}

async function init() {
  try {
    setupNav();
    populatePairSelects();
    await loadCore();
    renderDashboard();
    renderJournal();
    renderSettings();
    setTimeout(loadAllPrices, 300);
    var rb = document.getElementById("refreshBtn");
    if (rb) rb.addEventListener("click", refreshAll);
    setInterval(function() { loadAll().then(function(){ renderDashboard(); renderMarkets(); }).catch(function(){}); }, 5*60*1000);
  } catch(e) { console.error("init error", e); }
}

async function refreshAll() {
  var btn = document.getElementById("refreshBtn");
  var ic = btn.querySelector("i");
  ic.classList.add("fa-spin");
  try { await loadAll(); renderDashboard(); renderMarkets(); renderJournal(); renderSettings(); refreshChart(); showToast("Data refreshed"); }
  catch(e) { showToast("Refresh failed"); }
  ic.classList.remove("fa-spin");
}

function setupNav() {
  var btns = document.querySelectorAll(".nav-btn");
  for (var i = 0; i < btns.length; i++) {
    btns[i].addEventListener("click", function() {
      var page = this.dataset.page;
      if (!page) return;
      var all = document.querySelectorAll(".nav-btn");
      for (var j = 0; j < all.length; j++) all[j].classList.remove("active");
      if (!this.classList.contains("center-btn")) this.classList.add("active");
      else document.querySelector('.nav-btn[data-page="dashboard"]').classList.add("active");
      var pages = document.querySelectorAll(".page");
      for (var k = 0; k < pages.length; k++) pages[k].classList.remove("active");
      var pg = document.getElementById("page-" + page);
      if (pg) pg.classList.add("active");
      if (page === "markets") {
        ensureChartLib().then(function() { renderMarkets(); setTimeout(refreshChart, 200); });
      }
    });
  }
  var cl = document.getElementById("centerLogoBtn");
  if (cl) cl.addEventListener("click", function() {
    var all = document.querySelectorAll(".nav-btn");
    for (var j = 0; j < all.length; j++) all[j].classList.remove("active");
    document.querySelector('.nav-btn[data-page="dashboard"]').classList.add("active");
    var pages = document.querySelectorAll(".page");
    for (var k = 0; k < pages.length; k++) pages[k].classList.remove("active");
    var pg = document.getElementById("page-dashboard");
    if (pg) pg.classList.add("active");
  });
  var tfBtns = document.querySelectorAll(".tf-pills button");
  for (var m = 0; m < tfBtns.length; m++) {
    tfBtns[m].addEventListener("click", function() {
      var others = document.querySelectorAll(".tf-pills button");
      for (var n = 0; n < others.length; n++) others[n].classList.remove("active");
      this.classList.add("active");
      state.currentTF = this.dataset.tf;
      refreshChart();
    });
  }
}

function populatePairSelects() {
  var sel = document.getElementById("chartPair");
  if (!sel) return;
  var opts = "";
  for (var i = 0; i < PAIRS.length; i++) opts += '<option value="' + PAIRS[i].symbol + '">' + PAIRS[i].label + '</option>';
  sel.innerHTML = opts;
  sel.addEventListener("change", function(e) { state.currentPair = e.target.value; refreshChart(); });
}

async function fetchJSON(path, fallback) {
  try {
    var cb = Math.floor(Date.now() / (1000*60*5));
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var to = ctl ? setTimeout(function(){ try{ ctl.abort(); }catch(e){} }, 8000) : null;
    var r = await fetch(DATA_BASE + "/" + path + "?t=" + cb, ctl ? {signal: ctl.signal} : {});
    if (to) clearTimeout(to);
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } catch(e) { return fallback; }
}

async function boundedMap(items, fn, concurrency) {
  var results = new Array(items.length);
  var idx = 0;
  async function worker() {
    while (true) {
      var i = idx++;
      if (i >= items.length) return;
      try { results[i] = await fn(items[i], i); } catch(e) { results[i] = null; }
    }
  }
  var workers = [];
  for (var w = 0; w < concurrency; w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

async function loadCore() {
  var sig = await fetchJSON("data/signals/signals.json", {signals:[], meta:{}});
  var trad = await fetchJSON("data/trades/trades.json", {trades:[]});
  state.signals = (sig && sig.signals) || [];
  state.trades = (trad && trad.trades) || [];
  state.meta = (sig && sig.meta) || {};
  await boundedMap(PAIRS, function(p) {
    return (async function() {
      if (!state.prices[p.symbol]) state.prices[p.symbol] = {};
      var d = await fetchJSON("data/prices/" + p.symbol + "-H1.json", null);
      if (d && d.candles) state.prices[p.symbol].H1 = d.candles;
    })();
  }, 4);
  renderTicker();
}

async function loadAllPrices() {
  var tasks = [];
  for (var i = 0; i < PAIRS.length; i++) {
    var p = PAIRS[i];
    if (!state.prices[p.symbol]) state.prices[p.symbol] = {};
    for (var j = 0; j < TFS.length; j++) {
      var tf = TFS[j];
      if (!state.prices[p.symbol][tf]) tasks.push({p:p, tf:tf});
    }
  }
  await boundedMap(tasks, function(t) {
    return (async function() {
      var d = await fetchJSON("data/prices/" + t.p.symbol + "-" + t.tf + ".json", null);
      if (d && d.candles) state.prices[t.p.symbol][t.tf] = d.candles;
    })();
  }, 3);
  state.pricesLoaded = true;
  renderMarkets();
}

async function loadAll() {
  await loadCore();
  await loadAllPrices();
}

function renderTicker() {
  try {
    var strip = document.getElementById("tickerStrip");
    if (!strip) return;
    var html = "";
    for (var i = 0; i < PAIRS.length; i++) {
      var p = PAIRS[i];
      var h1 = (state.prices[p.symbol] || {}).H1 || [];
      if (h1.length < 2) continue;
      var cur = last(h1).close;
      var pr = prevN(h1, 1).close;
      if (!isFinite(cur) || !isFinite(pr) || pr === 0) continue;
      var chgPct = ((cur - pr) / pr) * 100;
      var up = chgPct >= 0;
      var digits = p.jpy ? 3 : 5;
      html += '<div class="ticker-item"><span class="sym">' + p.label + '</span>';
      html += '<span class="px">' + cur.toFixed(digits) + '</span>';
      html += '<span class="chg ' + (up?'up':'down') + '">' + (up?'+':'') + chgPct.toFixed(2) + '%</span></div>';
    }
    strip.innerHTML = '<div class="ticker-inner">' + html + html + '</div>';
  } catch(e) { console.error("ticker", e); }
}

// Return true if a signal is verified/live (never demo/mock/absurd-distance)
function isVerifiedLive(s) {
  if (!s) return false;
  if (s.status === "CLOSED") return false;
  if (s.provider === "demo") return false;
  if (s.id && (s.id + "").indexOf("demo-") === 0) return false;
  if (s._note && /demo|mock/i.test(s._note)) return false;
  // Reject absurd SL distances (defense against any corrupted signal reaching frontend)
  if (s.entry && s.stopLoss) {
    var isJpy = s.pair && s.pair.indexOf("JPY") >= 0;
    var pip = isJpy ? 0.01 : 0.0001;
    var pips = Math.abs(s.entry - s.stopLoss) / pip;
    if (pips < 5 || pips > 500) return false;
  }
  return true;
}

function renderDashboard() {
  try {
    var active = [];
    for (var i = 0; i < state.signals.length; i++) {
      if (isVerifiedLive(state.signals[i])) active.push(state.signals[i]);
    }
    var sc = document.getElementById("sigCount");
    var ha = document.getElementById("h-active");
    if (sc) sc.textContent = active.length;
    if (ha) ha.textContent = active.length;
    var hq = document.getElementById("h-quality");
    if (hq) {
      if (active.length) {
        var sum = 0;
        for (var k = 0; k < active.length; k++) sum += (active[k].dataQuality || 0);
        hq.textContent = Math.round(sum/active.length) + "%";
      } else hq.textContent = "—";
    }
    var hs = document.getElementById("heroStatus");
    if (hs) {
      var pairset = {}; var pc = 0;
      for (var a = 0; a < active.length; a++) { if (!pairset[active[a].pair]) { pairset[active[a].pair]=1; pc++; } }
      hs.textContent = active.length
        ? active.length + " live setup" + (active.length>1?"s":"") + " across " + pc + " pairs"
        : "No setups at this time — patience is profitable.";
    }
    var list = document.getElementById("signalsList");
    if (!list) return;
    if (!active.length) {
      list.innerHTML = '<div class="no-signals"><i class="fa-solid fa-mountain-sun"></i><h3>No active signals right now</h3>' +
        '<p style="font-size:12px;color:var(--text-mute);margin-top:6px">Wait for the edge. No trade is a position.</p></div>';
      return;
    }
    var cards = "";
    for (var c = 0; c < active.length; c++) cards += signalCardHTML(active[c]);
    list.innerHTML = cards;
    var btns = list.querySelectorAll(".sig-reasons-btn");
    for (var b = 0; b < btns.length; b++) {
      btns[b].addEventListener("click", function() {
        var r = this.closest(".signal-card").querySelector(".sig-reasons");
        r.classList.toggle("open");
        this.textContent = r.classList.contains("open") ? "Hide reasons ▲" : "See reasons ▼";
      });
    }
  } catch(e) { console.error("dashboard", e); }
}

function signalCardHTML(s) {
  var p = PAIRS[0];
  for (var i = 0; i < PAIRS.length; i++) if (PAIRS[i].symbol === s.pair) { p = PAIRS[i]; break; }
  var d = p.jpy ? 3 : 5;
  var tp1 = (s.takeProfitLevels && s.takeProfitLevels[0]) ? s.takeProfitLevels[0].level : s.takeProfit;
  var reasons = "";
  if (s.reasons) for (var r = 0; r < s.reasons.length; r++) reasons += "<li>" + s.reasons[r] + "</li>";
  var ts = "";
  try { ts = s.timestamp ? new Date(s.timestamp).toLocaleString() : ""; } catch(e) {}
  return '<div class="signal-card ' + (s.signal==='BUY'?'buy':'sell') + '">' +
    '<div class="sig-head"><div class="sig-pair">' + s.pair + '</div>' +
    '<div class="sig-dir ' + (s.signal==='BUY'?'buy':'sell') + '">' + s.signal + '</div></div>' +
    '<div class="sig-levels">' +
    '<div class="lvl entry"><div class="lvl-l">Entry</div><div class="lvl-v">' + fmt(s.entry,d) + '</div></div>' +
    '<div class="lvl sl"><div class="lvl-l">Stop</div><div class="lvl-v">' + fmt(s.stopLoss,d) + '</div></div>' +
    '<div class="lvl tp"><div class="lvl-l">Target</div><div class="lvl-v">' + fmt(tp1,d) + '</div></div></div>' +
    '<div class="sig-meta"><span><i class="fa-regular fa-clock"></i> ' + (s.entryTF||'—') + '</span>' +
    '<span class="sig-rr">1:' + (s.riskReward ? s.riskReward.toFixed(2) : '—') + '</span>' +
    '<span>Quality ' + (s.dataQuality != null ? s.dataQuality+'%' : '—') + '</span></div>' +
    '<div class="strength-bar"><div class="strength-fill" style="width:' + (s.strength||0) + '%"></div></div>' +
    '<div class="sig-footer"><span>Strength <span class="sig-strength-num">' + (s.strength||0) + '/100</span> <span style="color:var(--text-mute)">(confluence)</span></span>' +
    '<button class="sig-reasons-btn">See reasons ▼</button></div>' +
    '<div class="sig-reasons"><ul>' + reasons + '</ul>' +
    '<div style="margin-top:8px;font-size:10px;color:var(--text-mute);font-family:monospace">v' + (s.strategyVersion||'?') + ' · ' + ts + '</div></div></div>';
}

function renderMarkets() {
  try {
    var grid = document.getElementById("pairGrid");
    if (!grid) return;
    var active = [];
    for (var i = 0; i < state.signals.length; i++) if (isVerifiedLive(state.signals[i])) active.push(state.signals[i]);
    var html = "";
    for (var pi = 0; pi < PAIRS.length; pi++) {
      var p = PAIRS[pi];
      var h1 = (state.prices[p.symbol] || {}).H1 || [];
      if (!h1.length) {
        html += '<div class="pair-tile"><div class="pt-label">Pair</div><div class="pt-sym">' + p.label + '</div>' +
          '<div class="pt-price" style="color:var(--text-mute);font-size:14px">Loading…</div></div>';
        continue;
      }
      var lastPrice = last(h1).close;
      var refIdx = h1.length > 24 ? h1.length - 25 : 0;
      var chgPct = ((lastPrice - h1[refIdx].close) / h1[refIdx].close) * 100;
      var up = chgPct >= 0;
      var sig = null;
      for (var s = 0; s < active.length; s++) if (active[s].pair === p.symbol) { sig = active[s]; break; }
      var biases = "";
      var tfSlice = ["D1","H4","H1","M15"];
      for (var t = 0; t < tfSlice.length; t++) {
        var tf = tfSlice[t];
        var c = (state.prices[p.symbol] || {})[tf] || [];
        var bLabel = tf.replace("1","");
        var bCls = "neut";
        if (c.length >= 20) {
          var cur = last(c).close;
          var pr = c[c.length-20].close;
          var diff = (cur-pr)/pr;
          if (diff > 0.001) { bCls = "bull"; bLabel += "▲"; }
          else if (diff < -0.001) { bCls = "bear"; bLabel += "▼"; }
          else bLabel += "—";
        } else bLabel += "—";
        biases += '<div class="pt-bias ' + bCls + '">' + bLabel + '</div>';
      }
      html += '<div class="pair-tile" data-pair="' + p.symbol + '">' +
        '<div class="pt-label">' + p.label + '</div>' +
        '<div class="pt-sym">' + p.symbol + (sig ? '<span class="pt-chg ' + (sig.signal==='BUY'?'up':'down') + '">' + sig.signal + '</span>' : '') + '</div>' +
        '<div class="pt-price">' + lastPrice.toFixed(p.jpy?3:5) + '</div>' +
        '<div class="pt-chg ' + (up?'up':'down') + '">' + (up?'▲':'▼') + ' ' + Math.abs(chgPct).toFixed(2) + '%</div>' +
        '<div class="pt-bias-row">' + biases + '</div></div>';
    }
    grid.innerHTML = html;
    var tiles = grid.querySelectorAll(".pair-tile");
    for (var ti = 0; ti < tiles.length; ti++) {
      tiles[ti].addEventListener("click", function() {
        state.currentPair = this.dataset.pair;
        var sel = document.getElementById("chartPair");
        if (sel) sel.value = state.currentPair;
        refreshChart();
      });
    }
  } catch(e) { console.error("markets", e); }
}

function ensureChartLib() {
  if (state.chartLibLoaded) return Promise.resolve();
  return new Promise(function(resolve) {
    if (window.LightweightCharts) { state.chartLibLoaded = true; resolve(); return; }
    var s = document.createElement("script");
    s.src = "https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js";
    s.onload = function() { state.chartLibLoaded = true; setTimeout(function(){ initChart(); resolve(); }, 50); };
    s.onerror = function() {
      var info = document.getElementById("chartInfo");
      if (info) info.textContent = "Chart library unavailable offline.";
      resolve();
    };
    document.head.appendChild(s);
  });
}

function initChart() {
  try {
    var el = document.getElementById("liveChart");
    if (!el || !window.LightweightCharts || state.chart) return;
    state.chart = LightweightCharts.createChart(el, {
      layout: { background: {type:"solid", color:"#0c0f15"}, textColor: "#8b95a8", fontFamily: "Inter, monospace", fontSize: 10 },
      grid: { vertLines: { color: "rgba(35,42,58,0.5)" }, horzLines: { color: "rgba(35,42,58,0.5)" } },
      rightPriceScale: { borderColor: "#232a3a" },
      timeScale: { borderColor: "#232a3a", timeVisible: true, secondsVisible: false },
      width: el.clientWidth, height: 320,
    });
    state.candleSeries = state.chart.addCandlestickSeries({
      upColor:"#22c55e", downColor:"#ef4545", borderUpColor:"#22c55e", borderDownColor:"#ef4545",
      wickUpColor:"#22c55e", wickDownColor:"#ef4545",
    });
    var rt;
    window.addEventListener("resize", function() {
      clearTimeout(rt);
      rt = setTimeout(function(){ if (state.chart) state.chart.applyOptions({width: el.clientWidth}); }, 200);
    });
  } catch(e) { console.error("initChart", e); }
}

function refreshChart() {
  try {
    if (!state.candleSeries) return;
    var pd = state.prices[state.currentPair] || {};
    var c = pd[state.currentTF] || [];
    var info = document.getElementById("chartInfo");
    if (!c.length) { if (info) info.textContent = "No data for " + state.currentPair + " " + state.currentTF + ". Tap refresh."; return; }
    var data = [];
    for (var i = 0; i < c.length; i++) {
      var x = c[i];
      data.push({time:x.time, open:x.open, high:x.high, low:x.low, close:x.close});
    }
    state.candleSeries.setData(data);
    state.chart.timeScale().fitContent();
    var pair = null;
    for (var p = 0; p < PAIRS.length; p++) if (PAIRS[p].symbol === state.currentPair) { pair = PAIRS[p]; break; }
    var digits = pair ? (pair.jpy ? 3 : 5) : 5;
    var lc = last(c);
    var sig = null;
    for (var s = 0; s < state.signals.length; s++) {
      if (state.signals[s].pair === state.currentPair && isVerifiedLive(state.signals[s])) { sig = state.signals[s]; break; }
    }
    var infoHtml = '<strong>' + state.currentPair + '</strong> ' + state.currentTF +
      ' | O ' + lc.open.toFixed(digits) + ' H ' + lc.high.toFixed(digits) + ' L ' + lc.low.toFixed(digits) +
      ' C <strong>' + lc.close.toFixed(digits) + '</strong>';
    if (sig) infoHtml += ' | <span style="color:var(' + (sig.signal==='BUY'?'green':'red') + ')">' + sig.signal + ' @ ' + fmt(sig.entry,digits) + '</span>';
    infoHtml += ' | ' + c.length + ' bars';
    if (info) info.innerHTML = infoHtml;
  } catch(e) { console.error("refreshChart", e); }
}

function renderJournal() {
  try {
    var stats = calcStats(state.trades);
    var js = document.getElementById("journalStats");
    if (js) {
      js.innerHTML =
        '<div class="stat-card"><div class="sv">' + stats.total + '</div><div class="sl">Trades</div></div>' +
        '<div class="stat-card"><div class="sv ' + (stats.winrate>=50?'pos':'neg') + '">' + stats.winrate + '%</div><div class="sl">Win Rate</div></div>' +
        '<div class="stat-card"><div class="sv ' + (stats.pf>=1?'pos':'neg') + '">' + stats.pf + '</div><div class="sl">Profit Factor</div></div>' +
        '<div class="stat-card"><div class="sv ' + (stats.pips>=0?'pos':'neg') + '">' + (stats.pips>0?'+':'') + stats.pips.toFixed(0) + '</div><div class="sl">Pips</div></div>';
    }
    var tl = document.getElementById("tradeList");
    if (!tl) return;
    if (!state.trades.length) {
      tl.innerHTML = '<div class="empty-journal"><i class="fa-solid fa-book-open"></i>' +
        '<div style="font-size:14px;color:var(--text-dim);font-weight:600">No closed trades yet</div>' +
        '<p style="font-size:11px;color:var(--text-mute);margin-top:6px;max-width:250px">Stats build as you close trades.</p></div>';
      return;
    }
    var reversed = state.trades.slice().reverse();
    var html = "";
    for (var i = 0; i < reversed.length; i++) {
      var t = reversed[i];
      var isWin = t.result === "WIN";
      var dt = "";
      try { dt = t.closedAt ? new Date(t.closedAt).toLocaleDateString() : ""; } catch(e) {}
      html += '<div class="trade-row"><div class="trade-icon ' + (isWin?'win':'loss') + '"><i class="fa-solid ' + (isWin?'fa-trophy':'fa-xmark') + '"></i></div>' +
        '<div class="trade-meta"><div class="t-pair">' + (t.pair||"—") + ' · ' + t.result + '</div>' +
        '<div class="t-date">' + dt + '</div></div>' +
        '<div class="trade-result"><div class="t-pips ' + (isWin?'win':'loss') + '">' + (isWin?'+':'-') + Math.abs(t.pips||0).toFixed(0) + '</div>' +
        '<div class="t-rr">' + (isWin ? '1:'+(t.rr||'—')+'R' : '1R') + '</div></div></div>';
    }
    tl.innerHTML = html;
  } catch(e) { console.error("journal", e); }
}

function calcStats(trades) {
  if (!trades || !trades.length) return {total:0, winrate:"—", pf:"—", pips:0};
  var wins=0, losses=0, be=0, totalWinR=0, pips=0;
  for (var i = 0; i < trades.length; i++) {
    var t = trades[i];
    if (t.result === "WIN") { wins++; totalWinR += (t.rr||1); pips += (t.pips||0); }
    else if (t.result === "LOSS") { losses++; pips -= (t.pips||0); }
    else be++;
  }
  var total = wins+losses;
  var winrate = total ? Math.round(wins/total*100) : 0;
  var pf = losses ? (totalWinR/losses).toFixed(2) : (wins ? "∞" : "—");
  return {total: wins+losses+be, winrate:winrate, pf:pf, pips:pips};
}

function renderSettings() {
  try {
    var sv = document.getElementById("s-version");
    var sl = document.getElementById("s-lastupdate");
    if (sv) sv.textContent = state.meta.strategyVersion || "1.0.1";
    if (sl) sl.textContent = state.meta.lastUpdated ? new Date(state.meta.lastUpdated).toLocaleString() : "—";
  } catch(e) {}
}

function showToast(msg) {
  try {
    var t = document.querySelector(".toast");
    if (!t) { t = document.createElement("div"); t.className = "toast"; document.body.appendChild(t); }
    t.textContent = msg;
    setTimeout(function(){ t.classList.add("show"); }, 10);
    setTimeout(function(){ t.classList.remove("show"); }, 2200);
  } catch(e) {}
}

// ═══════════════════════════════════════════════════════════════════════
// LIVE CHART — TradingView widget (primary) + Lightweight Charts (cached)
// ═══════════════════════════════════════════════════════════════════════
var TV_SYMBOLS = {
  EURUSD:"FX:EURUSD", GBPUSD:"FX:GBPUSD", USDJPY:"FX:USDJPY", USDCHF:"FX:USDCHF",
  AUDUSD:"FX:AUDUSD", USDCAD:"FX:USDCAD", NZDUSD:"FX:NZDUSD", EURGBP:"FX:EURGBP",
  EURJPY:"FX:EURJPY", GBPJPY:"FX:GBPJPY"
};
var tvInterval = "60";
var chartSource = "live";

function loadTVChart() {
  var sym = TV_SYMBOLS[state.currentPair] || "FX:" + state.currentPair;
  var frame = document.getElementById("tvFrame");
  if (!frame) return;
  var url = "https://s.tradingview.com/widgetembed/?" +
    "symbol=" + encodeURIComponent(sym) +
    "&interval=" + tvInterval +
    "&hidesidetoolbar=1&hideideas=1&theme=dark&style=1&timezone=Etc/UTC" +
    "&studies=[]&withdateranges=1&allow_symbol_change=0&save_image=0&locale=en";
  frame.src = url;
  document.getElementById("tvChart").style.display = "block";
  var lw = document.getElementById("liveChart");
  if (lw) lw.style.display = "none";
}

function switchChartSource(src) {
  chartSource = src;
  document.getElementById("srcLive").classList.toggle("active", src === "live");
  document.getElementById("srcCached").classList.toggle("active", src === "cached");
  var label = document.getElementById("chartSource");
  if (label) label.textContent = (src === "live") ? "TradingView" : "Cached";
  var tv = document.getElementById("tvChart");
  var lw = document.getElementById("liveChart");
  if (src === "live") {
    tv.style.display = "block"; lw.style.display = "none"; loadTVChart();
  } else {
    tv.style.display = "none"; lw.style.display = "block";
    if (state.chartLibLoaded) refreshChart();
    else ensureChartLib().then(refreshChart);
  }
}

// Hook chart-pair / TF changes to refresh TV too
function hookChartUI() {
  var sel = document.getElementById("chartPair");
  if (sel) sel.addEventListener("change", function() { if (chartSource === "live") loadTVChart(); });
  var pills = document.querySelectorAll(".tf-pills button");
  for (var i=0;i<pills.length;i++) {
    pills[i].addEventListener("click", function() {
      tvInterval = this.getAttribute("data-tv") || "60";
      if (chartSource === "live") setTimeout(loadTVChart, 50);
    });
  }
  var live = document.getElementById("srcLive");
  var cached = document.getElementById("srcCached");
  if (live) live.addEventListener("click", function(){ switchChartSource("live"); });
  if (cached) cached.addEventListener("click", function(){ switchChartSource("cached"); });
}

// Call loadTVChart on first Markets view (defer until TV iframe is in DOM)
var _origSetupNav = window.setupNav;
document.addEventListener("DOMContentLoaded", function(){
  hookChartUI();
  initAcademy();
  setTimeout(function(){ if (chartSource === "live") loadTVChart(); }, 500);
});

// Override Markets tab open to load TV
var _origNavHandlersInstalled = false;
setTimeout(function(){
  var navBtns = document.querySelectorAll(".nav-btn");
  for (var i=0;i<navBtns.length;i++) {
    navBtns[i].addEventListener("click", function() {
      if (this.dataset.page === "markets") {
        setTimeout(function(){ if (chartSource === "live") loadTVChart(); }, 200);
      }
    });
  }
}, 300);

// ═══════════════════════════════════════════════════════════════════════
// FOREX ACADEMY — expanded bilingual course (modules → lessons)
// ═══════════════════════════════════════════════════════════════════════
var EDU = {};
// Education course content: English + isiZulu.  8 modules, multiple lessons each.
EDU = {
  en: {
    title: "Forex Trading — Complete Course",
    subtitle: "A step-by-step guide for Ndumiso's traders",
    modules: [
      {
        id: "m1", icon: "fa-globe", title: "Module 1: What is Forex?", sub: "The world's largest financial market",
        lessons: [
          {
            id: "m1-l1", title: "1.1 Definition & Scale",
            body: `<p><strong>Forex (FX)</strong> is short for <em>foreign exchange</em>. It is the global marketplace where national currencies are bought and sold against each other.</p>
<p>It is the <strong>largest and most liquid financial market in the world</strong>, with over <strong>$7.5 trillion traded every day</strong>, according to the Bank for International Settlements. That is more than 30 times the daily volume of every stock market in the world combined.</p>
<h3>Why does Forex exist?</h3>
<ul>
  <li>International trade needs currency conversion (e.g. a South African company buying machinery from Germany needs EUR).</li>
  <li>Investment and speculation — traders profit from exchange-rate movements.</li>
  <li>Central banks use it to manage reserves and stabilise their currency.</li>
</ul>
<div class="lesson-tip"><span class="ex-title">💡 Key idea</span>You are always trading one currency <em>against</em> another. There is no "up" or "down" in isolation — EUR/USD going up means EUR is strengthening <em>relative to</em> USD.</div>`
          },
          {
            id: "m1-l2", title: "1.2 Market Structure & Hours",
            body: `<p>Forex is decentralised (no single exchange). Trading happens <strong>over-the-counter (OTC)</strong> through a global network of banks, brokers, hedge funds, and retail traders.</p>
<h3>24/5 market</h3>
<p>The market opens in Wellington on Monday morning and closes in New York on Friday evening (SAST). Around the clock between those times.</p>
<table><tr><th>Session</th><th>SAST</th><th>Volatility</th></tr>
<tr><td>Sydney / Tokyo (Asia)</td><td>00:00 – 08:00</td><td>Low–medium</td></tr>
<tr><td>London (Europe)</td><td>09:00 – 18:00</td><td>High</td></tr>
<tr><td>New York (Americas)</td><td>15:00 – 00:00</td><td>Highest</td></tr></table>
<p>The <strong>London / New York overlap (15:00 – 18:00 SAST)</strong> is the most liquid, most volatile window of the day. This is the "kill zone" where the major moves tend to occur.</p>
<div class="lesson-example"><span class="ex-title">📊 Worked example</span>EUR/USD often moves 60–100 pips between 15:00 and 18:00 SAST, compared with 20–30 pips during the Asian session. Plan your entries around the high-liquidity window if you day-trade.</div>`
          },
          {
            id: "m1-l3", title: "1.3 Currency Pairs & the Majors",
            body: `<p>Currencies are always quoted in <strong>pairs</strong>. The first currency is the <em>base</em>, the second is the <em>quote</em> (or counter).</p>
<p>Example: <code>EUR/USD = 1.0850</code> means 1 Euro costs 1.0850 US Dollars.</p>
<h4>The 8 major pairs we focus on (plus 2 JPY crosses)</h4>
<ul>
  <li><strong>EUR/USD</strong> — most liquid pair in the world; tightest spreads</li>
  <li><strong>GBP/USD</strong> ("Cable") — volatile; reacts strongly to UK news</li>
  <li><strong>USD/JPY</strong> — sensitive to risk sentiment and US yields</li>
  <li><strong>USD/CHF</strong> — safe-haven flows; often inversely correlated with EUR/USD</li>
  <li><strong>AUD/USD</strong>, <strong>NZDUSD</strong> — commodity currencies (iron ore, dairy)</li>
  <li><strong>USDCAD</strong> — oil-sensitive (Canada exports oil)</li>
  <li><strong>EURGBP</strong>, <strong>EURJPY</strong>, <strong>GBPJPY</strong> — cross-pairs for extra setups</li>
</ul>
<div class="lesson-warn">⚠️ Stick to the pairs the bot scans. Adding random exotic pairs increases risk without improving your edge.</div>`
          },
          {
            id: "m1-l4", title: "1.4 Leverage, Margin & Brokers",
            body: `<p><strong>Leverage</strong> lets you control a large position with a small deposit ("margin"). A 1:100 leverage means R100 of margin controls R10,000 of currency.</p>
<p>Leverage is a <em>double-edged sword</em>: it amplifies both wins and losses.</p>
<div class="lesson-example"><span class="ex-title">📊 Worked example</span>With R1,000 and 1:100 leverage, you can open a R100,000 position. A 1% move against you loses R1,000 (your whole account). With 1:10 leverage, that same 1% move loses R100.</div>
<p>Choose a broker that is <strong>regulated</strong> (FSCA in South Africa, FCA in UK, ASIC in Australia). Never use an unregulated offshore broker offering 1:1000 leverage — they make money when you lose.</p>
<div class="lesson-tip"><span class="ex-title">💡 Ndumiso's rule</span>For a R10,000 account, never exceed 1:50 leverage on a single trade, and never risk more than R100–R200 (1–2%) per setup.</div>`
          }
        ]
      },
      {
        id: "m2", icon: "fa-fire", title: "Module 2: Candlesticks & Price Action", sub: "Reading the language of the market",
        lessons: [
          { id:"m2-l1", title:"2.1 Anatomy of a Candle", body:`<p>A single candlestick shows four prices for a period:</p>
<ul><li><strong>Open</strong> — first price of the period</li><li><strong>High</strong> — highest price reached</li><li><strong>Low</strong> — lowest price reached</li><li><strong>Close</strong> — last price of the period</li></ul>
<p>A <em>bullish</em> candle (green/white) closes above its open. A <em>bearish</em> candle (red/black) closes below its open. The <strong>wicks</strong> (shadows) above and below the body show price extremes that were rejected.</p>
<div class="lesson-tip"><span class="ex-title">💡 Read</span>A long upper wick on a green candle says "buyers tried to push higher and failed." That is a warning — sellers are stepping in.</div>` },
          { id:"m2-l2", title:"2.2 Bullish Reversal Patterns", body:`<h4>Hammer</h4><p>Small body at the top, long lower wick (at least 2× body length). Forms after a downtrend. Signals buyers are stepping in at the lows. High probability setup when it touches a support level.</p>
<h4>Bullish Engulfing</h4><p>A green candle whose body completely <em>engulfs</em> the prior red candle's body. Strong momentum reversal signal when it appears at support.</p>
<h4>Morning Star (3-candle)</h4><p>A long red candle → a small-bodied indecision candle (doji) → a long green candle that closes back into the first candle's body. One of the most reliable reversals.</h4>
<div class="lesson-example"><span class="ex-title">📊 Worked example</span>You see a hammer right on a key support level on H1, AND RSI is below 30 (oversold), AND higher TFs (H4, D1) are in an uptrend. That is high confluence — the kind of setup this bot flags with 70+ strength.</div>` },
          { id:"m2-l3", title:"2.3 Bearish Reversal Patterns", body:`<h4>Shooting Star</h4><p>Mirror of the hammer: small body at the bottom, long upper wick. Forms at resistance in an uptrend. Sellers rejected the highs.</p>
<h4>Bearish Engulfing</h4><p>A red candle whose body completely engulfs the prior green body at resistance. Strong bearish signal.</p>
<h4>Evening Star</h4><p>Mirror of the morning star: long green → doji → long red. Reliable top-reversal.</p>
<h4>Doji</h4><p>Open ≈ close (small cross). Means indecision. After a strong move it can signal exhaustion.</p>
<div class="lesson-warn">⚠️ Do NOT trade candlestick patterns in isolation. A pin bar in the middle of nowhere is noise. Wait for confluence with structure, trend, and indicators.</div>` },
          { id:"m2-l4", title:"2.4 Continuation Patterns", body:`<p>Patterns that suggest the existing trend will continue:</p>
<ul>
  <li><strong>Bullish/Bearish Flag</strong> — a tight channel against the trend (a "rest" before the next leg)</li>
  <li><strong>Pennant / Triangle</strong> — compression of price before breakout</li>
  <li><strong>Three White Soldiers</strong> — three consecutive strong green candles (bullish continuation)</li>
  <li><strong>Three Black Crows</strong> — three consecutive strong red candles (bearish continuation)</li>
</ul>
<p>Continuation patterns are useful for adding to winning positions or for late entries after missing the initial move.</p>` }
        ]
      },
      {
        id: "m3", icon: "fa-layer-group", title: "Module 3: Support, Resistance & Structure", sub: "Reading the market's battle lines",
        lessons: [
          { id:"m3-l1", title:"3.1 Support & Resistance", body:`<p><strong>Support</strong> is a price level where buyers have historically stepped in and pushed price UP — a floor.</p><p><strong>Resistance</strong> is where sellers have stepped in and pushed price DOWN — a ceiling.</p>
<p>Levels form because institutional traders remember price history and place orders there. When broken, levels often <em>flip</em>: broken resistance becomes new support, and vice versa. This is <strong>role reversal</strong>.</p>
<div class="lesson-example"><span class="ex-title">📊 Worked example</span>EUR/USD rallies to 1.0900 four times and sells off each time. The fourth time it breaks through, pulls back, and 1.0900 now acts as support (bounces off it). That's a classic role reversal — now you look for buys at 1.0900.</div>` },
          { id:"m3-l2", title:"3.2 Swing Highs & Swing Lows", body:`<p>A <strong>swing high</strong> is a local peak — a candle whose high is higher than N candles on each side (we use 5 in this bot).</p><p>A <strong>swing low</strong> is the mirror: a local trough.</p><p>The engine marks these automatically. A cluster of swing highs at the same price creates strong resistance; a cluster of swing lows creates strong support.</p>
<p>Round numbers (1.0800, 1.1000, 150.00) are psychological levels — the bot treats these as light support/resistance even without swing points.</p>` },
          { id:"m3-l3", title:"3.3 Trends & HH/HL/LH/LL", body:`<h4>Uptrend (bullish)</h4><p>Price prints <strong>Higher Highs (HH)</strong> and <strong>Higher Lows (HL)</strong>. Each push goes higher; each pullback ends higher than the prior pullback.</p>
<h4>Downtrend (bearish)</h4><p>Price prints <strong>Lower Highs (LH)</strong> and <strong>Lower Lows (LL)</strong>.</p>
<h4>Range / Sideways</h4><p>Price bounces between horizontal support and resistance. Either trade the range or wait for a breakout.</p>
<div class="lesson-tip"><span class="ex-title">🏛️ Multi-timeframe principle</span>Always read structure from D1 down. If D1 is making HH/HL, look ONLY for buy setups on H4/H1/M15. Fighting higher-TF structure is the #1 reason new traders lose.</div>` },
          { id:"m3-l4", title:"3.4 Breakouts & Retests", body:`<p>A <strong>breakout</strong> is when price closes decisively through a support or resistance level (ideally with momentum and volume).</p>
<p>A <strong>retest</strong> is when price returns to test the broken level as its new role (broken resistance becomes support). The safest entries are often on the retest, not the breakout itself — this avoids false breaks ("fakeouts").</p>
<p>This bot has a specific <em>breakout/retest detector</em> that weights these setups higher in confluence scoring.</p>
<div class="lesson-warn">⚠️ A candle wick piercing a level is NOT a breakout. Wait for a <strong>close</strong> beyond the level — ideally two consecutive closes.</div>` }
        ]
      },
      {
        id: "m4", icon: "fa-wave-square", title: "Module 4: Indicators", sub: "EMA, RSI, MACD, ATR — how to read them",
        lessons: [
          { id:"m4-l1", title:"4.1 Moving Averages (EMA/SMA)", body:`<p>Moving averages smooth price data to reveal trend direction. We use four:</p>
<ul>
<li><strong>EMA 9</strong> (fast) — short-term momentum</li>
<li><strong>EMA 21</strong> (slow) — short-term trend</li>
<li><strong>SMA 50</strong> — medium-term trend</li>
<li><strong>SMA 200</strong> — long-term trend (institutional benchmark)</li>
</ul>
<p><strong>Alignment</strong>: when all four MAs point the same direction (e.g. EMA9 > EMA21 > SMA50 > SMA200 and price is above all of them), trend strength is high. We call this "bull stack" / "bear stack".</p>
<p>A <strong>golden cross</strong> = SMA 50 crosses above SMA 200 (long-term bullish). A <strong>death cross</strong> = SMA 50 crosses below SMA 200 (long-term bearish).</p>` },
          { id:"m4-l2", title:"4.2 RSI (Relative Strength Index)", body:`<p>RSI is a momentum oscillator (0–100) measuring how fast price has moved over 14 periods.</p>
<ul>
<li><strong>Above 70</strong> → overbought (possible pullback)</li>
<li><strong>Below 30</strong> → oversold (possible bounce)</li>
<li><strong>Crossing back above 50</strong> from below → bullish momentum confirmation</li>
<li><strong>Crossing back below 50</strong> from above → bearish momentum confirmation</li>
</ul>
<p>In strong trends, RSI can stay overbought/oversold for a long time. Don't trade against the trend just because RSI is at 75.</p>
<div class="lesson-example"><span class="ex-title">📊 Worked example</span>D1 is in a strong uptrend (HH/HL, bull-stack MAs). H1 pulls back to support, RSI hits 28 (oversold), then MACD crosses bullish. That's a high-confluence buy entry — exactly what this bot scans for.</div>` },
          { id:"m4-l3", title:"4.3 MACD (Moving Average Convergence Divergence)", body:`<p>MACD consists of:</p><ul><li>MACD line (fast MA minus slow MA)</li><li>Signal line (MA of MACD)</li><li>Histogram (difference between them)</li></ul>
<p>Interpretation:</p>
<ul>
  <li><strong>Bullish crossover</strong> = MACD line crosses above signal line from below → momentum turning up</li>
  <li><strong>Bearish crossover</strong> = MACD line crosses below signal line → momentum turning down</li>
  <li><strong>Divergence</strong> = price makes a new high but MACD makes a lower high (or vice versa) → momentum fading, possible reversal</li>
</ul>
<p>This bot uses MACD crossovers as <em>entry timing</em> triggers on the confirmation timeframe (H1/M15).</p>` },
          { id:"m4-l4", title:"4.4 ATR (Average True Range)", body:`<p>ATR measures <em>volatility</em> — how much price typically moves in a single bar, averaged over 14 periods.</p>
<p>ATR does NOT predict direction — it measures how <em>big</em> moves are. We use it for three things:</p>
<ol>
<li><strong>Stop-loss distance</strong>: SL = entry ± 1.5 × ATR (so noise doesn't stop us out)</li>
<li><strong>Position sizing</strong>: wider ATR → smaller lot size (same dollar risk)</li>
<li><strong>Volatility regime</strong>: ATR 50% above recent average = "extreme" — the bot avoids trading</li>
</ol>
<div class="lesson-tip"><span class="ex-title">💡 Example</span>If EUR/USD ATR(14) on H1 is 0.0012 (12 pips), a reasonable SL is 1.5 × 0.0012 = 18 pips. If ATR spikes to 0.0030 (30 pips), you're in a news event — stay out.</div>` }
        ]
      },
      {
        id: "m5", icon: "fa-shield-halved", title: "Module 5: Risk Management", sub: "The only rule that keeps you in the game",
        lessons: [
          { id:"m5-l1", title:"5.1 The 1% Rule (why it matters)", body:`<p>Risking 1% of your account per trade means a string of 10 losing trades costs you ~10% of capital. Painful but survivable.</p><p>Risking 5% per trade means 10 losers in a row costs you 40%. Risking 10% and seven losers will wipe you out.</p>
<div class="lesson-example"><span class="ex-title">📊 Math</span>R10,000 account, 1% risk = R100 per trade. With 50% win rate and 1:2 R:R, every 10 trades nets you about R300 on average. You'd need 33 consecutive losses to blow up — statistically almost impossible.</div>
<p>Ndumiso's bot calculates lot size automatically so each trade risks 1% of the configured account balance. Never override this without good reason.</p>` },
          { id:"m5-l2", title:"5.2 Stop-Loss Placement", body:`<p>SL must be placed <strong>where your trade idea is invalidated</strong> — not at an arbitrary dollar amount.</p>
<ul>
  <li>BUY: below the most recent swing low, minus a small buffer (or 1.5 ATR, whichever is farther from entry)</li>
  <li>SELL: above the most recent swing high, plus a small buffer</li>
</ul>
<div class="lesson-warn">⚠️ NEVER move your stop further away when a trade goes against you. That is the single fastest way to destroy an account. If the trade is wrong, it is wrong — accept the loss and move on.</div>` },
          { id:"m5-l3", title:"5.3 Risk-Reward & Why 1:1.5 Is the Floor", body:`<p><strong>Risk-reward (R:R)</strong> = how much you stand to gain for every R1 you risk.</p>
<p>A trade with 30 pip SL and 60 pip TP is a 1:2 risk-reward.</p>
<table><tr><th>R:R</th><th>Win rate needed to break even</th></tr>
<tr><td>1:1</td><td>50%</td></tr>
<tr><td>1:1.5</td><td>40%</td></tr>
<tr><td>1:2</td><td>33%</td></tr>
<tr><td>1:3</td><td>25%</td></tr></table>
<p>The bot <strong>rejects trades below 1:1.5</strong>. At 1:2 you can be wrong 2 out of 3 times and still be profitable.</p>
<div class="lesson-tip"><span class="ex-title">💡 Counter-intuitive truth</span>Letting winners run (trailing stop) has a far bigger effect on P/L than raising your win rate. A single 5R winner pays for five 1R losses.</div>` },
          { id:"m5-l4", title:"5.4 Position-Sizing Formula", body:`<p>The exact formula this bot uses:</p>
<p><code>Lot size = (Account Balance × Risk%) / (Pips at Risk × Pip Value)</code></p>
<div class="lesson-example"><span class="ex-title">📊 Worked example</span>R10,000 account, 1% risk = R100. SL 40 pips on EUR/USD. Pip value per standard lot ≈ $10 (≈ R180).<br/>Lots = R100 / (40 × R18) = R100 / R720 ≈ 0.14 lots. So you trade 0.14 lots. If SL is hit, you lose R100 (1%). If TP1 (1.5R) is hit, you win R150.</div>
<p>Always round down, not up. Never "size up" because you feel confident.</p>` }
        ]
      },
      {
        id: "m6", icon: "fa-arrow-trend-up", title: "Module 6: The Multi-Timeframe Strategy", sub: "How Ndumiso's bot finds setups",
        lessons: [
          { id:"m6-l1", title:"6.1 The Hierarchy (D1 → H4 → H1 → M15)", body:`<p>The bot analyses 5 timeframes in this strict order:</p>
<ol>
  <li><strong>D1</strong> (daily) — major trend and market context. Weight = 4</li>
  <li><strong>H4</strong> (4-hour) — primary trend/structure. Weight = 3</li>
  <li><strong>H1</strong> (1-hour) — setup confirmation. Weight = 2</li>
  <li><strong>M15</strong> (15-min) — entry timing. Weight = 1.5</li>
  <li><strong>M5</strong> (5-min) — optional precision. Weight = 0.8</li>
</ol>
<p>If D1 AND H4 do not agree on direction, there is NO trade. Ever. Fighting the higher-timeframe trend is a losing game.</p>` },
          { id:"m6-l2", title:"6.2 Confluence Scoring (0-100)", body:`<p>Each factor contributes a score. Factors include:</p>
<ul>
  <li>MA alignment on each TF (up to 60 points)</li>
  <li>Trend structure agreement (HH/HL vs LH/LL)</li>
  <li>Momentum (RSI + MACD crossover) — adds 30% of momentum score</li>
  <li>Breakout/retest near support/resistance</li>
  <li>Volatility regime (must be normal, not extreme)</li>
</ul>
<p><strong>Min confluence to emit a signal: 60/100.</strong> Strength is <em>not</em> a win probability — it measures how many independent technical factors agree.</p>
<div class="lesson-tip"><span class="ex-title">🔑 What strength means</span>74 strength ≠ "74% chance of winning." It means 74% of the confluence boxes are ticked. Win probability is a separate thing, determined by your R:R × win-rate over a large sample.</div>` },
          { id:"m6-l3", title:"6.3 Entry Timing & Signal Lifecycle", body:`<p>A signal only fires when:</p>
<ol><li>D1 and H4 agree on direction</li>
<li>H1 or M15 shows a momentum trigger (RSI from oversold/overbought + MACD crossover OR breakout/retest of structure)</li>
<li>SL is placed behind recent structure</li>
<li>TP hits at least 1.5R at nearby opposing structure</li>
<li>ATR is in the "normal" range (not extreme volatility, not dead)</li></ol>
<p>The bot checks for duplicates: if there's already an active signal on the same pair within 4 hours or within 0.5 ATR of the existing entry, it does not fire a duplicate.</p>` },
          { id:"m6-l4", title:"6.4 What the Signal Cards Mean", body:`<table><tr><th>Field</th><th>Meaning</th></tr>
<tr><td>Pair</td><td>EURUSD, GBPUSD, etc.</td></tr>
<tr><td>BUY/SELL</td><td>Direction (BUY = expect up, SELL = expect down)</td></tr>
<tr><td>Entry</td><td>Current market price at signal time (H1 close)</td></tr>
<tr><td>SL</td><td>Stop-loss — price where you exit if wrong</td></tr>
<tr><td>Target (TP1)</td><td>First take-profit level at R:R 1.5+</td></tr>
<tr><td>R:R</td><td>Risk-reward ratio (TP distance ÷ SL distance)</td></tr>
<tr><td>ATR</td><td>Average True Range — volatility measure</td></tr>
<tr><td>Strength (0-100)</td><td>Confluence score, NOT win probability</td></tr>
<tr><td>Quality %</td><td>Data freshness/completeness/validation score</td></tr></table>` }
        ]
      },
      {
        id: "m7", icon: "fa-brain", title: "Module 7: Trading Psychology", sub: "80% of trading is between your ears",
        lessons: [
          { id:"m7-l1", title:"7.1 The Five Emotional Enemies", body:`<h4>FOMO (Fear Of Missing Out)</h4><p>Jumping into trades late because "it's moving and I can't miss it." FOMO entries almost always have terrible R:R because you're buying the high.</p>
<h4>Revenge Trading</h4><p>Immediately opening another trade after a loss to "make it back." Usually over-sized. This is how accounts blow up in a single day.</p>
<h4>Overconfidence</h4><p>After three wins in a row, you start skipping your checklist, widening your stops, adding size. The market notices and takes the money back.</p>
<h4>Hope</h4><p>Turning a losing trade into an "investment" by moving your SL or adding to the loser. "It'll come back." Sometimes it won't.</p>
<h4>Analysis Paralysis</h4><p>Adding more indicators, watching more YouTube videos, waiting for "perfect" confirmation that never comes. You don't need 12 indicators to trade well.</p>` },
          { id:"m7-l2", title:"7.2 Building Discipline", body:`<ul>
<li><strong>Have a written trading plan</strong> — rules for entry, SL, TP, size. Before each trade you must be able to answer "why this, why now, where am I wrong?"</li>
<li><strong>Keep a trading journal</strong> — the app's Journal tab does this for you. Review every trade weekly.</li>
<li><strong>Take breaks after two consecutive losses.</strong> Walk away for an hour. The market will still be there tomorrow.</li>
<li><strong>Set a daily loss limit</strong> — if you lose 3% in a day, shut the platform down.</li>
<li><strong>Never trade when angry, tired, intoxicated, or over-excited.</strong></li>
</ul>` },
          { id:"m7-l3", title:"7.3 Expectancy & The Law of Large Numbers", body:`<p>Trading is a probability business. Single trades are random. Your <strong>edge</strong> only shows up over a large sample (50+ trades).</p>
<p><code>Expectancy = (Win Rate × Avg Win) − (Loss Rate × Avg Loss)</code></p>
<p>Example: 50% wins, average win R300, average loss R150 → Expectancy = (0.5×300) − (0.5×150) = R75 per trade. That is a phenomenal edge.</p>
<div class="lesson-tip"><span class="ex-title">💡 Mindset</span>Treat trading like a casino runs its tables. The casino doesn't care about one spin of the wheel — it knows that over thousands of spins, the house wins. You are the casino.</div>` }
        ]
      },
      {
        id: "m8", icon: "fa-coins", title: "Module 8: Putting It All Together", sub: "Your first 30 days as a disciplined trader",
        lessons: [
          { id:"m8-l1", title:"8.1 Pre-Trade Checklist", body:`<p>Before opening ANY trade, answer these out loud:</p>
<ol>
<li>What is the D1 trend? (bull/bear/sideways)</li>
<li>What is the H4 trend? Does it agree?</li>
<li>Where is the nearest key level (support/resistance)?</li>
<li>What is the H1/M15 entry trigger (momentum + pattern)?</li>
<li>Where is my invalidation point (where am I wrong)?</li>
<li>What is the R:R (must be ≥ 1:1.5)?</li>
<li>What is my lot size (1% risk)?</li>
<li>Have I written this down in the journal?</li>
</ol>
<p>If any answer is "I don't know," DO NOT TAKE THE TRADE.</p>` },
          { id:"m8-l2", title:"8.2 Sample Trading Plan (EUR/USD)", body:`<div class="lesson-example"><span class="ex-title">📋 Sample plan</span>
<strong>Pair:</strong> EUR/USD<br/>
<strong>Session:</strong> London / London-NY overlap only<br/>
<strong>Timeframes:</strong> D1 bias, H4 structure, H1 entry, M15 timing<br/>
<strong>Indicators:</strong> EMA9/21, SMA50/200, RSI14, MACD12/26/9, ATR14<br/>
<strong>Entry rules:</strong>
<ul>
  <li>D1 and H4 trending same direction (HH/HL or LH/LL)</li>
  <li>Pullback to a key support/resistance zone</li>
  <li>Bullish/bearish candlestick pattern at the zone (hammer/engulfing/pin bar)</li>
  <li>RSI oversold/overbought at the zone</li>
  <li>MACD crossover confirmation on H1</li>
</ul>
<strong>Exit rules:</strong>
<ul>
  <li>SL at 1.5× ATR beyond the most recent swing high/low</li>
  <li>TP1 at nearest opposing structure (min 1.5R); take 50% off there, move SL to breakeven</li>
  <li>TP2 at 3R extension; trail stop on remaining 50%</li>
  <li>If a higher-TF structure breaks, exit early.</li>
</ul>
<strong>Risk:</strong> 1% per trade. Max 2 open trades at a time.
</div>` },
          { id:"m8-l3", title:"8.3 Your First 30 Days", body:`<p><strong>Week 1-2: NO real money.</strong> Use the demo account. Only take bot signals. Journal every trade (even the ones you didn't take). Build the muscle memory.</p>
<p><strong>Week 3:</strong> Micro account (0.01 lots). Real money, tiny size. Goal: follow your rules perfectly, not make money.</p>
<p><strong>Week 4:</strong> Review. If your win rate is > 40% and R:R is consistently above 1:1.5, you're ready to increase size slightly. If not, go back to demo.</p>
<div class="lesson-tip"><span class="ex-title">🐆 Panther Mindset</span>Precision. Discipline. Mastery. Wait patiently for the high-probability setup. Strike decisively when it appears. Move on quickly when stopped out. The panther doesn't chase every gazelle.</div>` }
        ]
      }
    ]
  },
  zu: {
    title: "Ukuhwebelana Kwe-Forex — Isifundo Esiphelele",
    subtitle: "Umhlahlandlela wabahwebi bakwaNdumiso",
    modules: [
      { id:"m1", icon:"fa-globe", title:"Isahluko 1: Kuyini i-Forex?", sub:"Imakethe enkulu kunazo zonke emhlabeni",
        lessons:[
          {id:"m1-l1", title:"1.1 Incazelo Nobukhulu Bayo", body:`<p><strong>i-Forex (FX)</strong> ifushane ngelithi <em>foreign exchange</em> — imakethe yomhlaba wonke lapho kuthengwa futhi kuthengiswe khona izimali zamazwe ngamazwe.</p><p>Iyimakethe enkulu kunazo zonke emhlabeni — kuthengiswa ngaphezu kuka-<strong>$7.5 trillion</strong> ngosuku.</p><ul><li>Ivula ngoMsombuluko eWellington, ivalwe ngoLwesihlanu eNew York.</li><li>Alikho ihhovisi eliphakathi — ukuhweba kwenzeka nge-OTC (over-the-counter) ngamabhange nama-broker.</li><li>Kuhweba ngama-<em>pair</em> (ngababili): uthenga imali eyodwa ngesikhathi uthengisa enye.</li></ul><div class="lesson-tip"><span class="ex-title">💡 Qaphela</span>Awukho umumo "ophezulu" noma "ophansi" wedwa — i-EUR/USD ikhuphuka kusho ukuthi i-EUR iyaqina uma iqhathaniswa ne-USD.</div>`},
          {id:"m1-l2", title:"1.2 Izikhathi Zemakethe", body:`<p>I-Forex isebenza amahora angu-24 izinsuku ezi-5 ngeviki.</p><table><tr><th>I-Session</th><th>Isikhathi (SAST)</th><th>Ukuhamba Kwentengo</th></tr><tr><td>Sydney / Tokyo (Asia)</td><td>00:00 – 08:00</td><td>Phansi</td></tr><tr><td>London (Europe)</td><td>09:00 – 18:00</td><td>Phezulu</td></tr><tr><td>New York (Americas)</td><td>15:00 – 00:00</td><td>Phezulu kakhulu</td></tr></table><p>Isikhathi esihle kakhulu sokuhweba yi-<strong>London/NY overlap (15:00 – 18:00 SAST)</strong>.</p>`},
          {id:"m1-l3", title:"1.3 Ama-Currency Pair", body:`<p>Izimali zihlala zibhalwa ngazimbili. Eyokuqala yi-<em>base</em>, eyesibili yi-<em>quote</em>.</p><p>Isibonelo: <code>EUR/USD = 1.0850</code> kusho ukuthi i-1 Euro = 1.0850 US Dollar.</p><ul><li><strong>EUR/USD</strong> — i-pair ethandwa kakhulu</li><li><strong>GBP/USD</strong> (Cable) — iyahamba kakhulu</li><li><strong>USD/JPY</strong> — izwela kakhulu ezindabeni</li><li><strong>USD/CHF, AUD/USD, NZDUSD, USDCAD</strong></li><li><strong>EURGBP, EURJPY, GBPJPY</strong> — ama-cross pairs</li></ul><div class="lesson-warn">⚠️ Namathela kuma-pair ahlolwa i-bot. Ukwengeza ama-exotic pairs akuniki i-edge engcono.</div>`},
          {id:"m1-l4", title:"1.4 I-Leverage Nama-Broker", body:`<p><strong>I-Leverage</strong> ikuvumela ukuthi ulawule inani elikhulu ngemali encane. I-leverage engu-1:100 isho ukuthi u-R100 wakho ulawula u-R10,000.</p><p>Kodwa i-leverage yandisa kokubili inzuzo kanye nokulahlekelwa.</p><div class="lesson-example"><span class="ex-title">📊 Isibonelo</span>Nge-akhawunti ka-R10,000 ne-leverage engu-1:100, ukulahlekelwa ngo-1% kuwisa u-R100. Nge-1:1000, ukulahlekelwa okufanayo kuwisa i-akhawunti yonke.</div><p>Sebenzisa i-broker elawulwayo (FSCA eNingizimu Afrika).</p><div class="lesson-tip"><span class="ex-title">💡 Umthetho kaNdumiso</span>Ku-akhawunti ka-R10,000, ungazibeki engozini ngaphezu kuka-R100–R200 (1–2%) nge-trade ngayinye.</div>`}
        ]
      },
      { id:"m2", icon:"fa-fire", title:"Isahluko 2: Ama-Candlestick", sub:"Ulimi lwentengo",
        lessons:[
          {id:"m2-l1", title:"2.1 Ukwakheka Kwe-Candle", body:`<p>I-candlestick eyodwa ikhombisa amanani amane: Open, High, Low, Close.</p><ul><li>I-<strong>Bullish</strong> (eluhlaza) — ivalwa ngaphezu kwe-open yayo</li><li>I-<strong>Bearish</strong> (ebomvu) — ivalwa ngaphansi kwe-open yayo</li><li>Ama-<strong>wick</strong> akhombisa izindawo intengo efinyelele kuzona kodwa yabuyela emuva</li></ul><div class="lesson-tip"><span class="ex-title">💡 Funda</span>I-wick ende phezulu kwi-candle eluhlaza isho ukuthi abathengi bazame ukukhuphula intengo kodwa bahluleka — abathengisi sebeqalile.</div>`},
          {id:"m2-l2", title:"2.2 Amaphethini E-Bullish Reversal", body:`<h4>I-Hammer</h4><p>Umzimba omncane phezulu, i-wick ende phansi (ubude obuphindwe ka-2 komzimba). Kwenzeka ngemuva kwe-downtrend. Ikhombisa ukuthi abathengi bayangena.</p><h4>I-Bullish Engulfing</h4><p>I-candle eluhlaza elimboza ngokuphelele i-candle ebomvu eyedlule. Kuyi-signal enamandla.</p><h4>I-Morning Star</h4><p>I-candle ende ebomvu → idoji → i-candle ende eluhlaza. Ingenye yama-reversals athembekileyo.</p>`},
          {id:"m2-l3", title:"2.3 Amaphethini E-Bearish Reversal", body:`<h4>I-Shooting Star</h4><p>Umzimba omncane phansi, i-wick ende phezulu. Kwenzeka ku-resistance.</p><h4>I-Bearish Engulfing</h4><p>I-candle ebomvu elimboza i-candle eluhlaza eyedlule ku-resistance.</p><h4>I-Evening Star</h4><p>Isibuko se-morning star phezulu.</p><div class="lesson-warn">⚠️ Ungahwebi ama-candlestick patterns uwedwa. I-pin bar phakathi nobala awulutho. Lindela isiqinisekiso (confluence).</div>`},
          {id:"m2-l4", title:"2.4 Ama-Continuation Pattern", body:`<ul><li><strong>Ifulegi (Flag)</strong> — ikhefu ngaphambi kokuthi intengo iqhubeke</li><li><strong>Onxantathu (Triangle)</strong> — intengo iyacindezeleka ngaphambi kokuqhuma</li><li><strong>Three White Soldiers</strong> — amakhandlela amathathu aluhlaza elandelanayo</li><li><strong>Three Black Crows</strong> — amakhandlela amathathu abomvu elandelanayo</li></ul>`}
        ]
      },
      { id:"m3", icon:"fa-layer-group", title:"Isahluko 3: I-Support, Resistance Nohlaka", sub:"Imigqa yempi yemakethe",
        lessons:[
          {id:"m3-l1", title:"3.1 I-Support Ne-Resistance", body:`<p><strong>I-Support</strong> yindawo lapho abathengi bejwayele ukungena khona (phansi).</p><p><strong>I-Resistance</strong> yindawo lapho abathengisi bejwayele ukungena khona (phezulu).</p><p>Lapho ileveli yephuka, iyajika (role reversal): i-resistance ephukile iba yi-support entsha.</p><div class="lesson-example"><span class="ex-title">📊 Isibonelo</span>I-EUR/USD ifinyelela ku-1.0900 izikhathi ezine yehle. Okwesihlanu iyayephula, bese ibuya izoyihlola njenge-support. Manje usufuna ama-buys ku-1.0900.</div>`},
          {id:"m3-l2", title:"3.2 Ama-Swing High Nama-Swing Low", body:`<p>I-<strong>swing high</strong> yisiqongo sentengo wendawo, i-<strong>swing low</strong> yisigodi. I-bot izithola ngokuzenzakalelayo isebenzisa ibha engu-5 ohlangothini ngalunye.</p><p>Amanani ayizindilinga (1.0800, 1.1000, 150.00) nawo asebenza njengama-level engqondo.</p>`},
          {id:"m3-l3", title:"3.3 Ama-Trend (HH/HL/LH/LL)", body:`<h4>I-Uptrend (bullish)</h4><p>Intundo yenza <strong>Higher Highs (HH)</strong> kanye <strong>no-Higher Lows (HL)</strong>. Sithenga.</p><h4>I-Downtrend (bearish)</h4><p>Intengo yenza <strong>Lower Highs (LH)</strong> kanye <strong>no-Lower Lows (LL)</strong>. Sithengisa.</p><h4>I-Range</h4><p>Intengo ishaya phakathi kwe-support ne-resistance. Thengisa i-range noma ulinde i-breakout.</p><div class="lesson-tip"><span class="ex-title">🏛️ Isimiso se-MTF</span>Hlola i-D1 kuqala. Uma i-D1 iku-uptrend, bheka ama-BUYS kuphela ku-H4/H1/M15. Ukulwa ne-higher-TF trend kuyisona sizathu esikhulu sokulahlekelwa.</div>`},
          {id:"m3-l4", title:"3.4 Ama-Breakout Nama-Retest", body:`<p>I-<strong>breakout</strong> kulapho intengo ivala iqine ngale kwe-level.</p><p>I-<strong>retest</strong> kulapho intengo ibuya izohlola i-level esephukile. Ukungena nge-retest kuvame ukuphepha kune-breakout uqobo (kugwema ama-fakeout).</p><div class="lesson-warn">⚠️ I-wick edlula kwi-level AKUSONA isiqinisekiso. Lindela ukuvala <strong>okuvaliwe</strong> ngale kwe-level.</div>`}
        ]
      },
      { id:"m4", icon:"fa-wave-square", title:"Isahluko 4: Izinkomba (Indicators)", sub:"EMA, RSI, MACD, ATR",
        lessons:[
          {id:"m4-l1", title:"4.1 Ama-Moving Average", body:`<p>Sisebenzisa ama-MA amane: EMA 9, EMA 21, SMA 50, SMA 200.</p><p>Uma woni eqonde ohlangothi olulodwa (bull stack / bear stack), i-trend inamandla.</p>`},
          {id:"m4-l2", title:"4.2 I-RSI", body:`<p>I-RSI isuka ku-0 iye ku-100.</p><ul><li><strong>Ngaphezu kuka-70</strong> → overbought (ingahlehla)</li><li><strong>Ngaphansi kuka-30</strong> → oversold (ingakhuphuka)</li><li><strong>Ukunqamula u-50</strong> → isiqinisekiso se-momentum</li></ul><p>Kumele uqaphele: kwi-trend enamandla i-RSI ingahlala i-overbought isikhathi eside.</p>`},
          {id:"m4-l3", title:"4.3 I-MACD", body:`<p>I-MACD isetshenziselwa ukubona ama-crossover we-momentum.</p><ul><li>I-bullish crossover = MACD yeqa ngaphezulu kwe-signal line</li><li>I-bearish crossover = MACD yeqa ngaphansi</li><li><strong>I-Divergence</strong> = isexwayiso sokushintsha kwe-trend</li></ul>`},
          {id:"m4-l4", title:"4.4 I-ATR", body:`<p>I-ATR ikala ukuthi intengo ihamba kangakanani ngebha ngayinye. Ayikhombisi direction — ikala i-volatility.</p><p>Siyisebenzisela: ukubeka ama-stop, ukubala i-lot size, ukugwema izikhathi ze-extreme volatility.</p><div class="lesson-tip"><span class="ex-title">💡 Isibonelo</span>Uma i-ATR ye-EUR/USD ku-H1 ingu-0.0012 (12 pips), i-SL elifanele lingu-1.5 × 0.0012 = 18 pips.</div>`}
        ]
      },
      { id:"m5", icon:"fa-shield-halved", title:"Isahluko 5: Ukuphatha Ubungozi", sub:"Umthetho okugcina emdlalweni",
        lessons:[
          {id:"m5-l1", title:"5.1 Umthetho Ka-1%", body:`<p>Ukubeka u-1% we-akhawunti yakho nge-trade ngayinye kusho ukuthi ama-loss angu-10 alandelanayo akulahlekisela u-10% kuphela. Kuyabuhlungu kodwa kuyasinda.</p><p>Ukubeka u-5% nge-trade kusho ama-loss ayisi-7 akwisa phansi i-akhawunti.</p><div class="lesson-example"><span class="ex-title">📊 Izibalo</span>nge-win rate engu-50% kanye no-R:R ongu-1:2, ama-trade angu-10 akunika u-R300 ngenani elimaphakathi.</div>`},
          {id:"m5-l2", title:"5.2 Ukubeka I-Stop-Loss", body:`<p>I-SL kufanele ibekwe lapho i-trade idea yakho ingasasebenzi khona.</p><ul><li>I-BUY: ngaphansi kwe-swing low yakamuva</li><li>I-SELL: ngaphezulu kwe-swing high yakamuva</li></ul><div class="lesson-warn">⚠️ UNGALOKOTHI uhambise i-SL kude uma i-tring ingahambi kahle. Uma i-trade ingalungile — yamukele ukulahlekelwa uqhubeke.</div>`},
          {id:"m5-l3", title:"5.3 I-Risk-Reward", body:`<p>I-R:R engu-1:1.5 iyisilinganiso esiphansi i-bot esamukelayo. Ku-1:2, ungaba nephutha ku-2 kwabayi-3 bese wenza inzuzo.</p><table><tr><th>R:R</th><th>I-Win rate edingekayo</th></tr><tr><td>1:1</td><td>50%</td></tr><tr><td>1:1.5</td><td>40%</td></tr><tr><td>1:2</td><td>33%</td></tr></table>`},
          {id:"m5-l4", title:"5.4 Indlela Yokubala I-Lot Size", body:`<p>Ifomula esetshenziswa yi-bot:</p><p><code>Lot = (Account × Risk%) / (Pips Risk × Pip Value)</code></p><div class="lesson-example"><span class="ex-title">📊 Isibonelo</span>I-akhawunti ka-R10,000, u-1% = R100. I-SL ngama-pips angu-40 ku-EURUSD. I-pip value nge-standard lot ilinganiselwa ku-R180. Ama-lots = R100 / (40 × R18) = 0.14 lots.</div>`}
        ]
      },
      { id:"m6", icon:"fa-arrow-trend-up", title:"Isahluko 6: Isu Le-Multi-Timeframe", sub:"Indlela i-bot ethola ngayo amasetup",
        lessons:[
          {id:"m6-l1", title:"6.1 I-Hierarchy (D1 → H4 → H1 → M15)", body:`<p>I-bot ihlaziya izikhathi ezi-5 ngokulandelana: D1, H4, H1, M15, M5. Uma i-D1 ne-H4 zingavumelani, AKUKHO trade.</p>`},
          {id:"m6-l2", title:"6.2 I-Confluence Score (0-100)", body:`<p>I-strength engu-70+ isho ukuthi amafactor amaningi ayavumelana. AKUSONA isiqinisekiso sokuwina — isilinganiso sokuvumelana kwezinto zobuchwepheshe.</p>`},
          {id:"m6-l3", title:"6.3 Ukungena Nokuvimbela Okuphindaphindayo", body:`<p>I-bot ayifaki ama-signal amabili ku-pair elifanayo phakathi kwamahora angu-4 noma ngaphakathi kuka-0.5 ATR.</p>`},
          {id:"m6-l4", title:"6.4 Incazelo Yekhadi Lesiginali", body:`<p>Ikhadi ngalinye libonisa: i-pair, isiqondiso, i-entry, i-SL, i-TP, i-R:R, i-ATR, istrength, i-quality %.</p>`}
        ]
      },
      { id:"m7", icon:"fa-brain", title:"Isahluko 7: Ingqondo Yokuhweba", sub:"U-80% wokuhweba usemqondweni",
        lessons:[
          {id:"m7-l1", title:"7.1 Izitha Ezinhlanu", body:`<h4>I-FOMO</h4><p>Ukungena ngenxa yokwesaba ukuphuthelwa. I-FOMO entries ayajwayele ukuba ne-R:R embi.</p><h4>Ukuziphindiselela (Revenge)</h4><p>Ukuvula i-trade ngokushesha ngemuva kokulahlekelwa. Yindlela esheshayo yokushabalalisa i-akhawunti.</p><h4>Ukuzethemba ngokweqile</h4><p>Ngemuva kwama-win ama-3, weqa i-checklist. Imakethe iyakuqaphela.</p><h4>Ithemba (Hope)</h4><p>Ukuguqula i-losers ibe "yi-investment". Kwesinye isikhathi ayibuyi.</p><h4>I-Analysis Paralysis</h4><p>Ukwengeza ama-indicators amaningi esikhundleni sokuthatha i-trade.</p>`},
          {id:"m7-l2", title:"7.2 Ukuzijwayeza Isiyalo", body:`<ul><li>Yiba nohlelo lokuhweba olubhaliwe</li><li>Gcina ijenali (i-app yakwenzela lokhu)</li><li>Thatha ikhefu ngemuva kwama-loss ama-2</li><li>Beka umkhawulo wosuku (3%)</li><li>Ungahwebi uma uthukuthele, ukhathele, noma udakiwe.</li></ul>`},
          {id:"m7-l3", title:"7.3 I-Expectancy", body:`<p>I-edge yakho ibonakala kumasampula amakhulu (50+ trades). Ungakhathazeki nge-trade eyodwa.</p><div class="lesson-tip"><span class="ex-title">💡 Umbono</span>Yiba yikhasino. Ikhasino ayinendaba ne-spin eyodwa — iyazi ukuthi ngokuhamba kwesikhathi, iyawina. Wena uyikhasino.</div>`}
        ]
      },
      { id:"m8", icon:"fa-coins", title:"Isahluko 8: Ukuhlanganisa Konke", sub:"Izinsuku zokuqala ezingu-30",
        lessons:[
          {id:"m8-l1", title:"8.1 I-Pre-Trade Checklist", body:`<ol><li>Ithini i-D1 trend?</li><li>Ithini i-H4 trend? Iyavumelana?</li><li>Ithini i-level eseduze?</li><li>Yini i-trigger yokungena?</li><li>Ngilapho uma nginephutha?</li><li>Ithini i-R:R (≥ 1:1.5)?</li><li>Ithini i-lot size (1% risk)?</li><li>Ngikubhalile phansi?</li></ol><p>Uma ungakwazi ukuphendula noma imuphi — UNGAYITHATHI I-TRADE.</p>`},
          {id:"m8-l2", title:"8.2 Isibonelo Sohlelo (EUR/USD)", body:`<div class="lesson-example"><span class="ex-title">📋 Uhlelo</span><strong>Pair:</strong> EUR/USD<br/><strong>Isikhathi:</strong> London/NY overlap kuphela<br/><strong>Ama-Indicators:</strong> EMA9/21, SMA50/200, RSI14, MACD, ATR14<br/><strong>Ama-Rules:</strong><ul><li>D1 ne-H4 kumele zivumelane</li><li>Pullback kwi-key level</li><li>I-candlestick pattern kuleveli</li><li>RSI oversold/overbought</li><li>MACD crossover ku-H1</li></ul><strong>Ukukhipha:</strong><ul><li>SL ku-1.5 × ATR ngemuva kwe-swing</li><li>TP1 ku-structure eseduze (1.5R+)</li><li>50% off ku-TP1, SL iye ku-breakeven</li></ul><strong>Risk:</strong> 1% nge-trade, 2 trades max.</div>`},
          {id:"m8-l3", title:"8.3 Izinsuku Zokuqala Ezingu-30", body:`<p><strong>Isonto 1-2:</strong> Akukho mali yangempela. Sebenzisa i-demo. Landela ama-signals e-bot kuphela.</p><p><strong>Isonto lesi-3:</strong> I-akhawunti encane (0.01 lots). Umgomo: ukulandela imithetho, hhayi ukwenza imali.</p><p><strong>Isonto lesi-4:</strong> Buyekeza. Uma win rate > 40% futhi R:R > 1:1.5, ungakhuphula kancane.</p><div class="lesson-tip"><span class="ex-title">🐆 Ingqondo Yengwe</strong>Ukunemba. Isiyalo. Ubungcweti. Lindela isetup se-high-probability ngesineke. Gadla ngokunqala lapho ivela. Qhubeka ngokushesha uma umisiwe.</div>`}
        ]
      }
    ]
  }
};

// ─────── Academy state & renderer ───────
var academyState = { lang: "en", openModule: null, currentLesson: null };

function initAcademy() {
  var enBtn = document.getElementById("langEN");
  var zuBtn = document.getElementById("langZU");
  var pdfBtn = document.getElementById("pdfBtn");
  var backBtn = document.getElementById("backBtn");
  if (enBtn) enBtn.addEventListener("click", function(){ setLang("en"); });
  if (zuBtn) zuBtn.addEventListener("click", function(){ setLang("zu"); });
  if (pdfBtn) pdfBtn.addEventListener("click", openPdf);
  if (backBtn) backBtn.addEventListener("click", backToModules);
  renderModules();
}
function setLang(l) {
  academyState.lang = l;
  var enBtn = document.getElementById("langEN");
  var zuBtn = document.getElementById("langZU");
  if (enBtn) enBtn.classList.toggle("active", l==="en");
  if (zuBtn) zuBtn.classList.toggle("active", l==="zu");
  if (academyState.currentLesson) renderLesson(academyState.currentLesson.moduleId, academyState.currentLesson.lessonId);
  else renderModules();
}
function renderModules() {
  academyState.currentLesson = null;
  var list = document.getElementById("eduModules");
  var view = document.getElementById("eduLesson");
  if (list) list.style.display = "block";
  if (view) view.style.display = "none";
  var data = EDU[academyState.lang];
  if (!list || !data) return;
  list.innerHTML = "";
  data.modules.forEach(function(mod){
    var card = document.createElement("div");
    card.className = "edu-module";
    card.innerHTML = '<div class="edu-mod-head">' +
      '<div class="edu-mod-icon"><i class="fa-solid ' + mod.icon + '"></i></div>' +
      '<div class="edu-mod-t"><h3></h3><p></p></div>' +
      '<i class="fa-solid fa-chevron-down edu-mod-chv"></i></div>' +
      '<div class="edu-lesson-list"></div>';
    card.querySelector(".edu-mod-t h3").textContent = mod.title;
    card.querySelector(".edu-mod-t p").textContent = mod.sub;
    var lessonList = card.querySelector(".edu-lesson-list");
    mod.lessons.forEach(function(les){
      var item = document.createElement("div");
      item.className = "edu-lesson-item";
      item.innerHTML = '<i class="fa-solid fa-circle lesson-bullet" style="font-size:6px"></i><span></span>';
      item.querySelector("span").textContent = les.title;
      item.addEventListener("click", function(e){
        e.stopPropagation();
        openLesson(mod.id, les.id);
      });
      lessonList.appendChild(item);
    });
    var head = card.querySelector(".edu-mod-head");
    head.addEventListener("click", function(){
      var isOpen = card.classList.contains("open");
      // close all
      var all = list.querySelectorAll(".edu-module");
      for (var i=0;i<all.length;i++) all[i].classList.remove("open");
      if (!isOpen) card.classList.add("open");
    });
    list.appendChild(card);
  });
}
function openLesson(modId, lesId) {
  var list = document.getElementById("eduModules");
  var view = document.getElementById("eduLesson");
  if (list) list.style.display = "none";
  if (view) view.style.display = "block";
  academyState.currentLesson = { moduleId: modId, lessonId: lesId };
  renderLesson(modId, lesId);
  window.scrollTo({ top: view ? view.offsetTop - 80 : 0, behavior: "smooth" });
}
function renderLesson(modId, lesId) {
  var data = EDU[academyState.lang];
  var mod = data.modules.find(function(m){ return m.id === modId; });
  if (!mod) return;
  var les = mod.lessons.find(function(l){ return l.id === lesId; });
  if (!les) return;
  var titleEl = document.getElementById("lessonTitle");
  var subEl = document.getElementById("lessonSubtitle");
  var bodyEl = document.getElementById("lessonBody");
  if (titleEl) titleEl.textContent = les.title;
  if (subEl) subEl.textContent = mod.sub;
  if (bodyEl) bodyEl.innerHTML = les.body;
}
function backToModules() { renderModules(); window.scrollTo({top: 0, behavior:"smooth"}); }

// ─────── PDF download (print view) ───────
function openPdf() {
  var w = window.open("", "_blank");
  var data = EDU[academyState.lang];
  var html = '<!doctype html><html><head><meta charset="utf-8"><title>' + data.title + '</title>' +
    '<link rel="stylesheet" href="css/app.css">' +
    '<style>body{font-family:Inter,Arial,sans-serif;background:#0a0d14;color:#e4e7ee;padding:20px;}' +
    '.bottom-nav,.app-header,#splash,.edu-toolbar,.back-btn{display:none!important;}' +
    '.page{display:block;position:static;padding:0;}.edu-module{border:1px solid #222a3a;border-radius:10px;margin-bottom:12px;overflow:hidden;}' +
    '.edu-mod-head{background:linear-gradient(135deg,#141a28,#0a0d14);padding:14px 16px;display:flex;align-items:center;gap:12px;}' +
    '.edu-mod-icon{width:44px;height:44px;border-radius:12px;background:#1a2030;display:flex;align-items:center;justify-content:center;color:#d4af37;}' +
    '.edu-mod-t h3{margin:0;color:#d4af37;font-size:16px;}.edu-mod-t p{margin:2px 0 0;color:#39d2c0;font-size:12px;}' +
    '.edu-lesson-list{display:block;padding:12px 16px 16px;}.edu-lesson-item{padding:10px 0;border-bottom:1px solid #1a2030;color:#c8ccd8;}' +
    '.edu-lesson-item:last-child{border:none;}.lesson-body{color:#c8ccd8;font-size:12px;line-height:1.7;}' +
    'h1,h2,h3,h4{color:#fff}.lesson-example{background:linear-gradient(135deg,rgba(57,210,192,0.08),rgba(212,175,55,0.08));border-left:3px solid #39d2c0;padding:10px;border-radius:4px;margin:8px 0;}' +
    '.lesson-warn{background:rgba(220,38,38,0.08);border-left:3px solid #dc2626;padding:10px;border-radius:4px;margin:8px 0;}' +
    '.lesson-tip{background:rgba(212,175,55,0.08);border-left:3px solid #d4af37;padding:10px;border-radius:4px;margin:8px 0;}' +
    'table{width:100%;border-collapse:collapse;margin:8px 0;}th{background:#1a2030;color:#d4af37;padding:6px;text-align:left;font-size:11px;}td{padding:6px;border-bottom:1px solid #1a2030;font-size:11px;}' +
    'code{background:#1a2030;color:#39d2c0;padding:2px 6px;border-radius:3px;font-size:11px;}' +
    '.print-cover{display:block!important;text-align:center;padding:60px 20px;page-break-after:always;}' +
    '.print-cover h1{color:#d4af37;font-size:28px;font-family:"Playfair Display",serif;margin-bottom:10px;}' +
    '.print-cover p{color:#39d2c0;}' +
    '@page{margin:15mm;size:A4;}</style>' +
    '</head><body>' +
    '<div class="print-cover"><h1>🐆 ' + data.title + '</h1><p>' + data.subtitle + '</p><p style="color:#888;font-size:11px;margin-top:40px">Forex Trading with Ndumiso &mdash; ' + new Date().toISOString().slice(0,10) + '</p></div>';
  data.modules.forEach(function(mod){
    html += '<div class="edu-module"><div class="edu-mod-head"><div class="edu-mod-icon"><i class="fa-solid ' + mod.icon + '"></i></div><div class="edu-mod-t"><h3>' + mod.title + '</h3><p>' + mod.sub + '</p></div></div><div class="edu-lesson-list">';
    mod.lessons.forEach(function(les){
      html += '<div class="edu-lesson-item" style="color:#fff;font-weight:700;border-bottom:1px solid #222a3a">' + les.title + '</div>';
      html += '<div class="lesson-body" style="padding:8px 0 16px">' + les.body + '</div>';
    });
    html += '</div></div>';
  });
  html += '<p style="text-align:center;color:#888;font-size:11px;margin-top:30px">🐆 Precision. Discipline. Mastery.</p>';
  html += '<script>window.onload=function(){setTimeout(function(){window.print();},500);};</scr' + 'ipt>';
  html += '</body></html>';
  w.document.write(html);
  w.document.close();
}
