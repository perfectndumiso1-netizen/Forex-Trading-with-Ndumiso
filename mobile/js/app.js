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
// ═══════════════════════════════════════════════════════════════════════════
// FOREX ACADEMY — FULL BOOK-LENGTH COURSE (English)
// Illustrated with ASCII charts, worked examples, step-by-step math,
// psychology lessons, and a complete end-to-end EUR/USD walkthrough.
// ═══════════════════════════════════════════════════════════════════════════
EDU = {};
EDU.en = {
  title: "Forex Trading with Ndumiso",
  subtitle: "The Complete Course — From Beginner to Disciplined Trader",
  coverNote: "Read in order. Each chapter builds on the last. Do not skip ahead to 'get rich quick' chapters — there are none.",
  modules: [
    // ═══════════════════ MODULE 1 ═══════════════════════════════════════
    {
      id:"m1", icon:"fa-globe",
      title:"Book 1: The World of Foreign Exchange",
      sub:"What forex is, how the market works, who the players are, and why 90% of new traders lose money",
      lessons:[
        { id:"m1-l1", title:"Lesson 1: A Day in the Life of a Currency",
          body:`<p>On a Tuesday morning in Johannesburg, a South African wine farm ships 2,000 cases of Pinotage to a distributor in Düsseldorf. The invoice is in Euros. The importer sells the wine for Euros, but the farm pays its workers in Rand. Somewhere along the chain, someone — a bank or a payments company — has to convert those Euros back into Rand.</p>
<p>At the same moment, a Japanese pension fund buys US Treasury bonds because Japanese interest rates are near zero but US rates pay 4%. To do that, the fund converts Japanese Yen into US Dollars.</p>
<p>In London, a hedge fund that believes the British pound will rise against the US dollar buys a £50,000,000 position in GBP/USD.</p>
<p>In Lagos, a student transferring tuition to a university in Canada sends ₦5,000,000 through a money service, which converts Naira to Canadian Dollars.</p>
<p>Every one of those transactions — millions of them every day, around the clock, five days a week — passes through the same market: <strong>the foreign exchange market</strong>, or Forex.</p>
<div class="lesson-quote">Forex is not a casino invented for retail traders. It is the plumbing of world trade. Speculators like us are just a tiny piece of a very large machine.</div>
<h3>How big is it?</h3>
<p>According to the Bank for International Settlements (BIS), the Forex market turns over roughly <strong>$7.5 trillion per day</strong>. To put that in perspective:</p>
<ul>
  <li>The entire New York Stock Exchange does about $200 billion per day.</li>
  <li>Apple does about $1 billion in revenue per day.</li>
  <li>All crypto markets combined do about $100–200 billion per day.</li>
</ul>
<p>Forex is roughly <strong>35 times bigger than the entire global stock market</strong>. There is no market more liquid, no market with tighter spreads, no market that moves with more raw force.</p>
<h3>What this means for you</h3>
<p>Because Forex is so large, no single player — not even a central bank — can control price for long. You can enter or exit a position in milliseconds. The cost of trading (the spread) is measured in fractions of a penny. That's the good news.</p>
<p>The bad news is that size does not make it easy. The Forex market is the most brutally competitive arena on earth. The people on the other side of your trade are bank prop desks, hedge funds with teams of PhDs, algorithmic systems in Tokyo and New York, and millions of other traders all fighting over the same price movements.</p>
<div class="lesson-warn">If you approach Forex thinking "it's a quick way to get rich," you will lose. If you approach it like learning medicine, law, or a martial art — years of study, deliberate practice, strict discipline — you have a chance.</div>`
        },
        { id:"m1-l2", title:"Lesson 2: A Brief History — From Gold Standards to Smartphones",
          body:`<p>Before 1971, the world operated under the <strong>Bretton Woods system</strong>. Currencies were pegged to the US dollar, and the US dollar was pegged to gold at $35 per ounce. Exchange rates barely moved. There was no such thing as "retail currency trading" — if you wanted to change money, you went to a bank.</p>
<p>In 1971, US President Richard Nixon took the dollar off the gold standard ("the Nixon shock"). Suddenly currencies could <em>float</em> against each other. Their value was determined by supply and demand on the open market. The modern Forex market was born.</p>
<h4>Key historical moments</h4>
<table>
<tr><th>Year</th><th>Event</th></tr>
<tr><td>1971</td><td>Bretton Woods collapses; currencies float freely</td></tr>
<tr><td>1980s</td><td>Electronic trading begins between banks</td></tr>
<tr><td>1990s</td><td>Internet arrives; retail brokers open access to individuals</td></tr>
<tr><td>2000s</td><td>MetaTrader becomes standard; leverage 1:100+ widely available</td></tr>
<tr><td>2010s</td><td>Smartphone trading apps make Forex a one-tap activity</td></tr>
<tr><td>2020s</td><td>AI/algos dominate institutional flow; regulation tightens globally</td></tr>
</table>
<p>The arrival of smartphones has been a double-edged sword. It has made trading accessible to anyone with a phone, which is wonderful — but it has also flooded the market with new traders who have no education, no plan, and no risk management. They are the fuel that pays the professionals.</p>
<div class="lesson-tip"><span class="ex-title">💡 A note from Ndumiso</span>Accessibility ≠ ease of profit. The fact that you can open a trade in two taps on a phone does not mean you should. You are competing against people who spend 12 hours a day at this. Education is your only edge.</div>`
        },
        { id:"m1-l3", title:"Lesson 3: Who Trades Forex (and Why Most Lose)",
          body:`<p>There are roughly five types of participants. You need to understand them because you are trading against them.</p>
<h4>1. Central Banks (the giants)</h4>
<p>The South African Reserve Bank, US Federal Reserve, ECB, Bank of Japan, Bank of England. They don't trade for profit — they manage currency stability, set interest rates, and intervene when their currency moves too far from where they want it. When a central bank speaks, markets move. A single sentence from the Fed chair can move EUR/USD 200 pips in minutes.</p>
<h4>2. Commercial & Investment Banks (the smart money)</h4>
<p>Standard Bank, JP Morgan, Citi, Deutsche, Goldman Sachs. They handle client flow (corporate conversions, pension funds, hedge fund orders). Their interbank market is where real price discovery happens. You and I never see those prices directly — we get them through a retail broker, marked up by a tiny spread.</p>
<h4>3. Hedge Funds & Prop Shops (the predators)</h4>
<p>These are full-time professionals who live or die by their edge. They include systematic funds (algos), macro funds (bets on rates/wars/policy), and prop traders using other people's money or firm capital. Their orders are large enough to push price around.</p>
<h4>4. Corporations (not speculators)</h4>
<p>Apple converting Chinese Yuan revenue back to USD; BMW paying German workers in EUR out of US sales. They don't care whether EUR/USD goes up or down; they just need to convert at a predictable rate. They use forwards and options to hedge — they are NOT trying to trade.</p>
<h4>5. Retail Traders (that's us)</h4>
<p>You, me, and millions of people sitting at kitchen tables, in offices, and on phones across the world. We represent about <strong>5–8% of total volume</strong>. We are the smallest players in the market.</p>
<div class="lesson-warn"><span class="ex-title">⚠️ Hard truth</span>Retail traders as a group lose money — not because the market is rigged, but because almost everyone shows up without a system, without risk management, and without emotional discipline. They trade on tips, gut feelings, FOMO, and revenge. The market takes their money and gives it to the prepared.</div>
<div class="lesson-example"><span class="ex-title">📊 The statistic</span>Every regulated broker is required to publish a "percentage of retail CFD accounts that lose money." Across the industry, that number sits between <strong>70% and 85%</strong>. It is not the broker taking your money (in most cases) — it is you making the same mistakes as the rest of the 80%. This course is about joining the 20%.</div>`
        },
        { id:"m1-l4", title:"Lesson 4: Sessions, Time Zones & When to Trade from South Africa",
          body:`<p>Forex is a 24-hour market from Monday morning in Wellington (New Zealand) to Friday evening in New York. But it is <em>not</em> equally active all day. There are three main sessions:</p>
<table>
<tr><th>Session</th><th>Opens (SAST)</th><th>Closes (SAST)</th><th>Character</th><th>Best Pairs</th></tr>
<tr><td>🌏 Sydney / Tokyo (Asia)</td><td>00:00</td><td>08:00</td><td>Quiet, range-bound</td><td>AUD/JPY, NZD/JPY, USD/JPY</td></tr>
<tr><td>🇬🇧 London (Europe)</td><td>09:00</td><td>18:00</td><td>High volume, trending</td><td>EUR/USD, GBP/USD, all majors</td></tr>
<tr><td>🇺🇸 New York (Americas)</td><td>15:00</td><td>00:00</td><td>Highest volatility</td><td>All majors — especially news-driven moves</td></tr>
</table>
<h3>The kill zones</h3>
<p>The most profitable windows for day-traders are the <strong>session opens</strong> and the <strong>overlaps</strong>:</p>
<ul>
  <li><strong>09:00 – 11:00 SAST (London open)</strong> — often the largest directional move of the day starts here.</li>
  <li><strong>15:00 – 18:00 SAST (London/NY overlap)</strong> — highest volume, biggest moves, best liquidity. This is prime time.</li>
  <li><strong>News events</strong> — interest rate decisions (SARB, Fed, ECB, BoE), Non-Farm Payrolls (first Friday of the month, 14:30 SAST), CPI prints — these create explosive moves. <em>Beginner traders should stay OUT of the market 30 minutes before and after major news.</em></li>
</ul>
<h3>When NOT to trade</h3>
<ul>
  <li><strong>Sunday evening opening</strong> (23:00–01:00 SAST) — spreads widen to ridiculous levels, banks are not at their desks yet, liquidity is terrible.</li>
  <li><strong>Friday after 21:00 SAST</strong> (NY afternoon) — traders close positions for the weekend; liquidity dries up; moves are erratic.</li>
  <li><strong>Bank holidays</strong> in London or New York — no volume, fake moves.</li>
  <li><strong>Asian session</strong> if you are a beginner — pairs chop sideways for hours; false breakouts abound.</li>
</ul>
<div class="lesson-tip"><span class="ex-title">💡 Ndumiso's schedule (for SA traders in CAT/SAST)</span>Wake up, check the D1 and H4 charts before London opens (~08:00). Trade 09:00–11:00 if there's a setup. Check again at 14:30 ahead of NY open. Trade the overlap 15:00–18:00 if the setup is clean. Close everything by 19:00. You have a life — live it.</div>`
        },
        { id:"m1-l5", title:"Lesson 5: Why 90% of Beginners Quit Within 6 Months",
          body:`<p>I have trained hundreds of traders. The pattern is always the same.</p>
<ol class="lesson-step-list">
  <li><strong>The hook.</strong> Someone sees a YouTube ad or a friend showing a screenshot of a $1,000 winning trade. "I can do that." They open a broker account.</li>
  <li><strong>The honeymoon.</strong> Their first few trades win (usually because of luck in a trending market). They think they are naturally gifted.</li>
  <li><strong>The first big loss.</strong> They over-leverage on a "sure thing" and lose 20–40% in a day. Panic sets in.</li>
  <li><strong>The churn.</strong> They revenge-trade, chasing losses. They switch strategies every week. They buy courses, join signal groups, chase indicators.</li>
  <li><strong>The bust or the awakening.</strong> Most lose everything and quit, calling Forex a scam. A small few realise the problem is not the market — it's <em>them</em>. They start studying properly.</li>
</ol>
<p>The goal of this course is to shortcut you directly to step 5 without losing your savings in steps 2–4.</p>
<div class="lesson-divider"></div>
<p>In the next book, we start learning the actual language of the market — candlesticks, charts, and how to read price action without indicators.</p>`
        }
      ]
    },
    // ═══════════════════ MODULE 2 — PRICE ACTION ════════════════════════
    {
      id:"m2", icon:"fa-fire",
      title:"Book 2: Candlesticks & Price Action",
      sub:"Reading the story price tells you — no indicators needed",
      lessons:[
        { id:"m2-l1", title:"Lesson 1: What is a Candlestick? The Anatomy",
          body:`<p>Before computers, Japanese rice traders in the 1700s drew pictures of price movement using ink and rice paper. A man named <strong>Munehisa Homma</strong> invented what we now call <em>candlestick charts</em> to visualise the battle between buyers and sellers in the Osaka rice markets. His method was so effective he became a legendarily wealthy trader. We still use it, virtually unchanged, 300 years later.</p>
<h3>The four prices</h3>
<p>Every candlestick represents a fixed period of time (1 minute, 5 minutes, 1 hour, 1 day — whatever timeframe you are looking at). Each candle shows exactly four numbers:</p>
<div class="lesson-chart"><span class="lesson-chart-title">ANATOMY OF A CANDLE</span>
        <span class="bull">       (H) High ───┐</span>
<span class="bull">                  │  ← Upper wick/shadow</span>
<span class="bull">              ┌───┴───┐</span>
<span class="bull">              │       │</span>
<span class="bull">  Open (O) ──►│  BODY │◄─ Close (C)      ◄── GREEN = bullish</span>
<span class="bull">              │       │                     (close ABOVE open)</span>
<span class="bull">              └───┬───┘</span>
<span class="bull">                  │  ← Lower wick/shadow</span>
<span class="bull">       (L) Low ───┘</span></div>
<ul>
  <li><strong>Open</strong> — the very first price traded at the start of the period</li>
  <li><strong>High</strong> — the highest price reached during the period</li>
  <li><strong>Low</strong> — the lowest price reached during the period</li>
  <li><strong>Close</strong> — the very last price traded at the end of the period</li>
</ul>
<div class="lesson-two-col">
  <div class="col-bull"><h5>Bullish candle (green)</h5>
    <ul><li>Closes ABOVE open</li><li>Buyers won the period</li><li>Pressure was UP</li></ul>
  </div>
  <div><h5>Bearish candle (red)</h5>
    <ul><li>Closes BELOW open</li><li>Sellers won the period</li><li>Pressure was DOWN</li></ul>
  </div>
</div>
<h3>The story in the wicks</h3>
<p>The body shows who won. The <strong>wicks</strong> (shadows) show the <em>battle</em>. Long wicks mean price traveled to that level but was rejected and pushed back.</p>
<ul>
  <li><strong>Long upper wick</strong> = buyers tried to push price higher, but sellers overwhelmed them and pushed it back down. <em>Rejection above.</em></li>
  <li><strong>Long lower wick</strong> = sellers tried to push price lower, but buyers overwhelmed them and pushed it back up. <em>Rejection below.</em></li>
  <li><strong>No wick (Marubozu)</strong> = one side was completely dominant. Price never pulled back. Strong momentum.</li>
</ul>
<div class="lesson-chart"><span class="lesson-chart-title">WICK INTERPRETATION AT A GLANCE</span>
<span class="bull">  Long lower wick → buyers rejected the lows → bullish sign</span>
<span class="bear">  Long upper wick → sellers rejected the highs → bearish sign</span>
<span class="bull">  Full green body  → strong buying, no pullback</span>
<span class="bear">  Full red body    → strong selling, no bounce</span>
<span class="label">  Doji (cross)     → indecision, no winner</span></div>
<div class="lesson-warn">A single candle is just one word in a paragraph. One candle does not make a trade. You read candles <em>in context</em> — where they appear, what the trend is, where the level is, what the candles next to them look like.</div>`
        },
        { id:"m2-l2", title:"Lesson 2: Bullish Reversal Patterns (Buy Signals)",
          body:`<p>A <em>reversal pattern</em> is a candlestick formation that appears at the end of a move and suggests price is about to change direction. Bullish reversal patterns appear at the bottom of downtrends — they warn that sellers are exhausted and buyers are taking over.</p>
<h4>1. The Hammer</h4>
<p>This is the single most reliable single-candle reversal pattern.</p>
<div class="lesson-chart"><span class="lesson-chart-title">THE HAMMER</span>
<span class="bear">        │</span>
<span class="bear">        │</span>
<span class="bear">        │</span>
<span class="bear">       ┌┴┐</span>
<span class="bull">       └─┘  ◄ small real body at the TOP</span>
<span class="bull">        │</span>
<span class="bull">        │</span>
<span class="bull">        │</span>
<span class="bull">        │   ◄ long lower wick (at least 2× body size)</span>
<span class="bull">        │</span>
<span class="sup">  ──────┴──  Support zone — sellers tried to break below, buyers slammed it back up</span></div>
<p><strong>Rules of a valid hammer:</strong></p>
<ol>
  <li>Must appear AFTER a visible downtrend (a series of lower highs and lower lows).</li>
  <li>The lower wick must be at least <strong>twice the size</strong> of the real body.</li>
  <li>The body (small) must be at the upper end of the range.</li>
  <li>Ideally, it closes ON or NEAR a key support level.</li>
  <li>Confirmation candle: the very next candle should be bullish (close above the hammer's high) — that confirms buying momentum.</li>
</ol>
<h4>2. Bullish Engulfing</h4>
<p>A two-candle pattern. The second candle is a large green candle whose body completely <em>engulfs</em> (covers) the body of the previous red candle.</p>
<div class="lesson-chart"><span class="lesson-chart-title">BULLISH ENGULFING</span>
<span class="bear">    ┌───┐</span>
<span class="bear">    │   │   Red candle (day 1)</span>
<span class="bear">    └─┬─┘</span>
<span class="bear">      │</span>
<span class="bull">  ┌───┴───────┐</span>
<span class="bull">  │  GREEN    │  Big green candle (day 2) completely wraps the red body</span>
<span class="bull">  └───────────┘</span></div>
<p>This is one of the strongest bullish signals — it means after sellers tried to push price lower, buyers came in with overwhelming force and completely erased the sellers' gains in one period.</p>
<h4>3. Morning Star (3 candles)</h4>
<p>One of the most reliable reversal patterns, found frequently at major bottoms.</p>
<div class="lesson-chart"><span class="lesson-chart-title">MORNING STAR</span>
<span class="bear">  ┌───────┐</span>
<span class="bear">  │ RED   │  Candle 1: long red — sellers in control</span>
<span class="bear">  └───┬───┘</span>
<span class="label">      ┌─┐</span>
<span class="label">      └─┘     Candle 2: small doji/spinning top — indecision</span>
<span class="bull">    ┌───┴───┐</span>
<span class="bull">    │ GREEN │  Candle 3: long green — buyers take over</span>
<span class="bull">    └───────┘</span></div>
<h4>4. Piercing Line</h4>
<p>A red candle followed by a green candle that opens gap-down (below the prior low) but then rallies to close above the MIDPOINT of the prior red body. Shows strong rejection of lower prices.</p>
<div class="lesson-example"><span class="ex-title">📊 Real example — EUR/USD, 15 March 2023, H1</span>
After a sharp drop following the US banking crisis, EUR/USD printed a clear hammer on the 16:00 candle with low at 1.0515 right at the 1.0500 psychological support. The next candle broke the hammer high (confirmation). Price rallied 85 pips to 1.0600 over the next 6 hours. This is the exact pattern our bot looks for on the M15/H1 confirmation timeframes.</div>`
        },
        { id:"m2-l3", title:"Lesson 3: Bearish Reversal Patterns (Sell Signals)",
          body:`<p>These appear at the top of uptrends and warn that buyers are exhausted.</p>
<h4>1. Shooting Star</h4>
<p>The mirror of the hammer. Small body at the bottom, long upper wick (at least 2× body). Appears at resistance.</p>
<div class="lesson-chart"><span class="lesson-chart-title">SHOOTING STAR</span>
<span class="resist">───┬────── Resistance — buyers tried to break above, failed</span>
<span class="bull">    │</span>
<span class="bull">    │  ◄ long upper wick</span>
<span class="bear">   ┌┴┐</span>
<span class="bear">   └─┘  ◄ small real body at the BOTTOM</span></div>
<h4>2. Bearish Engulfing</h4>
<p>Mirror of bullish engulfing: a large red candle completely wraps the body of the prior green candle at resistance.</p>
<h4>3. Evening Star</h4>
<p>Mirror of morning star: long green → small doji → long red. Found at major tops.</p>
<h4>4. Hanging Man</h4>
<p>Looks identical to a hammer, but appears at the TOP of an uptrend. The long lower wick shows buyers tried to hold the price up, but the close back in the lower half warns of exhaustion. Wait for the next candle to be red to confirm.</p>
<div class="lesson-warn"><span class="ex-title">⚠️ Critical rule</span>A hammer in the middle of a downtrend with no nearby support means nothing. A shooting star at a fresh high with no resistance nearby means nothing. Patterns must occur at STRUCTURAL LEVELS (support or resistance) to have any probability edge. The level is 80% of the signal; the candle is 20%.</div>`
        },
        { id:"m2-l4", title:"Lesson 4: Continuation Patterns & Candlestick Clusters",
          body:`<p>Not all candles predict a turn. Some tell you the existing trend has more fuel.</p>
<h4>Three White Soldiers</h4>
<p>Three consecutive long green candles, each opening within the prior candle's body and each closing near its high. Strong bullish continuation — sellers cannot stop the climb.</p>
<h4>Three Black Crows</h4>
<p>The bearish mirror: three long red candles in a row. Strong bearish continuation.</p>
<h4>Bull Flag / Bear Flag</h4>
<p>After a strong impulsive move (the "flagpole"), price pulls back in a small, tight channel sloping against the trend (the "flag"). When price breaks out of the flag in the direction of the original move, it usually continues with about the same length as the flagpole.</p>
<div class="lesson-chart"><span class="lesson-chart-title">BULL FLAG (continuation)</span>
<span class="bull">         ╱</span>
<span class="bull">        ╱    ← Flagpole (impulsive move up)</span>
<span class="bull">       ╱</span>
<span class="label">      ╱╲</span>
<span class="label">     ╱  ╲╱╲  ← Flag (tight pullback channel against trend)</span>
<span class="bull">   ╲╱    ╲</span>
<span class="bull">    ╲     ╲ ← Breakout, measured move ≈ flagpole length</span>
<span class="bull">     ╲</span></div>
<h4>Doji & Spinning Tops — indecision</h4>
<p>A candle with very small body (open ≈ close) means neither side won. In the middle of a range a doji is meaningless. After a long run, a doji can be a warning of exhaustion — especially if it appears at a level.</p>
<h3>Reading candles in clusters</h3>
<p>Never trade a single candle in isolation. Read the <em>story</em> of 5–10 candles together:</p>
<ul>
  <li>A cluster of small candles near support with long lower wicks = buyers absorbing selling pressure. Bullish.</li>
  <li>A cluster of small candles near resistance with long upper wicks = sellers absorbing buying pressure. Bearish.</li>
  <li>Green candles getting smaller as price approaches resistance = buying momentum fading.</li>
  <li>Red candles getting smaller as price approaches support = selling momentum fading.</li>
</ul>`
        }
      ]
    },
    // ═══════════════════ MODULE 3 — STRUCTURE ══════════════════════════
    {
      id:"m3", icon:"fa-layer-group",
      title:"Book 3: Support, Resistance & Market Structure",
      sub:"The invisible architecture of price — where battles are fought and winners declared",
      lessons:[
        { id:"m3-l1", title:"Lesson 1: Support and Resistance — The Floor and Ceiling",
          body:`<p>Price moves because buyers and sellers do battle. A <strong>support</strong> level is a price where buyers have repeatedly shown up in the past and pushed price higher — a floor. A <strong>resistance</strong> level is where sellers have repeatedly shown up and pushed price lower — a ceiling.</p>
<p>Levels form because large players (banks, funds) have memory. They remember where they bought and sold profitably before. They have orders resting at those levels: buy limits below price, sell limits above price. When price reaches those orders, the level holds — until one side overwhelms the other.</p>
<div class="lesson-chart"><span class="lesson-chart-title">SUPPORT AND RESISTANCE (illustrated)</span>
<span class="resist">  R2 ───────────────────────  ◄ ceiling: sellers here</span>
<span class="label">         │  ╱╲    ╱╲    ╱╲</span>
<span class="label">         │ ╱  ╲  ╱  ╲  ╱  ╲</span>
<span class="label">         │╱    ╲╱    ╲╱    ╲</span>
<span class="label">       ╱╲                     ╲</span>
<span class="label">      ╱  ╲                     ╲</span>
<span class="sup">  R1/S1 ──╲─────────────────────  ◄ flip-zone (broken resistance becomes support)</span>
<span class="label">      ╱    ╲    ╱╲    ╱╲</span>
<span class="label">     ╱      ╲  ╱  ╲  ╱  ╲</span>
<span class="label">    ╱        ╲╱    ╲╱    ╲</span>
<span class="sup">  S1 ────────────────────────  ◄ floor: buyers here</span></div>
<h3>How to draw levels correctly</h3>
<ol>
  <li><strong>Zoom out first.</strong> Start on D1, then H4. Draw levels on the HIGHER timeframes — they are the most important.</li>
  <li><strong>Connect wicks, not closes.</strong> Levels are zones, not exact prices. Look for clusters of highs/lows in the same area.</li>
  <li><strong>A level touched 3+ times is significant.</strong> But the MORE times a level is touched, the WEAKER it becomes (each test consumes orders resting there — eventually there's no one left to defend it).</li>
  <li><strong>Round numbers matter.</strong> 1.0800, 1.1000, 1.0500, 150.00 — institutions place orders at round numbers; these act as magnet levels.</li>
  <li><strong>Draw zones, not lines.</strong> Price rarely turns at exactly the same pip. A good "level" is a 10–30 pip zone where multiple swing highs/lows cluster.</li>
</ol>
<h3>Role reversal (the flip)</h3>
<p>The single most important concept in structure trading: <strong>when a level breaks, it flips role.</strong></p>
<ul>
  <li>A broken RESISTANCE becomes new SUPPORT (buyers now defend it).</li>
  <li>A broken SUPPORT becomes new RESISTANCE (sellers now defend it).</li>
</ul>
<div class="lesson-example"><span class="ex-title">📊 Real example — GBP/USD, 1.2500</span>
For 2 months in late 2024, 1.2500 acted as strong resistance — GBPUSD hit it three times and sold off 80–120 pips each time. On the fourth attempt (22 Oct), price broke cleanly above 1.2500 and closed at 1.2540. Three days later, price pulled back to 1.2500 and bounced 60 pips. The old ceiling had become the new floor. That is a textbook retest buy — exactly the setup this bot prioritises.</div>`
        },
        { id:"m3-l2", title:"Lesson 2: Swing Highs, Swing Lows & Why They Matter",
          body:`<p>A <strong>swing high</strong> is any price bar whose high is higher than the bars on either side of it. In this bot, we use a "5-bar" definition: a swing high has a higher high than the two bars before AND the two bars after it.</p>
<p>A <strong>swing low</strong> is the mirror — a low lower than two bars on each side.</p>
<p>Why this matters: swing highs and swing lows are the <em>turning points</em> — the exact prices where momentum shifted from buyers to sellers or vice versa. Institutional orders cluster around these points.</p>
<div class="lesson-chart"><span class="lesson-chart-title">SWING HIGHS AND LOWS DEFINE STRUCTURE</span>
<span class="bull">         ╱╲ SH</span>
<span class="bull">        ╱  ╲</span>
<span class="bull">       ╱    ╲  ╱╲ SH</span>
<span class="bull">      ╱      ╲╱  ╲</span>
<span class="bull">   SH ╱            ╲</span>
<span class="bull">    ╱╲              ╲</span>
<span class="label">   ╱  ╲</span>
<span class="sup">──╱────╲─────────────</span>
<span class="bull"> SL     SL</span></div>
<p>In an uptrend, the swing lows form your support structure — that's where you place stops. In a downtrend, the swing highs form your resistance. When a swing low is broken in an uptrend, the uptrend is damaged; when a swing high is broken in a downtrend, the downtrend is damaged.</p>
<div class="lesson-tip"><span class="ex-title">💡 Bot detail</span>This engine scans all 5 timeframes and detects swing highs/lows automatically (5-bar lookback). It then marks recent levels and uses them for SL/TP placement. You can see them rendered on the chart as dashed red/green lines.</div>`
        },
        { id:"m3-l3", title:"Lesson 3: Trends — How to Read the Market's Direction",
          body:`<p>There are only three states a market can be in:</p>
<h4>1. Uptrend (Bull Market)</h4>
<p>Price makes a sequence of <strong>Higher Highs (HH)</strong> and <strong>Higher Lows (HL)</strong>. Each rally reaches a new high; each pullback ends higher than the previous pullback. Buyers are in control.</p>
<div class="lesson-chart"><span class="lesson-chart-title">UPTREND — HH / HL structure</span>
<span class="bull">            ╱╲ HH2</span>
<span class="bull">           ╱  ╲╱╲</span>
<span class="bull">      HH1 ╱     ╲╲</span>
<span class="bull">     ╱╲  ╱       ╲╲</span>
<span class="bull">    ╱  ╲╱ HL2     ╲ HL3 forming...</span>
<span class="bull">   ╱ HL1</span>
<span class="bull">  ╱</span></div>
<h4>2. Downtrend (Bear Market)</h4>
<p>Price makes a sequence of <strong>Lower Highs (LH)</strong> and <strong>Lower Lows (LL)</strong>. Each push down reaches a new low; each pullback ends lower than the previous pullback. Sellers are in control.</p>
<h4>3. Range / Sideways / Consolidation</h4>
<p>Price bounces between a horizontal support and a horizontal resistance. Neither side can establish dominance. Ranges are dangerous for trend traders — the chop will shake you out repeatedly. Trade range strategies (buy support/sell resistance) or wait for a breakout.</p>
<h3>The 1-2-3 structure reversal</h3>
<p>A trend ends when the sequence breaks. In an uptrend:</p>
<ol class="lesson-step-list">
  <li>Price makes a higher high — then breaks below the last higher low (HL is violated).</li>
  <li>The subsequent rally fails to make a new high (prints a Lower High = LH).</li>
  <li>Price breaks below the low that formed after the LH. Trend is confirmed reversed.</li>
</ol>
<p>This is the earliest objective signal that a trend has ended. You do not need a magical indicator — structure tells you everything.</p>
<div class="lesson-warn"><span class="ex-title">⚠️ The #1 rule of this entire methodology</span>Only trade in the direction of higher-timeframe structure. If D1 is in an uptrend (HH/HL), take ONLY buy signals on H4/H1/M15. If D1 is in a downtrend (LH/LL), take ONLY sells. If D1 is in a range, wait for a breakout or don't trade. Trading against the higher timeframe is the #1 mistake new traders make.</div>`
        },
        { id:"m3-l4", title:"Lesson 4: Breakouts, Retests, Fakeouts",
          body:`<p>A <strong>breakout</strong> occurs when price closes beyond a support or resistance level with conviction. A break of resistance should trigger momentum from breakout buyers (people entering on the break) and stop-loss buyers (shorts being stopped out, which also drives buying).</p>
<h3>The anatomy of a genuine breakout</h3>
<ul>
  <li>Price approaches a tested level (3+ touches).</li>
  <li>On the approach, the candles leading into the level are impulsive (big bodies, small wicks, in the direction of the break).</li>
  <li>The breakout candle CLOSES beyond the level — not just wick-piercing it.</li>
  <li>Ideally volume increases on the break (we can't see tick volume in forex the same way as stocks, but ATR expansion is a proxy).</li>
  <li>After the break, price retests the level as its new role (e.g. broken resistance becomes support) and holds — that's the SAFEST entry.</li>
</ul>
<div class="lesson-chart"><span class="lesson-chart-title">BREAKOUT AND RETEST</span>
<span class="resist">  R ───────────┬───────────  ◄ resistance (tested 3 times)</span>
<span class="label">          ╱╲  │╱╲</span>
<span class="label">         ╱  ╲ │╱  ╲</span>
<span class="label">        ╱    ╲│BREAK╲──→  ◄ breaks and closes above R</span>
<span class="label">       ╱      │    ╱╲</span>
<span class="sup">  ─────────────┼───╱──╲───  ◄ RETEST — old R now acts as S</span>
<span class="label">              │  ╱    ╲</span>
<span class="bull">              │ ╱      ╲  ◄ entry on retest bounce</span></div>
<h3>Fakeouts (false breaks)</h3>
<p>A <strong>fakeout</strong> is when price pierces a level but fails to close beyond it, and snaps back into the range. They are designed to trap breakout traders who enter on the wick-pierce.</p>
<p>The classic fakeout is a "stop hunt" — price spikes just above a resistance level, triggers breakout orders and stops of short traders, then collapses back into the range. These are brutal for new traders who FOMO into the break.</p>
<div class="lesson-tip"><span class="ex-title">💡 How to avoid fakeouts</span>Wait for a CLOSE beyond the level — not a wick. Even better: wait for the retest. Entering on a retest sacrifices a few pips of profit but eliminates 70% of fakeouts. This bot requires both a close and a structural confirmation before signalling.</div>
<h3>The "stop hunt" phenomenon</h3>
<p>This is controversial, but it's real: price will often visit obvious levels (recent swing highs/lows, round numbers) just to take out stops before reversing. Why? Because the large players need liquidity to enter — and clusters of retail stop-losses are free liquidity. Don't take it personally; just place your stops slightly beyond structure rather than at the exact level.</p>`
        }
      ]
    },
    // ═══════════════════ MODULE 4 — INDICATORS ═════════════════════════
    {
      id:"m4", icon:"fa-wave-square",
      title:"Book 4: Indicators — Tools, Not Oracles",
      sub:"EMA, SMA, RSI, MACD, ATR — what they actually measure and how to combine them",
      lessons:[
        { id:"m4-l1", title:"Lesson 1: Moving Averages — Trend's Best Friend",
          body:`<p>A <em>moving average</em> (MA) is simply the average closing price over the last N periods, plotted as a line on your chart. It "smooths" price so you can see the trend through the noise.</p>
<p>We use four in this system:</p>
<table>
<tr><th>Indicator</th><th>Length</th><th>Type</th><th>Purpose</th></tr>
<tr><td>Fast EMA</td><td>9</td><td>Exponential</td><td>Short-term momentum; reacts fast to turns</td></tr>
<tr><td>Slow EMA</td><td>21</td><td>Exponential</td><td>Short-term trend; our "trade trigger" MA</td></tr>
<tr><td>Medium SMA</td><td>50</td><td>Simple</td><td>Medium-term trend; the "working" average</td></tr>
<tr><td>Long SMA</td><td>200</td><td>Simple</td><td>Long-term trend; institutional benchmark</td></tr>
</table>
<p><strong>Exponential (EMA)</strong> gives more weight to recent candles — it reacts faster. <strong>Simple (SMA)</strong> weights every candle equally — it's slower but more stable.</p>
<h3>Stack alignment — the trend compass</h3>
<p>When all four MAs are aligned in order and price is on the right side of them, the trend is strong and healthy:</p>
<div class="lesson-chart"><span class="lesson-chart-title">BULL STACK (strong uptrend)</span>
<span class="bull">  Price</span>
<span class="bull">  ───── EMA 9 ─────    ◄ fastest, closest to price</span>
<span class="bull">  ─────── EMA 21 ─────</span>
<span class="bull">  ───────── SMA 50 ────────</span>
<span class="bull">  ───────────── SMA 200 ────────────  ◄ slowest, farthest from price</span>
<span class="label">  All pointing UP, price above all → STRONG BULLISH TREND</span></div>
<p>The reverse (SMA200 on top, EMA9 on bottom, price below all) is a <strong>bear stack</strong> — strong downtrend.</p>
<p>When the MAs are tangled, twisted, and crossing each other frequently, the market is in a range or transition — avoid trending strategies there.</p>
<h3>Golden cross and death cross</h3>
<p>When the SMA 50 crosses above the SMA 200 from below, that's a <strong>golden cross</strong> — a major long-term bullish signal. When SMA 50 crosses below SMA 200, that's a <strong>death cross</strong> — long-term bearish signal. These don't happen often (once every 1–3 years on D1), but they have correctly called every major bull and bear market for decades.</p>
<div class="lesson-warn">Moving averages are LAGGING indicators. They tell you what HAS happened, not what WILL happen. Never use an MA crossover alone as an entry signal — wait for price action confirmation at structure.</div>`
        },
        { id:"m4-l2", title:"Lesson 2: RSI — Momentum & Overbought/Oversold",
          body:`<p>The <strong>Relative Strength Index (RSI)</strong> is a momentum oscillator that compares the size of recent up-moves to recent down-moves over 14 periods. It outputs a number between 0 and 100.</p>
<div class="lesson-chart"><span class="lesson-chart-title">RSI ZONES</span>
<span class="bear">  100 │─── Overbought territory (>70)</span>
<span class="bear">   70 │┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄</span>
<span class="label">      │   Neutral zone</span>
<span class="label">   50 │───────────────────  ◄ centre line</span>
<span class="label">      │   Neutral zone</span>
<span class="bull">   30 │┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄</span>
<span class="bull">    0 │─── Oversold territory (<30)</span></div>
<h3>Four RSI signals we use</h3>
<ol>
  <li><strong>Overbought (RSI > 70)</strong>: momentum is stretched upward — a pullback may be coming. <em>In strong trends, RSI can stay above 70 for weeks.</em></li>
  <li><strong>Oversold (RSI < 30)</strong>: momentum is stretched downward — a bounce may be coming. Same caveat.</li>
  <li><strong>50-cross bullish</strong>: RSI crosses back ABOVE 50 from below — momentum is shifting up. Used as confirmation.</li>
  <li><strong>50-cross bearish</strong>: RSI crosses back BELOW 50 from above — momentum shifting down.</li>
</ol>
<h3>The real power of RSI: divergence</h3>
<p><strong>Bullish divergence</strong> occurs when price makes a NEW LOWER LOW, but RSI makes a HIGHER LOW. Price is falling, but momentum is weakening — a reversal is likely. This is one of the most reliable early warning signals.</p>
<p><strong>Bearish divergence</strong> is the mirror: price makes a new higher high, RSI makes a lower high — momentum fading at the top.</p>
<div class="lesson-example"><span class="ex-title">📊 Worked example — GBP/USD D1, Sep 2022 crash</span>
After GBP/USD crashed to an all-time low of 1.0350 during the Truss mini-budget crisis, daily RSI printed a clear bullish divergence: price made a lower low (1.0350 vs 1.0538) but RSI made a higher low (21 vs 18). Price rallied 1,500 pips over the next 3 months to 1.2450. Divergence on D1 is powerful — we always check for it.</div>`
        },
        { id:"m4-l3", title:"Lesson 3: MACD — The Momentum Trigger",
          body:`<p><strong>MACD</strong> (Moving Average Convergence Divergence) consists of three parts:</p>
<ul>
  <li><strong>MACD line</strong>: the difference between the 12-period EMA and 26-period EMA</li>
  <li><strong>Signal line</strong>: 9-period EMA of the MACD line</li>
  <li><strong>Histogram</strong>: the difference between MACD and signal lines, plotted as bars above/below zero</li>
</ul>
<h3>How we use it</h3>
<p>MACD is <em>not</em> a primary indicator for us — it is an <strong>entry timing trigger</strong>. We use it on the confirmation timeframe (H1/M15) to help us pick the moment to enter once all higher-timeframe conditions are met.</p>
<ul>
  <li><strong>Bullish crossover</strong>: MACD line crosses above signal line from below, ideally while below the zero line → momentum turning up.</li>
  <li><strong>Bearish crossover</strong>: MACD crosses below signal from above → momentum turning down.</li>
  <li><strong>Histogram shrinking toward zero</strong>: current momentum losing steam.</li>
  <li><strong>Divergence</strong>: same principle as RSI divergence — price makes new extreme but MACD does not → warning of reversal.</li>
</ul>
<div class="lesson-warn">MACD crossovers give many false signals in choppy markets. Never use MACD as your sole reason for entering. It is a timing tool — we only act on a crossover when D1 trend, H4 structure, and H1 price action all agree.</div>`
        },
        { id:"m4-l4", title:"Lesson 4: ATR — The Most Underrated Indicator in Trading",
          body:`<p><strong>ATR</strong> (Average True Range) measures volatility — specifically, how much price typically moves in one bar, averaged over 14 periods. ATR does not tell you DIRECTION. It tells you SIZE.</p>
<p>For EUR/USD on H1, a typical ATR is about 10–15 pips. During news it might spike to 30+. During Asian chop it might sit at 5–6.</p>
<h3>Three critical uses of ATR</h3>
<h4>1. Stop loss distance</h4>
<p>We place stops at <strong>1.5 × ATR</strong> beyond the recent swing high/low. This gives enough room that normal noise won't stop us out, but tight enough that our risk is controlled. If ATR is 12 pips, SL is 18 pips away. If ATR is 25 pips (volatile), SL is 37 pips away — and we trade smaller size to keep dollar risk the same.</p>
<h4>2. Position sizing</h4>
<p>When ATR widens, each pip is "more dangerous" — your stop has to be wider, so you reduce lot size to keep the dollar risk constant (see Book 5). This is professional risk management. Beginners use the same lot size regardless of volatility — that's why they get destroyed on news days.</p>
<h4>3. Volatility filter</h4>
<p>This bot refuses to trade when ATR is more than 50% above its recent average (extreme volatility — usually news) or when ATR is less than 30% of its average (dead market — chop, not enough reward potential).</p>
<div class="lesson-math">Lot Size = (Account Risk in R) / (Stop Distance in Pips × Pip Value per Lot)</div>
<div class="lesson-example"><span class="ex-title">📊 Position-size math</span>
Account: R10,000. Risk per trade: 1% = R100.<br/>
Trade: EUR/USD BUY, entry 1.0850, SL 1.0832 (18 pips).<br/>
Pip value for 1.00 standard lot on EUR/USD ≈ $10/ pip ≈ R185/pip.<br/>
Lot = R100 / (18 × R18.5) ≈ R100 / R333 ≈ <strong>0.30 lots</strong>.<br/>
If ATR doubles to 24 pips, SL becomes 36 pips: Lot = R100 / (36 × R18.5) ≈ <strong>0.15 lots</strong> — we cut size in half.<br/>
This is how professionals stay in the game through all market conditions.</div>`
        }
      ]
    },
    // ═══════════════════ MODULE 5 — RISK MANAGEMENT (book-length) ══════
    {
      id:"m5", icon:"fa-shield-halved",
      title:"Book 5: Risk Management — The Chapter That Saves Your Account",
      sub:"If you only read one chapter, read this one. Risk management is trading.",
      lessons:[
        { id:"m5-l1", title:"Lesson 1: Why Risk Management is EVERYTHING",
          body:`<p>Let me tell you a story. I know a trader named Thabo from Pretoria. He was a talented chart reader. He could spot a good setup better than most professionals. In his first three months he turned R5,000 into R75,000. He was convinced he was a genius. Then he made the mistake that destroys almost every talented new trader: he decided the rules didn't apply to him.</p>
<p>He took a GBP/JPY trade during a news event with no stop loss. When the trade went against him, he added to the position. Then added again. Then again, praying for a reversal. Over the course of three hours he lost R82,000 — more than his entire account.</p>
<p>Thabo was not a bad trader. He was an untaught trader. He had no risk management. And risk management is not <em>part</em> of trading — it IS trading. Entry strategies are easy; anyone can learn to spot a pattern. Risk management is the discipline that keeps you in the game through the inevitable losing streaks.</p>
<div class="lesson-quote">You can have the best entry system in the world and still go broke without risk management. You can have a mediocre entry system and become wealthy with strict risk management.</div>
<h3>The math of ruin</h3>
<p>The table below shows your probability of losing 50% of your account before doubling it, at different risk-per-trade and win-rate assumptions:</p>
<table>
<tr><th>Risk per trade</th><th>Win rate 40% (1:2 R:R)</th><th>Win rate 50% (1:2 R:R)</th><th>Win rate 50% (1:1 R:R)</th></tr>
<tr><td>1%</td><td>25% ruin risk</td><td>3% ruin risk</td><td>13% ruin risk</td></tr>
<tr><td>2%</td><td>50% ruin risk</td><td>13% ruin risk</td><td>33% ruin risk</td></tr>
<tr><td>5%</td><td>85% ruin risk</td><td>50% ruin risk</td><td>67% ruin risk</td></tr>
<tr><td>10%</td><td>99% ruin risk</td><td>92% ruin risk</td><td>93% ruin risk</td></tr>
</table>
<p>Look at the numbers. At 1% risk with a decent edge, ruin is unlikely. At 5% it's a coin flip. At 10% you are GUARANTEED to blow up over a long enough timeline.</p>
<div class="lesson-warn"><span class="ex-title">⚠️ Non-negotiable rules</span>
1. Never risk more than 1–2% of account on a single trade.<br/>
2. Always use a stop loss — place it BEFORE you enter.<br/>
3. Never move your stop further away when price goes against you.<br/>
4. Never add to a losing position ("averaging down").<br/>
5. Have a daily loss limit (3% of account) — hit it and shut the platform.<br/>
6. Never trade with money you cannot afford to lose.</div>`
        },
        { id:"m5-l2", title:"Lesson 2: Position Sizing — The Exact Formula",
          body:`<p>Position sizing is the most important calculation you will ever make in trading. The formula is simple:</p>
<div class="lesson-math">Lot Size = (Account × Risk%) / (Pips_to_SL × Pip_Value_per_Lot)</div>
<p>Where:</p>
<ul>
  <li><strong>Account</strong> = current account balance</li>
  <li><strong>Risk%</strong> = percentage you'll risk (we use 0.01 = 1%)</li>
  <li><strong>Pips_to_SL</strong> = distance from entry to stop loss, in pips</li>
  <li><strong>Pip_Value_per_Lot</strong> = how much 1 pip is worth in your account currency per 1.00 lot</li>
</ul>
<h3>Pip values (ZAR account, approximate)</h3>
<table>
<tr><th>Pair</th><th>Pip size</th><th>Value of 1 pip per 1.00 lot</th></tr>
<tr><td>EUR/USD</td><td>0.0001</td><td>~ R185 (at USD/ZAR ≈ 18.50)</td></tr>
<tr><td>GBP/USD</td><td>0.0001</td><td>~ R185</td></tr>
<tr><td>USD/JPY</td><td>0.01</td><td>~ R170 (varies with USD/JPY rate)</td></tr>
<tr><td>USD/CHF</td><td>0.0001</td><td>~ R205 (varies with CHF rate)</td></tr>
<tr><td>AUD/USD</td><td>0.0001</td><td>~ R185</td></tr>
<tr><td>USDCAD</td><td>0.0001</td><td>~ R175 (varies with CAD rate)</td></tr>
<tr><td>XAU/USD (Gold)</td><td>0.10</td><td>~ R185</td></tr>
</table>
<h3>Worked examples</h3>
<div class="lesson-box">
<div class="lesson-box-title">📊 Example 1 — EUR/USD BUY</div>
Account: R10,000 | Risk: 1% = R100<br/>
Entry: 1.0850 | SL: 1.0832 | Distance: 18 pips<br/>
Pip value: R18.50 per 0.10 lot (or R185 per 1.00 lot)<br/>
<strong>Risk per 0.10 lot</strong> = 18 × R18.50 = R333 per 0.10 lot? Wait — no. Let's do this properly.<br/>
Pip value on R-denominated account ≈ R18.50/pip per 1.00 lot.<br/>
For 0.10 lots: R1.85/pip. 18 pips × R1.85 = R33.30 risk per 0.10 lot.<br/>
So lots needed for R100 risk: R100 / R33.30 per 0.10 lot ≈ <strong>0.30 lots</strong>.
</div>
<div class="lesson-box">
<div class="lesson-box-title">📊 Example 2 — GBP/USD SELL (volatile day)</div>
Account: R10,000 | Risk: 1% = R100<br/>
Entry: 1.2750 | SL: 1.2795 (wider due to ATR) | Distance: 45 pips<br/>
Pip value: R18.50 per 0.10 lot → R832 risk per 1.00 lot / 45 pips<br/>
At 0.10 lot: 45 × R1.85 = R83.25 risk.<br/>
Max lots for R100 risk: R100 / R832 per 1.00 lot ≈ <strong>0.12 lots</strong>.<br/>
Notice: wider stop → smaller size. Your dollar risk stays the same.
</div>
<p>The bot calculates all of this for you automatically. But you MUST understand why it does what it does.</p>`
        },
        { id:"m5-l3", title:"Lesson 3: Risk/Reward — Why 1:1.5 is the Floor",
          body:`<p><strong>Risk/Reward ratio (R:R)</strong> is simply how much you stand to GAIN divided by how much you RISK.</p>
<p>A trade risking 30 pips to make 60 pips is 1:2 R:R.</p>
<p>A trade risking 40 pips to make 40 pips is 1:1.</p>
<p>A trade risking 50 pips to make 25 pips is 1:0.5 — and you should NEVER take it.</p>
<div class="lesson-math">R:R = (Take Profit distance from Entry) ÷ (Stop Loss distance from Entry)</div>
<p>The magic of trading is that you don't need to win most of the time to be profitable. You just need your wins to be BIGGER than your losses:</p>
<table>
<tr><th>R:R</th><th>Win rate needed to break even</th><th>Comment</th></tr>
<tr><td>1:1</td><td>50%</td><td>Need to win half the time</td></tr>
<tr><td>1:1.5</td><td>40%</td><td>Win 4 out of 10 and break even</td></tr>
<tr><td>1:2</td><td>33%</td><td>Win 1 in 3 and break even</td></tr>
<tr><td>1:3</td><td>25%</td><td>Win 1 in 4 and break even</td></tr>
<tr><td>1:5</td><td>17%</td><td>Win 1 in 6 and break even</td></tr>
</table>
<div class="lesson-example"><span class="ex-title">📊 Expectancy math</span>
If you win 45% of trades, average win = 2R, average loss = 1R:<br/>
Expectancy per trade = (0.45 × 2R) − (0.55 × 1R) = 0.9R − 0.55R = <strong>+0.35R per trade</strong><br/>
That means every trade you take is worth +0.35R on average. At 1% risk, that's +0.35% of account per trade. 10 trades a month = +3.5% per month. Compounded over a year that's 50%+. This is how slow, steady fortunes are built — NOT by chasing 100% winners.</div>
<h4>Scaling out (partial profit-taking)</h4>
<p>Our preferred approach:</p>
<ol>
  <li>At TP1 (1.5R), take off 50% of the position, move stop loss to break-even (entry). Now the remaining 50% is risk-free.</li>
  <li>At TP2 (3R), take off another 30%.</li>
  <li>Let the final 20% run with a trailing stop, capturing extended moves if price runs.</li>
</ol>
<p>By taking partial profits, you lock in gains early and give yourself a chance to catch the big runners without giving back all your profit.</p>`
        },
        { id:"m5-l4", title:"Lesson 4: The Trading Plan, Daily Routine & Loss Protocols",
          body:`<h3>Your written trading plan</h3>
<p>Before you place one more real trade, write down:</p>
<ul>
  <li>Which pairs you trade (stick to the 10 in the bot)</li>
  <li>Which sessions you trade (London/NY overlap preferred)</li>
  <li>Your entry rules (specifically)</li>
  <li>Your SL rules (1.5 ATR behind swing)</li>
  <li>Your TP rules (1.5R min, scale out at 1.5R/3R)</li>
  <li>Max position size (1% per trade, max 2 open trades)</li>
  <li>Daily loss limit (3%) and weekly loss limit (6%)</li>
  <li>When you DON'T trade (news, bank holidays, Friday afternoons)</li>
</ul>
<p>Print it out and tape it next to your screen.</p>
<h3>Daily routine</h3>
<ol class="lesson-step-list">
  <li><strong>Pre-market (08:00 SAST)</strong>: Check economic calendar. Mark major news for the day. Review D1 charts of all pairs, noting levels and trend direction.</li>
  <li><strong>London open (09:00)</strong>: Drop to H4/H1. Wait for setups. Don't force trades — if nothing is there, walk away.</li>
  <li><strong>Entry</strong>: When a setup triggers, write down entry, SL, TP, and reason BEFORE clicking buy/sell. Log in the journal.</li>
  <li><strong>Management</strong>: Once in, set alerts and walk away. Do NOT watch every tick (it causes stupid decisions).</li>
  <li><strong>Review (19:00)</strong>: Journal all trades — winners AND losers. What went right? What went wrong? Did you follow the plan?</li>
</ol>
<h3>Loss protocol — what to do after a loss</h3>
<div class="lesson-warn">
<ul>
<li>❌ Do NOT open another trade immediately to "make it back."</li>
<li>❌ Do NOT increase size on the next trade.</li>
<li>❌ Do NOT move your stop, cancel your stop, or revenge-trade.</li>
<li>✅ DO step away for 30 minutes. Drink water. Walk.</li>
<li>✅ DO review the losing trade in your journal. Was it a valid setup that just didn't work out? Or did you break a rule?</li>
<li>✅ If you lose twice in a row, stop for the day. Two losses means your edge is not present today.</li>
</ul>
</div>`
        }
      ]
    },
    // ═══════════════════ MODULE 6 — PSYCHOLOGY ════════════════════════
    {
      id:"m6", icon:"fa-brain",
      title:"Book 6: The Psychology of a Disciplined Trader",
      sub:"80% of trading happens between your ears",
      lessons:[
        { id:"m6-l1", title:"Lesson 1: The Six Emotional Enemies (and How to Beat Them)",
          body:`<h4>1. Fear</h4>
<p>Causes you to hesitate when you should enter, to exit winning trades too early, and to widen stops on losing trades. The antidote: <em>trust the system</em>. If the setup meets your written criteria, take it. The outcome of one trade is random; the edge plays out over 50+ trades.</p>
<h4>2. Greed</h4>
<p>Makes you over-leverage, add to positions too late, skip taking profit when TP hits because "it might go further". The antidote: <em>have pre-set TP levels and take them</em>. The market always gives another setup; it does not always give back your profit.</p>
<h4>3. Hope</h4>
<p>The most dangerous emotion in trading. Hope makes you move stops, hold losers, add to losing positions because "it must come back". Sometimes it doesn't. The antidote: <em>your stop loss is where you are wrong. If it hits, you are wrong. Accept it and move on.</em></p>
<h4>4. Revenge</h4>
<p>After a loss, the amygdala screams "GET IT BACK". Traders revenge-trade to punish the market for taking their money. It never works. The market is not a person and it does not care about you. The antidote: <em>enforce a hard rule of zero trades for 30 minutes after any loss. Two losses in a row = close the platform for the day.</em></p>
<h4>5. Overconfidence</h4>
<p>Three wins in a row and you think you're Rain Man. You start taking sloppy setups, sizing up, skipping the checklist. This is how you give back a month's profit in a day. The antidote: <em>review your trades after every win. Did you actually follow the plan, or did you just get lucky?</em></p>
<h4>6. Boredom</h4>
<p>The quiet killer. On slow days you will itch to trade just because sitting still is uncomfortable. Most "boredom trades" lose money. The antidote: <em>the market owes you nothing. Not trading IS a position. The best trade of the day is often no trade.</em></p>
<div class="lesson-quote">The market does not reward intelligence. It rewards patience, discipline, and emotional control. A trader of average intelligence with perfect discipline will beat a genius with no discipline every single time.</div>`
        },
        { id:"m6-l2", title:"Lesson 2: Building Discipline Through Process",
          body:`<p>Discipline is not a personality trait. It is a HABIT. You build it the same way you build muscle — through repetition and small daily wins.</p>
<h3>Practical techniques</h3>
<ol>
  <li><strong>The checklist rule.</strong> Before every trade, physically (or mentally) tick off your pre-trade checklist. If you cannot tick every box, no trade. The bot does this for you — if the signal is below 60 strength, it says NO TRADE. Train yourself to do the same.</li>
  <li><strong>The 24-hour rule.</strong> Never trade the day you open your account. Never size up until you've executed 50 trades at the current size profitably.</li>
  <li><strong>The journal habit.</strong> Write a paragraph on every trade within 5 minutes of opening it. Screenshot it. After 100 trades you will SEE your patterns of error — and you can fix them.</li>
  <li><strong>Meditation / breathing.</strong> Before you click Buy/Sell, take three deep breaths. Check your heart rate. If you're excited or angry, you shouldn't be clicking anything.</li>
  <li><strong>Accountability.</strong> Show your journal to another trader you respect. The fear of showing someone a stupid revenge trade is a powerful deterrent.</li>
  <li><strong>Monkey-brain detachment.</strong> Remind yourself: the outcome of any ONE trade is random. You don't care about any single trade — you care about the average of 100 trades.</li>
</ol>`
        },
        { id:"m6-l3", title:"Lesson 3: Expectancy, Sample Size & The Casino Mindset",
          body:`<p>Let me tell you how a casino makes money. On a roulette wheel, there are 37 numbers (0–36). If you bet on a single number, the payout is 35-to-1. But the odds are 37-to-1 against you. The casino's edge is (35/37) − 1 = −2.7% for the player (the house wins 2.7% of every bet on average).</p>
<p>Does the casino care that someone just won R1 million on a single number? No. They don't even flinch. Because they know that over 100,000 spins, that edge is mathematically guaranteed to produce profit.</p>
<p>Your job as a trader is to BE THE CASINO, not the gambler.</p>
<div class="lesson-math">Expectancy = (Win Rate × Average Win) − (Loss Rate × Average Loss)</div>
<p>If expectancy is positive, every trade you take puts money in your pocket ON AVERAGE — even though individual trades will lose.</p>
<div class="lesson-example"><span class="ex-title">📊 Example</span>
After 100 trades: 45 wins, 55 losses.<br/>
Average win: R200 (2R with 1% = R100 risk, 2R target).<br/>
Average loss: R100 (1R).<br/>
Gross wins: 45 × R200 = R9,000.<br/>
Gross losses: 55 × R100 = R5,500.<br/>
Net profit: R3,500 over 100 trades = <strong>+R35 per trade average</strong>.<br/>
You lost MORE TRADES than you won, and you still made R3,500. That is the power of risk/reward.
</div>
<div class="lesson-tip"><span class="ex-title">💡 Mindset shift</span>Stop judging yourself on individual trades. Judge yourself on whether you FOLLOWED YOUR PROCESS. Process wins = profit over time. Process breaks = losses over time. P/L follows process; the rest is noise.</div>`
        }
      ]
    },
    // ═══════════════════ MODULE 7 — FULL WALKTHROUGH ══════════════════
    {
      id:"m7", icon:"fa-magnifying-glass-chart",
      title:"Book 7: A Complete Trade Walkthrough — EUR/USD Step by Step",
      sub:"Putting everything together: D1 → H4 → H1 → M15 → M5 on a real setup",
      lessons:[
        { id:"m7-l1", title:"Lesson 1: Step 1 — Daily (D1) Trend Bias",
          body:`<p>This is a real trade setup from January 2025, walking the multi-timeframe process exactly as the bot does it. We'll look for a BUY on EUR/USD.</p>
<h3>D1 (Daily) context</h3>
<p>Step one: ALWAYS look at D1 first. This is the "big picture" — where institutions are positioned.</p>
<div class="lesson-chart"><span class="lesson-chart-title">EUR/USD D1 — late December 2024 / January 2025</span>
<span class="bull">                              1.1000 ─── R1 (recent swing high)</span>
<span class="bull">                                  ╱╲</span>
<span class="bull">                              ╱╱  ╲╱╲</span>
<span class="bull">                           ╱╱        ╲</span>
<span class="bull">                        ╱╱             ╲</span>
<span class="label">                     ╱╱                 ╲  ← pullback</span>
<span class="sup">   support 1.0700 ──╱─────────────────────╲───────</span>
<span class="bull">                  ╱                        ╲╱╲</span>
<span class="bull">               ╱╱                            ╲</span>
<span class="bull">            ╱╱                               ╲ ← we are here</span>
<span class="bull">         ╱╱</span>
<span class="sup">   1.0600 ──── major support (prior breakout zone)</span>
<span class="label"></span>
<span class="label">   Assessment: HH/HL sequence intact (uptrend). Pullback to 1.0700 confluence zone.</span>
<span class="label">   MAs: EMA9 > EMA21 > SMA50 — bull stack. RSI pulling back to 42 from overbought — healthy.</span>
<span class="bull">   → D1 BIAS = BULLISH. We only look for BUYS.</span>
</div>
<p>At this point we do NOT have a trade. We only have a DIRECTIONAL BIAS. Now we drop to H4 to look for structure.</p>`
        },
        { id:"m7-l2", title:"Lesson 2: Step 2 — H4 Structure & Key Level",
          body:`<p>Dropping to H4, we zoom into the pullback to find the exact structural zone where buyers might return.</p>
<div class="lesson-chart"><span class="lesson-chart-title">EUR/USD H4 — January 2025 pullback detail</span>
<span class="bull">       1.0850 ── EMA21 resistance</span>
<span class="label">             ╱╲  ╱╲</span>
<span class="label">            ╱  ╲╱  ╲</span>
<span class="label">           ╱    ╲    ╲</span>
<span class="sup">  1.0750 ─╱─────────────╲── 61.8% Fibonacci retracement + prior swing low</span>
<span class="bull">         ╱               ╲</span>
<span class="label">        ╱                 ╲╱╲</span>
<span class="bull">       ╱                     ╲</span>
<span class="sup">  1.0700 ──────────────────────── major structural support (confluence zone)</span>
<span class="label">                                   ╲╱╲</span>
<span class="label">                                     ╲ ← H4 printing hammer-like candles</span>
<span class="label"></span>
<span class="label">   Assessment: Price testing 1.0700–1.0720 zone. H4 candles showing long lower wicks</span>
<span class="label">   (buyers absorbing selling). EMA21 sloping up above. Bull stack intact.</span>
<span class="bull">   → H4 CONFIRMS BULLISH BIAS. Key BUY ZONE: 1.0700–1.0720.</span>
</div>
<p>Now we have a zone of interest. We drop to H1 to wait for a trigger.</p>`
        },
        { id:"m7-l3", title:"Lesson 3: Step 3 — H1 Entry Trigger & SL/TP Planning",
          body:`<p>On H1, price arrives at the 1.0700–1.0720 zone. We wait for a confluence of:</p>
<ol>
  <li>Bullish candlestick pattern (hammer, bullish engulfing, or piercing line) in the zone</li>
  <li>RSI turning up from below 40 (oversold in an uptrend)</li>
  <li>MACD crossing bullish (signal line from below)</li>
  <li>A break of structure (higher high printed on H1 after the pattern)</li>
</ol>
<div class="lesson-chart"><span class="lesson-chart-title">EUR/USD H1 — Entry trigger at support zone</span>
<span class="resist"> 1.0780 ───────────── TP target (recent H1 swing high / ~1.5R)</span>
<span class="label">             ╱╲</span>
<span class="label">            ╱  ╲</span>
<span class="label">     ╱╲   ╱    ╲</span>
<span class="label">    ╱  ╲ ╱      ╲</span>
<span class="entry">  ╱╱   ╳ 1.0725 ─╲──── ENTRY (break of candle high at 1.0725 after hammer)</span>
<span class="sup">  ╱     ╲H╲       ╲</span>
<span class="label">  ╲      ╲A╲       ╲</span>
<span class="sup">   ╲      ╲M╲──────╲╲  ← hammer forms in buy zone, wick to 1.0695</span>
<span class="bear">    ╲ 1.0685 ──────────── SL (below wick low, ~40 pip stop = ~1.2 ATR)</span>
<span class="label"></span>
<span class="label">   RSI on H1: came down to 28 (oversold), curling up.</span>
<span class="label">   MACD: just crossed bullish below zero.</span>
<span class="bull">   → TRIGGER CONFIRMED. BUY at 1.0725.</span>
</div>
<h4>Trade parameters</h4>
<table>
<tr><th>Parameter</th><th>Value</th><th>Reason</th></tr>
<tr><td>Direction</td><td>BUY</td><td>D1+H4 bullish, H1 trigger at support</td></tr>
<tr><td>Entry</td><td>1.0725</td><td>Break of hammer high (confirmation)</td></tr>
<tr><td>Stop loss</td><td>1.0685</td><td>Below hammer wick (just below the zone). 40-pip risk.</td></tr>
<tr><td>TP1 (1.5R)</td><td>1.0785</td><td>60 pips up (40 × 1.5) — coinciding with H1 swing high</td></tr>
<tr><td>TP2 (3R)</td><td>1.0845</td><td>120 pips up (40 × 3) — EMA21/H4 resistance zone</td></tr>
<tr><td>R:R to TP1</td><td>1:1.5</td><td>Meets minimum threshold</td></tr>
<tr><td>Strength</td><td>76/100</td><td>All 5 TFs aligned, 4 confluence factors</td></tr>
</table>
<p>On a R10,000 account, 1% risk = R100. 40 pips on EUR/USD ≈ R18.5 per pip per 1.00 lot. Lot size = R100 / (40 × R18.5) ≈ 0.13 lots (let's say 0.15 lots for a round number — slightly over, but we keep it tight).</p>`
        },
        { id:"m7-l4", title:"Lesson 4: Step 4 — M15/M5 Timing, Trade Management & Outcome",
          body:`<p>For those who want a more precise entry, dropping to M15 (and optionally M5) can tighten the entry and improve R:R. At M15 we see a micro-structure: a double bottom at 1.0695/1.0698, with a bullish engulfing on the second touch. M5 confirms with a small morning star. Entering at 1.0710 instead of 1.0725 gives an extra 15 pips of R:R.</p>
<h4>Trade management (as it plays out)</h4>
<ol class="lesson-step-list">
  <li><strong>Entry:</strong> BUY @ 1.0725, SL @ 1.0685 (40 pip risk).</li>
  <li><strong>+3 hours:</strong> Price grinds up to 1.0760. No action needed. Heart rate stays normal.</li>
  <li><strong>+7 hours (London session close):</strong> Price hits 1.0785 (TP1, 60 pips / +1.5R). Close 50% of position (0.07 lots). Move SL to break-even at 1.0725. Remaining 0.08 lots are now RISK-FREE.</li>
  <li><strong>+14 hours (next day):</strong> Price pulls back to 1.0740, holds above break-even SL. No drama — this is a healthy pullback in an uptrend.</li>
  <li><strong>+24 hours:</strong> Price pushes through 1.0800 and runs to 1.0845 (TP2, 120 pips / +3R). Close another 30% (0.04 lots) at +3R. Trail the remaining 20% (0.04 lots) with a 1.5-ATR trailing stop.</li>
  <li><strong>+36 hours:</strong> Price reaches 1.0880 before pulling back; trailing stop hits at 1.0860 for a 135-pip winner on the last piece (~3.4R).</li>
</ol>
<h4>P&L for the trade (R10,000 account, 0.15 lots total)</h4>
<div class="lesson-chart"><span class="lesson-chart-title">TRADE RESULT</span>
<span class="bull">  TP1: 0.07 lots × 60 pips × R1.85/pip per 0.01 lot = 0.07 × R111 = +R77.70</span>
<span class="bull">  TP2: 0.05 lots × 120 pips × R1.85 = 0.05 × R222 = +R111.00</span>
<span class="bull">  Trail: 0.03 lots × 135 pips × R1.85 = 0.03 × R250 = +R75.00</span>
<span class="bull">  ─────────────────────────────────────────</span>
<span class="bull">  TOTAL WIN: ≈ +R264 (about +2.6% on the account in 36 hours)</span>
<span class="label">  Risk was R100 max (had SL hit, loss = 0.15 lots × 40pips × R18.5 = R111)</span>
<span class="label">  Realised R:R on whole position ≈ 2.4R winner.</span>
</div>
<div class="lesson-tip"><span class="ex-title">💡 This is the point</span>You don't need many of these. Two trades a week like this is 5% per week. Compounded over a year, that is life-changing wealth. You don't need 20 trades a day. You need one or two A-grade setups per week, executed perfectly.</div>`
        },
        { id:"m7-l5", title:"Lesson 5: What Went Wrong? Learning from Losers",
          body:`<p>Every trader takes losses. What separates professionals from amateurs is what they DO with the loss.</p>
<p>Here's what a losing trade looks like using the same system — and how you learn from it.</p>
<p>A month after the trade above, a similar-looking setup appeared on USD/JPY. D1 uptrend, H4 pullback to support, H1 hammer at the zone. Bot signalled BUY at 152.40 with strength 68. SL at 151.90 (50 pips), TP at 153.15 (75 pips / 1.5R).</p>
<p>This time: price triggered, ran up 20 pips, reversed, and stopped out for -R120.</p>
<h4>Post-trade review questions</h4>
<ol>
  <li><strong>Did I follow the setup rules?</strong> Yes — D1/H4 aligned, trigger at support, R:R 1.5, size correct.</li>
  <li><strong>Was there news I missed?</strong> No — BoJ meeting was 3 days away.</li>
  <li><strong>Was data quality good?</strong> Yes — fresh Twelve Data candles, no gaps.</li>
  <li><strong>What did price do?</strong> It formed a false break (fakeout) below support, stopped out breakout shorts, then rallied — but I had my stop too tight to the wick.</li>
</ol>
<p>Lesson learned: on JPY pairs (more volatile, higher ATR multiples), give slightly more room (1.8 ATR instead of 1.5). Record that in the journal; apply next time.</p>
<div class="lesson-quote">A loss where you followed your plan is a GOOD loss. It pays for your education. A loss where you broke rules is the expensive kind. Accept the first; eliminate the second.</div>`
        }
      ]
    },
    // ═══════════════════ MODULE 8 — 30 DAY PLAN ════════════════════════
    {
      id:"m8", icon:"fa-coins",
      title:"Book 8: Your First 90 Days — From Zero to Consistency",
      sub:"A structured path for Ndumiso's traders",
      lessons:[
        { id:"m8-l1", title:"Lesson 1: Phase 1 — Demo (Weeks 1–4)",
          body:`<p><strong>RULE: NO REAL MONEY. NO EXCEPTIONS.</strong></p>
<p>Open a demo account with exactly R10,000 (the amount you plan to start with live). Trade it exactly as if it were real money. If you blow the demo, deposit another R10,000 of fake money and start over. You are NOT trying to make money — you are trying to PROVE TO YOURSELF that you can follow rules consistently.</p>
<h4>Goals for phase 1:</h4>
<ul>
  <li>Take 30+ trades following ONLY bot signals (or signals from your own written plan).</li>
  <li>Achieve at least 40% win rate with average R:R > 1.5.</li>
  <li>Zero revenge trades. Zero rule breaks.</li>
  <li>Fill out the journal for EVERY trade (including ones you considered but didn't take).</li>
  <li>By the end of 4 weeks you should know your stats: win rate, average win, average loss, expectancy per trade.</li>
</ul>
<p>If you cannot make money on demo after 4 weeks of disciplined trading, you are NOT ready for live. Go back and re-read this course.</p>`
        },
        { id:"m8-l2", title:"Lesson 2: Phase 2 — Micro Live (Weeks 5–8)",
          body:`<p>Deposit R1,000–R5,000 (an amount you can genuinely afford to lose). Trade 0.01 lots maximum. The goal is NOT profit — it's to experience REAL EMOTION with real money at stake, while staying disciplined.</p>
<p>You will discover that trading 0.01 lots with real R100 feels completely different from trading R100,000 fake dollars. Your hands shake. You second-guess. You want to close winners early. This is the training ground for emotional control.</p>
<h4>Rules for phase 2:</h4>
<ul>
  <li>Max 0.01–0.05 lots (risking R10–R50 per trade at most).</li>
  <li>If you lose 3 trades in a row, stop for 48 hours.</li>
  <li>If you lose 10% of the account, go back to demo for 2 weeks.</li>
  <li>Continue journaling every single trade.</li>
</ul>
<p>Only progress to phase 3 when you can show 4 weeks of consistent profitability on micro account WITH zero rule breaks.</p>`
        },
        { id:"m8-l3", title:"Lesson 3: Phase 3 — Scaling Up (Weeks 9–24)",
          body:`<p>If phase 2 went well, you can gradually increase size. The rule: never increase size by more than 25% at a time. Size increases must be tied to account growth — as your account grows 25%, size grows 25% (keeping risk at 1%).</p>
<table>
<tr><th>Account size</th><th>Risk per trade (1%)</th><th>EUR/USD typical lot (40 pip SL)</th></tr>
<tr><td>R5,000</td><td>R50</td><td>0.07 lots</td></tr>
<tr><td>R10,000</td><td>R100</td><td>0.13 lots</td></tr>
<tr><td>R25,000</td><td>R250</td><td>0.34 lots</td></tr>
<tr><td>R50,000</td><td>R500</td><td>0.67 lots</td></tr>
<tr><td>R100,000</td><td>R1,000</td><td>1.35 lots</td></tr>
<tr><td>R250,000</td><td>R2,500</td><td>3.35 lots</td></tr>
</table>
<p>Notice: at R100,000 you're making roughly R2,500 per good trade. At two good trades a week that's R20,000 per month — a real income.</p>
<div class="lesson-warn"><span class="ex-title">⚠️ Common scam warning</span>You will be approached by people promising R10,000 per day, guaranteed 90% win rates, secret indicators, account management services, and "trade with our capital" prop-firm schemes. 99% of these are scams or bad deals. There are no shortcuts. If it sounds too good to be true, it is.</div>`
        },
        { id:"m8-l4", title:"Lesson 4: Final Words — The Panther Mindset",
          body:`<p>You now know more about trading than 95% of people who open a broker account. You understand structure, price action, indicators, risk management, psychology, and you've seen a full trade walkthrough.</p>
<p>Knowledge is not the problem. Execution is.</p>
<p>Trading is a martial art. You would not read a book on karate and then enter a ring. You must practice, fail, review, correct, and do it again — for months. Be patient with yourself.</p>
<div class="lesson-quote">The panther does not chase every gazelle. It waits in the tall grass — sometimes for hours — until the perfect target, at the perfect distance, at the perfect moment presents itself. Then it strikes with complete commitment. When it misses (and it does miss), it does not rage. It returns to the grass and waits again. Be the panther.</div>
<h3>The Ndumiso Principles — print them out</h3>
<ol>
  <li>Precision over frequency. One A-grade setup beats ten B-grade setups.</li>
  <li>Discipline over prediction. Follow your plan even when your gut disagrees.</li>
  <li>Risk over reward. Protect the account first; profits come second.</li>
  <li>Process over outcome. Every trade is a data point, not an identity.</li>
  <li>Patience over action. Not trading is a position — and often the best one.</li>
</ol>
<p>Welcome to the craft. 🐆</p>
<p style="text-align:center;color:var(--gold);font-family:'Playfair Display',serif;font-size:20px;margin-top:30px;">Precision • Discipline • Mastery</p>`
        }
      ]
    }
  ]
};
// ═══════════════════════════════════════════════════════════════════════════
// ISIZULU (ZU) EXPANDED TRANSLATION — Book-length course
// ═══════════════════════════════════════════════════════════════════════════
EDU.zu = {
  title: "Ukuhweba Nge-Forex kanye noNdumiso",
  subtitle: "Isifundo Esiphelele — Kusukela Kwisaqalayo Kuya Kumhwebi Onesiyalo",
  coverNote: "Funda ngokulandelana. Isahluko ngasinye sakhela kwesandulela. Ungeqe izahluko.",
  modules: [
    { id:"m1", icon:"fa-globe", title:"Incwadi 1: Umhlaba Wokuhwebelana Kwezimali",
      sub:"Iyini i-forex, isebenza kanjani, obani abadlali, nokuthi kungani abadayisi abasha abangu-90% belahlekelwa",
      lessons:[
        { id:"m1-l1", title:"Isifundo 1: Usuku Lwemali",
          body:`<p>NgoLwesibili ekuseni eGoli, ipulazi lewayini laseNingizimu Afrika lithumela amakesi angama-2,000 ePinotage kumthengisi waseDüsseldorf. I-invoyisi iku-Euro. Umthengi uthengisa iwayini ngama-Euro, kodwa ipulazi likhokhela abasebenzi ngama-Randi. Endaweni ethile, ibhange noma inkampani yokukhokha kufanele iguqule lawo ma-Euro abuyele kuma-Randi.</p>
<p>Ngaso leso sikhathi, isikhwama sempesheni sase-Japan sithenga amabhondi kahulumeni wase-US ngoba amazinga enzalo e-Japan aseduze noziro kodwa awase-US akhokha u-4%. Ukwenza lokho, isikhwama siguqula i-Yen yase-Japan sibe yi-Dollar lase-US.</p>
<p>E-London, isikhwama se-hedge esikholelwa ukuthi i-pound yaseBrithani izokhuphuka uma iqhathaniswa ne-dollar sase-US sithenga isikhundla esingu-£50,000,000 ku-GBP/USD.</p>
<p>E-Lagos, umfundi othumela imali yokufunda enyuvesi yase-Canada uthumela u-₦5,000,000 ngenkonzo yemali, eguqula i-Naira ibe yi-Canadian Dollar.</p>
<p>Yonke leyo misebenzi — izigidi zayo nsuku zonke, ubusuku nemini, izinsuku ezinhlanu ngeviki — idlula emakethe eyodwa: <strong>imakethe yokuhwebelana kwezimali zangaphandle</strong>, noma i-Forex.</p>
<div class="lesson-quote">I-Forex ayisona ikhasino esenzelwe abadayisi abavamile. Iyisisekelo sohwebo lomhlaba. Abahwebi njengathi bayingxenye encane yomshini omkhulu kakhulu.</div>
<h3>Inkulu kangakanani?</h3>
<p>Ngokusho kweBhange Lamazwe Ngamazwe (BIS), imakethe ye-Forex ihwebelana ngemali elinganiselwa ku-<strong>$7.5 trillion ngosuku</strong>. Ukukubeka ngendlela elula: lonke ibhizinisi lezitoko lomhlaba wonke lilinganiselwa ku-$200 billion ngosuku. I-Forex inkulu izikhathi ezingu-35 kunezitoko zomhlaba wonke.</p>`
        },
        { id:"m1-l2", title:"Isifundo 2: Umlando Omfushane",
          body:`<p>Ngaphambi kuka-1971, umhlaba wawusebenza ngaphansi kohlelo lwe-<strong>Bretton Woods</strong>. Izimali zaziboshwe kwi-dollar yase-US, futhi i-dollar yase-US yayiboshwe egolideni. Amazinga okushintshana ayenganyakazi kakhulu. Kwakungekho into efana "nohwebo lwezimali lokudayisa".</p><p>Ngo-1971, uMongameli wase-US uRichard Nixon wasusa i-dollar esilinganisweni segolide. Ngokushesha izimali zaqala <em>ukuntanta</em> ngokumelene nomunye nomunye. Inani lazo lanqunywa ngokutholakala kanye nesidingo. I-Forex yesimanje yazalwa.</p>
<h4>Izikhathi ezibalulekile</h4>
<table><tr><th>Unyaka</th><th>Isigameko</th></tr>
<tr><td>1971</td><td>Uhlelo lwe-Bretton Woods luyawa; izimali ziyantanta</td></tr>
<tr><td>1980s</td><td>Ukuhwebelana nge-elekthronikhi kuqala phakathi kwamabhange</td></tr>
<tr><td>1990s</td><td>I-inthanethi ifika; ama-broker avulela abantu abavamile</td></tr>
<tr><td>2000s</td><td>I-MetaTrader iba yindinganiso; i-leverage engu-1:100+ iyatholakala</td></tr>
<tr><td>2010s</td><td>Ama-app wokuhweba ama-smartphone enza kube lula</td></tr>
<tr><td>2020s</td><td>Ama-AI/algo alawula ukuhamba kwesikhungo; imithetho iyaqina</td></tr></table>`
        },
        { id:"m1-l3", title:"Isifundo 3: Obani Abahweba I-Forex",
          body:`<p>Kunezinhlobo ezinhlanu zabahlanganyeli. Udinga ukuziqonda ngoba uhweba ngokumelene nabo.</p>
<h4>1. Amabhange Amakhulu (izimbumba)</h4><p>I-SARB, i-Fed, i-ECB, i-BoJ, i-BoE. Abahwebi ngenzuzo — balawula ukuzinza kwemali namazinga enzalo. Lapho ibhange elikhulu likhuluma, izimakethe ziyanyakaza.</p>
<h4>2. Amabhange Ohwebo Nezimali (imali ehlakaniphile)</h4><p>I-Standard Bank, i-JP Morgan, i-Citi, i-Deutsche, i-Goldman Sachs. Baphatha ama-oda amakhasimende. Yilapho inani langempela litholakala khona.</p>
<h4>3. Ama-Hedge Fund NabaHwebi be-Prop</h4><p>Ngabachwepheshe besikhathi esigcwele abaphila ngokuqonda kwabo. Ama-oda abo makhulu ngokwanele ukududula intengo.</p>
<h4>4. Izinkampani</h4><p>Abahwebi ngenzuzo — baguqula imali yebhizinisi. Bavikela imali yabo, abazami ukuhwebelana.</p>
<h4>5. Abahwebi Abavamile (yithi)</h4><p>Simelela cishe u-<strong>5–8% wevolumu iyonke</strong>. Singabadlali abancane kunabo bonke emakethe.</p>
<div class="lesson-warn"><span class="ex-title">⚠️ Iqiniso elinzima</span>Abahwebi abavamile njengeqembu balahlekelwa imali — hhayi ngoba imakethe iqiliwe, kodwa ngoba cishe wonke umuntu ufika engenalo uhlelo, engenakuphatha ubungozi, futhi engenaso isiyalo semizwa.</div>`
        },
        { id:"m1-l4", title:"Isifundo 4: Izikhathi Zokuhweba eNingizimu Afrika",
          body:`<p>I-Forex isebenza amahora angu-24 kusukela ngoMsombuluko ekuseni e-Wellington kuya kuLwesihlanu kusihlwa eNew York. Kodwa ayisebenzi ngokulingana usuku lonke.</p>
<table><tr><th>Isikhathi</th><th>Kuvulwa (SAST)</th><th>Kuyavalwa (SAST)</th><th>Isimo</th></tr>
<tr><td>Sydney / Tokyo (Asia)</td><td>00:00</td><td>08:00</td><td>Kuthulekile, i-range</td></tr>
<tr><td>London (Europe)</td><td>09:00</td><td>18:00</td><td>Ivolumu ephezulu, i-trend</td></tr>
<tr><td>New York (Americas)</td><td>15:00</td><td>00:00</td><td>Ukuhamba okuphezulu kakhulu</td></tr></table>
<h3>Izikhathi ezingcono kakhulu</h3>
<ul>
<li><strong>09:00 – 11:00 SAST (London open)</strong> — ukunyakaza okukhulu kosuku kuvame ukuqala lapha.</li>
<li><strong>15:00 – 18:00 SAST (London/NY overlap)</strong> — ivolumu ephezulu kakhulu, ukuhamba okukhulu. Isikhathi esihle kakhulu.</li>
</ul>
<div class="lesson-tip"><span class="ex-title">💡 Uhlelo lukaNdumiso</span>Vuka, uhlole amashadi e-D1 kanye ne-H4 ngaphambi kokuthi kuvulwe i-London (~08:00). Hweba 09:00–11:00 uma kukhona isetup. Hlola futhi 14:30 ngaphambi kokuvulwa kwe-NY. Hwebisana 15:00–18:00 uma isetup sicwebile.</div>`
        },
        { id:"m1-l5", title:"Isifundo 5: Kungani Abantu Abasha Beyeka Phakathi Nezinyanga Eziyisi-6",
          body:`<p>Ngiqeqeshe amakhulu abahwebi. Iphethini ihlale ifana.</p>
<ol class="lesson-step-list">
<li><strong>Ukudonswa.</strong> Othile ubona isikhangiso noma umngane ekhombisa i-screenshot ye-trade ewinile. Bayakholwa ukuthi bangenza okufanayo.</li>
<li><strong>Isikhathi sokuqala.</strong>Ama-trade abo okuqala ayawina (ngokuvamile ngenhlanhla). Bacabanga ukuthi baneziphiwo.</li>
<li><strong>Ukulahlekelwa kokuqala okukhulu.</strong>Bafaka i-leverage enkulu ku-"sure thing" bese belahlekelwa u-20–40% ngosuku.</li>
<li><strong>Ukutatazela.</strong>Bahweba ngokuziphindiselela, bashintshe amasu isonto ngalinye, bathenge izifundo, bajoyine ama-signal groups.</li>
<li><strong>Ukuphelelwa noma Ukuvuka.</strong>Abaningi balahlekelwa yikho konke bayeke. Abambalwa baqaphela ukuthi inkinga akuyona imakethe — yibo.</li>
</ol>
<p>Inhloso yalesi sifundo ukukufushanisela ngqo esigabeni sesi-5 ngaphandle kokulahlekelwa yimali oyilondolozile.</p>`
        }
      ]
    },
    { id:"m2", icon:"fa-fire", title:"Incwadi 2: Ama-Candlestick Nesenzo Sentengo",
      sub:"Ukufunda indaba intengo ekutshela yona — ngaphandle kwama-indicator",
      lessons:[
        { id:"m2-l1", title:"Isifundo 1: Yakheka Kanjani I-Candle",
          body:`<p>Ngaphambi kwamakhompyutha, abahwebi berayisi base-Japan ngawo-1700 babedweba izithombe zokuhamba kwentengo. Indoda okuthiwa <strong>Munehisa Homma</strong> yasungula esikubiza ngama-<em>candlestick chart</em> ukuze ibone impi phakathi kwabathengi nabathengisi. Sisayisebenzisa, singashintshile kangako, eminyakeni engu-300 kamuva.</p>
<h3>Amanani amane</h3>
<p>I-candlestick ngayinye imele isikhathi esinqunyiwe. Ikhombisa amanani amane: Open, High, Low, Close.</p>
<ul>
<li><strong>Open</strong> — inani lokuqala ekuqaleni kwesikhathi</li>
<li><strong>High</strong> — inani eliphakeme kakhulu</li>
<li><strong>Low</strong> — inani eliphansi kakhulu</li>
<li><strong>Close</strong> — inani lokugcina ekugcineni kwesikhathi</li>
</ul>
<div class="lesson-two-col">
<div class="col-bull"><h5>I-Bullish (eluhlaza)</h5><ul><li>Ivalwa ngaphezulu kwe-open</li><li>Abathengi banqobile</li></ul></div>
<div><h5>I-Bearish (ebomvu)</h5><ul><li>Ivalwa ngaphansi kwe-open</li><li>Abathengisi banqobile</li></ul></div>
</div>
<h3>Izindaba ezikuma-wick</h3>
<p>Umzimba ukhombisa onqobile. Ama-<strong>wick</strong> akhombisa <em>impi</em>. Ama-wick amade asho ukuthi intengo yafika kulelo zinga kodwa yaliwa yabuyiselwa emuva.</p>`
        },
        { id:"m2-l2", title:"Isifundo 2: Amaphethini E-Bullish Reversal",
          body:`<p>I-<em>reversal pattern</em> iphethini le-candlestick ebonakala ekupheleni kokuhamba futhi lisikisela ukuthi intengo isizoshintsha indlela.</p>
<h4>I-Hammer</h4><p>Iphethini ye-candle eyodwa ethembeke kunazo zonke. Umzimba omncane phezulu, i-wick ende phansi (ubude obuphindwe ka-2 komzimba). Ivela ngemuva kwe-downtrend, ku-support.</p>
<h4>I-Bullish Engulfing</h4><p>Amakhandlela amabili. I-candle yesibili eluhlaza enkulu <em>esonga</em> ngokuphelele umzimba we-candle ebomvu eyedlule. Iyisiginali enamandla kakhulu.</p>
<h4>I-Morning Star</h4><p>Amakhandlela amathathu: elide ebomvu → idoji → elide eluhlaza. Ingenye yama-reversals athembekileyo.</p>
<div class="lesson-example"><span class="ex-title">📊 Isibonelo sangempela</span>Ngemuva kokuwa okukhulu, i-EUR/USD yashicilela i-hammer ku-1.0515 eduze ne-1.0500. I-candle elandelayo yephula i-high ye-hammer (isiqinisekiso). Intengo yakhuphuka ngama-pips angu-85 kuya ku-1.0600 emahoreni angu-6 alandelayo.</div>`
        },
        { id:"m2-l3", title:"Isifundo 3: Amaphethini E-Bearish Reversal",
          body:`<p>Lawa avela phezulu kuma-uptrend futhi axwayise ngokuthi abathengi sebephelile.</p>
<h4>I-Shooting Star</h4><p>Isibuko se-hammer: umzimba omncane phansi, i-wick ende phezulu. Ivela ku-resistance.</p>
<h4>I-Bearish Engulfing</h4><p>I-candle ebomvu enkulu esonga umzimba we-candle eluhlaza eyedlule ku-resistance.</p>
<h4>I-Evening Star</h4><p>Isibuko se-morning star: elide eluhlaza → idoji → elide ebomvu.</p>
<div class="lesson-warn"><span class="ex-title">⚠️ Umthetho obalulekile</span>I-hammer phakathi ne-downtrend ngaphandle kwe-support eseduze ayisho lutho. Amaphethini kumele avele KU-LEVEL YENSAKA (support noma resistance).</div>`
        },
        { id:"m2-l4", title:"Isifundo 4: Ama-Continuation Pattern",
          body:`<h4>Three White Soldiers</h4><p>Amakhandlela amathathu aluhlaza elandelanayo. I-bullish continuation enamandla.</p>
<h4>Three Black Crows</h4><p>Amakhandlela amathathu abomvu elandelanayo. I-bearish continuation enamandla.</p>
<h4>Bull / Bear Flag</h4><p>Ngemuva kokuhamba okunamandla, intengo ihlehla kancane ngesiteshi esiqinile. Lapho intengo iphuma, ivame ukuqhubeka ibude obulingana ne-"flagpole".</p>`
        }
      ]
    },
    { id:"m3", icon:"fa-layer-group", title:"Incwadi 3: I-Support, Resistance Nohlaka Lwemakethe",
      sub:"Isakhiwo esingabonakali sentengo — lapho izimpi zilwelwa khona",
      lessons:[
        { id:"m3-l1", title:"Isifundo 1: I-Support Ne-Resistance",
          body:`<p>I-<strong>support</strong> izinga lapho abathengi bejwayele ukungena khona (phansi). I-<strong>resistance</strong> yindawo lapho abathengisi bejwayele ukungena khona (phezulu).</p>
<p>Amaleveli akha ngoba abadlali abakhulu (amabhange, izikhwama) banenkumbulo. Bakhumbula lapho abathenge badayise khona ngaphambilini.</p>
<h3>Ukuguquka kwendima (role reversal)</h3>
<p>Uma i-level yephukile, iyaguquka: i-resistance ephukile iba yi-support entsha; i-support ephukile iba yi-resistance entsha.</p>
<div class="lesson-example"><span class="ex-title">📊 Isibonelo</span>Ku-GBP/USD, i-1.2500 yaba yi-resistance izinyanga ezimbili. Ngesikhathi yephuka, yabuya yabhekwa njenge-support futhi yagxuma ngama-pips angu-60. Lokho ukuthengwa kwe-retest — isethaphu i-bot eyibeka phambili.</div>`
        },
        { id:"m3-l2", title:"Isifundo 2: Ama-Swing High Nama-Swing Low",
          body:`<p>I-<strong>swing high</strong> yibha yentengo ene-high ephakeme kunamabha nhlangothi zombili. I-<strong>swing low</strong> iphuzu eliphansi eliphansi kunamabha amabili ohlangothini ngalunye.</p>
<p>Ama-swing high nama-swing low yizindawo zokuguquka — izindawo lapho amandla ashintsha khona. Ama-oda esikhungo ahlangana kulezi zindawo.</p>`
        },
        { id:"m3-l3", title:"Isifundo 3: Ama-Trend — Indlela Yokubona Isiqondiso",
          body:`<h4>I-Uptrend (Bull Market)</h4><p>Intengo yenza ukulandelana kwama-<strong>Higher Highs (HH)</strong> nama-<strong>Higher Lows (HL)</strong>. Abathengi bayalawula.</p>
<h4>I-Downtrend (Bear Market)</h4><p>Intengo yenza ukulandelana kwama-<strong>Lower Highs (LH)</strong> nama-<strong>Lower Lows (LL)</strong>. Abathengisi bayalawula.</p>
<h4>I-Range</h4><p>Intengo ishaya phakathi kwe-support evundlile kanye ne-resistance. Qaphela — ama-chop azokukhipha kaningi.</p>
<div class="lesson-warn"><span class="ex-title">⚠️ Umthetho #1</strong>Hweba kuphela ngokuya ngohlaka lwesikhathi esiphezulu. Uma i-D1 iku-uptrend, thatha ama-BUYS kuphela ku-H4/H1/M15. Ukulwa ne-higher-TF trend kuyiphutha elikhulu.</div>`
        },
        { id:"m3-l4", title:"Isifundo 4: Ama-Breakout, Retest, Nama-Fakeout",
          body:`<p>I-<strong>breakout</strong> yilapho intengo ivala ngaphezu kwe-level ngesiqinisekiso. I-<strong>retest</strong> yilapho intengo ibuya izohlola i-level ephukile njengendima yayo entsha. Ukungena nge-retest kuvame ukuphepha kakhulu kune-breakout uqobo (kugwema ama-fakeout).</p>
<p>I-<strong>fakeout</strong> yilapho intengo idlula kwi-level nge-wick kodwa ihluleke ukuvala ngale kwayo, bese ibuyela emuva ngokusheshayo. Lezi zicupha abadayisi be-breakout.</p>
<div class="lesson-tip"><span class="ex-title">💡 Ukugwema ama-fakeout</span>Lindela UKUVALA ngale kwe-level — hhayi nje ukudlula nge-wick. Okungcono nakakhulu: linda i-retest.</div>`
        }
      ]
    },
    { id:"m4", icon:"fa-wave-square", title:"Incwadi 4: Izinkomba — Amathuluzi, Hhayi Izibikezelo",
      sub:"EMA, SMA, RSI, MACD, ATR — ukukala ngempela kanye nendlela yokuzihlanganisa",
      lessons:[
        { id:"m4-l1", title:"Isifundo 1: Ama-Moving Average",
          body:`<p>I-<em>moving average</em> (MA) isilinganiso samanani okuvala ezikhathini ezingu-N zokugcina, esakhiwe njengomugqa eshadini. Sibusebenzisa amane: EMA9, EMA21, SMA50, SMA200.</p>
<p>Uma wonke ama-MA eqondiswe ohlangothini olulodwa futhi intengo ngakolunye uhlangothi, i-trend inamandla (bull stack / bear stack).</p>`
        },
        { id:"m4-l2", title:"Isifundo 2: I-RSI",
          body:`<p>I-<strong>RSI</strong> iyi-oscillator ye-momentum ephakathi kuka-0 no-100. Ngaphezu kuka-70 = overbought. Ngaphansi kuka-30 = oversold. Ukunqamula u-50 isiqinisekiso se-momentum. Futhi i-divergence ibaluleke kakhulu.</p>`
        },
        { id:"m4-l3", title:"Isifundo 3: I-MACD",
          body:`<p>I-<strong>MACD</strong> isetshenziswa NJENGE-TRIGGER YOKUNGENA kwi-confirmation timeframe (H1/M15). I-crossover ye-MACD isiza ukukhetha isikhathi sokungena lapho zonke izimo zesikhathi esiphezulu sezihlangene.</p>`
        },
        { id:"m4-l4", title:"Isifundo 4: I-ATR",
          body:`<p>I-<strong>ATR</strong> ikala ukuthi intengo ihamba kangakanani ngebha ngayinye. AYIKHOMBISI siqondiso — ikala ubukhulu. Siyisebenzisela: (1) ukubeka ama-SL ku-1.5 × ATR, (2) ukubala i-lot size, (3) ukuhlunga i-volatility eyeqile.</p>
<div class="lesson-math">I-Lot Size = (I-Akhawunti × Risk%) / (Ama-Pips kuya ku-SL × Inani Le-Pip Nge-Lot)</div>`
        }
      ]
    },
    { id:"m5", icon:"fa-shield-halved", title:"Incwadi 5: Ukuphatha Ubungozi — Isahluko Esisindisa I-Akhawunti",
      sub:"Uma ufunde isahluko esisodwa kuphela, funda lesi. Ukuphatha ubungozi wukuhweba.",
      lessons:[
        { id:"m5-l1", title:"Isifundo 1: Kungani Ukuphatha Ubungozi KUYIKHO KONKE",
          body:`<p>Ungaba nohlelo lokungena oluhamba phambili emhlabeni bese ushabalala ngaphandle kokuphatha ubungozi. Ungaba nohlelo lokungena olumaphakathi bese uceba ngokuphatha ubungozi okuqinile.</p>
<h3>Izibalo zokushabalala</h3>
<table><tr><th>Ubungozi ngetrade</th><th>I-Win rate 40% (1:2 R:R)</th></tr>
<tr><td>1%</td><td>25% ingozi yokuwohloka</td></tr>
<tr><td>2%</td><td>50% ingozi yokuwohloka</td></tr>
<tr><td>5%</td><td>85% ingozi yokuwohloka</td></tr>
<tr><td>10%</td><td>99% ingozi yokuwohloka</td></tr></table>
<div class="lesson-warn"><span class="ex-title">⚠️ Imithetho engaxoxiswana</span>
1. Ungabeki engozini ngaphezu kuka-1–2% we-akhawunti nge-trade ngayinye.<br/>
2. Njalo sebenzisa i-stop loss.<br/>
3. Ungalokothi uhambise i-SL kude uma intengo ikuphikisa.<br/>
4. Ungalokothi wengeze esikhundleni esilahlekelayo.<br/>
5. Yiba nomkhawulo wokulahlekelwa wosuku (3%).</div>`
        },
        { id:"m5-l2", title:"Isifundo 2: Indlela Yokubala I-Lot Size",
          body:`<div class="lesson-math">I-Lot Size = (I-Akhawunti × Risk%) / (Ama-Pips kuya ku-SL × Inani Le-Pip)</div>
<p>Ifomula ibala ngokuzenzakalelayo usayizi ofanele wendawo ukuze ubungozi bedola buhlale bufana kungakhathaliseki ukuthi intengo ihamba kangakanani.</p>`
        },
        { id:"m5-l3", title:"Isifundo 3: I-Risk/Reward — Kungani 1:1.5 Kuyizinga Eliphansi",
          body:`<p>Nge-R:R engu-1:2, ungaba nephutha ku-2 kwabayi-3 bese wenza inzuzo.</p>
<table><tr><th>R:R</th><th>I-Win rate edingekayo</th></tr>
<tr><td>1:1</td><td>50%</td></tr>
<tr><td>1:1.5</td><td>40%</td></tr>
<tr><td>1:2</td><td>33%</td></tr>
<tr><td>1:3</td><td>25%</td></tr></table>
<h4>Ukuphuma kancane (scale out)</h4><ol><li>Ku-TP1 (1.5R), thatha u-50%, hambisa i-SL ku-breakeven.</li><li>Ku-TP2 (3R), thatha enye i-30%.</li><li>Shiya u-20% wokugcina nge-trailing stop.</li></ol>`
        },
        { id:"m5-l4", title:"Isifundo 4: Uhlelo Lokuhweba Nendlela Yansuku Zonke",
          body:`<p>Bhala phansi uhlelo lwakho: amapheya owahwebelayo, izikhathi, imithetho yokungena, i-SL, i-TP, usayizi omkhulu, umkhawulo wansuku zonke, nokuthi UNGAhwebi nini. Namathisela odongeni eduze kwesikrini sakho.</p>`
        }
      ]
    },
    { id:"m6", icon:"fa-brain", title:"Incwadi 6: Ingqondo Yomhwebi Onesiyalo",
      sub:"U-80% wokuhweba wenzeka phakathi kwezindlebe zakho",
      lessons:[
        { id:"m6-l1", title:"Isifundo 1: Izitha Eziyisithupha Zemizwa",
          body:`<h4>1. Ukwesaba</h4><p>Kukwenza ungangeni lapho kufanele, ukhiphe abawinile ngaphambi kwesikhathi. Ikhambi: themba uhlelo.</p>
<h4>2. Ukuhaha</h4><p>Kukwenza usebenzise i-leverage enkulu kakhulu, weqe ama-TP. Ikhambi: thatha inzuzo emazingeni amisiwe.</p>
<h4>3. Ithemba</h4><p>Umuzwa oyingozi kakhulu. Ukwenza uhambise ama-SL futhi ubambe ama-losers. Ikhambi: i-SL yakho yilapho onephutha khona.</p>
<h4>4. Ukuziphindiselela</h4><p>Ngemva kokulahlekelwa, uvula i-trade ngokushesha ukubuyisela imali. Ayisebenzi. Ikhambi: awukho ama-trade imizuzu engama-30 ngemuva kokulahlekelwa.</p>
<h4>5. Ukuzethemba ngokweqile</h4><p>Ngemuva kwama-win amathathu, weqa i-checklist. Ikhambi: buyekeza wonke ama-trade.</p>
<h4>6. Isithukuthezi</h4><p>Ukuhweba ngenxa nje yokuthi ukuhlala kuthulekile akuthokozi. Ikhambi: ukungahwebi KUYISIKHUNDI.</p>`
        },
        { id:"m6-l2", title:"Isifundo 2: Ukwakha Isiyalo Ngenqubo",
          body:`<p>Isiyalo akusona isici sobuntu. KUYISIJWAYELO. Usakha njengomsipha — ngokuphindaphinda kanye nokunqoba okuncane kwansuku zonke. Ngaphambi kwayo yonke i-trade, sebenzisa i-checklist. Gcina ijenali. Phefumula kathathu ngaphambi kokuchofoza.</p>`
        },
        { id:"m6-l3", title:"Isifundo 3: I-Expectancy Nengqondo Yekhasino",
          body:`<p>Ikhasino ayinendaba nokuthi othile uwine u-R1 million ngenombolo eyodwa. Bayazi ukuthi ngaphezu kwama-spin angu-100,000, i-edge iqinisekisiwe. Umsebenzi wakho njengomhwebi UKUBA IKASINO, hhayi umgembuli.</p>
<div class="lesson-math">I-Expectancy = (I-Win Rate × I-Avg Win) − (I-Loss Rate × I-Avg Loss)</div>`
        }
      ]
    },
    { id:"m7", icon:"fa-magnifying-glass-chart", title:"Incwadi 7: Isibonelo Esiphelele Se-Trade — EUR/USD",
      sub:"Ukuhlanganisa konke: D1 → H4 → H1 → M15",
      lessons:[
        { id:"m7-l1", title:"Isifundo 1: Isinyathelo 1 — I-D1 Trend Bias",
          body:`<p>Isinyathelo sokuqala: HLOLA I-D1 NJALO. NgoJanuwari 2025, i-EUR/USD yayiku-uptrend (HH/HL), ibuyela emuva kwi-support ku-1.0700.</p><p><strong>I-D1 BIAS = BULLISH. Sibheka ama-BUYS kuphela.</strong></p>`
        },
        { id:"m7-l2", title:"Isifundo 2: Isinyathelo 2 — I-H4 Structure",
          body:`<p>Ku-H4, intengo yahlola i-zone engu-1.0700–1.0720. Ama-candles e-H4 abonisa ama-wick amade aphansi (abathengi bamunca ukuthengisa). Isitaki se-MA sisavumelana.</p><p><strong>I-H4 IQINISEKISA I-BULLISH BIAS. Indawo yokuthenga: 1.0700–1.0720.</strong></p>`
        },
        { id:"m7-l3", title:"Isifundo 3: Isinyathelo 3 — I-H1 Trigger, SL, TP",
          body:`<p>Ku-H1, i-hammer yakha ku-1.0705, i-RSI yafika ku-28, i-MACD yeqa i-bullish. Sayithenga ku-1.0725, i-SL ku-1.0685 (40 pips), i-TP1 ku-1.0785 (60 pips / 1.5R), i-TP2 ku-1.0845 (120 pips / 3R). I-Strength 76/100.</p>`
        },
        { id:"m7-l4", title:"Isifundo 4: Isinyathelo 4 — Ukuphathwa kanye Nomphumela",
          body:`<p>Sathatha u-50% ku-TP1 (R78), sahambisa i-SL ku-breakeven. Ngemuva kwamahora angu-24 safinyelela ku-TP2 (R111). Esinye isiqeshana sakhishwa nge-trailing stop (R75). <strong>Isamba esiphelele: +R264 (+2.6%) emahoreni angu-36.</strong></p>
<div class="lesson-tip"><span class="ex-title">💡 Iphuzu</span>Audinga ama-trade amaningi anje. Amabili ngesonto angena ku-5% ngesonto. Lokho kuyinzuzo eguqula impilo.</div>`
        },
        { id:"m7-l5", title:"Isifundo 5: Ukufunda Kubadlulile",
          body:`<p>Uma ulahlekelwa kodwa walandela imithetho, UKULAHLEKELWA OKUHLE. Uma ulahlekelwa ngenxa yokwephula imithetho, UKULAHLEKELWA OKUBIZAYO. Yamukela ukulahlekelwa kokuqala; qeda okwesibili.</p>`
        }
      ]
    },
    { id:"m8", icon:"fa-coins", title:"Incwadi 8: Izinsuku Zakuqala Ezingu-90",
      sub:"Indlela ehleliwe yabahwebi bakaNdumiso",
      lessons:[
        { id:"m8-l1", title:"Isifundo 1: Isigaba 1 — I-Demo (Amaviki 1–4)",
          body:`<p>AKUKHO MALI YANGEMPELA. Vula i-akhawunti yedemo ngo-R10,000. Thatha ama-trade angu-30+ alandela amasiginali e-bot kuphela. Inhloso AKUSIYO inzuzo — ukuzibonisa ukuthi ungalandela imithetho ngokungaguquguquki.</p>`
        },
        { id:"m8-l2", title:"Isifundo 2: Isigaba 2 — I-Micro Live (Amaviki 5–8)",
          body:`<p>Faka imali encane ongakwazi ukuyilahlekela (R1,000–R5,000). Hweba ama-0.01 lots amaningi. Inhloso ukubhekana nemizwa YANGEMPELA ngemali yangempela.</p>`
        },
        { id:"m8-l3", title:"Isifundo 3: Isigaba 3 — Ukukhulisa Usayizi (Amaviki 9–24)",
          body:`<p>Khulisa usayizi ngama-25% kuphela ngesikhathi, uhlobene nokukhula kwe-akhawunti. Ku-R100,000, wenza cishe u-R2,500 nge-trade enhle ngayinye.</p>
<div class="lesson-warn">Izithembiso zika-R10,000 ngosuku, ama-indicators ayimfihlo, nezinsizakalo zokuphatha ama-akhawunti kuyimikhonyovu engu-99%. Ayikho indlela enqamulelayo.</div>`
        },
        { id:"m8-l4", title:"Isifundo 4: Amazwi Okugcina — Ingqondo Yengwe",
          body:`<p>Ingwe ayijahi yonke insephe. Ilinda otshanini obude — ngezinye izikhathi amahora — kuze kube yilapho isisulu esifanele, ebangeni elifanele, ngesikhathi esifanele sivele. Bese igadla ngokuzibophezela okuphelele. Lapho iphutha (futhi iyaphutha), ayithukutheli. Ibuyela otshanini ilinde futhi. Yiba yingwe. 🐆</p>
<p style="text-align:center;color:#d4af37;font-family:'Playfair Display',serif;font-size:20px;margin-top:30px;">Ukunemba • Isiyalo • Ubungcweti</p>`
        }
      ]
    }
  ]
};

// ─────── Enhanced academy renderer with chapter navigation & progress ───────
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
  academyState.currentLesson = null; // return to module list on language change
  var enBtn = document.getElementById("langEN");
  var zuBtn = document.getElementById("langZU");
  if (enBtn) enBtn.classList.toggle("active", l==="en");
  if (zuBtn) zuBtn.classList.toggle("active", l==="zu");
  renderModules();
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
    var lessonCount = mod.lessons.length;
    card.innerHTML = '<div class="edu-mod-head">' +
      '<div class="edu-mod-icon"><i class="fa-solid ' + mod.icon + '"></i></div>' +
      '<div class="edu-mod-t"><h3></h3><p></p></div>' +
      '<i class="fa-solid fa-chevron-down edu-mod-chv"></i></div>' +
      '<div class="edu-lesson-list"></div>';
    card.querySelector(".edu-mod-t h3").textContent = mod.title;
    card.querySelector(".edu-mod-t p").textContent = mod.sub + " (" + lessonCount + " lessons)";
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
      var all = list.querySelectorAll(".edu-module");
      for (var i=0;i<all.length;i++) all[i].classList.remove("open");
      if (!isOpen) card.classList.add("open");
    });
    list.appendChild(card);
  });
}
function findLesson(modId, lesId) {
  var data = EDU[academyState.lang];
  for (var m=0;m<data.modules.length;m++){
    var mod = data.modules[m];
    if (mod.id !== modId) continue;
    for (var l=0;l<mod.lessons.length;l++){
      if (mod.lessons[l].id === lesId) return { mod: mod, lesson: mod.lessons[l], mi:m, li:l };
    }
  }
  return null;
}
function openLesson(modId, lesId) {
  var list = document.getElementById("eduModules");
  var view = document.getElementById("eduLesson");
  if (list) list.style.display = "none";
  if (view) view.style.display = "block";
  academyState.currentLesson = { moduleId: modId, lessonId: lesId };
  renderLesson(modId, lesId);
  setTimeout(function(){ view.scrollIntoView({behavior:"smooth", block:"start"}); }, 50);
}
function renderLesson(modId, lesId) {
  var found = findLesson(modId, lesId);
  if (!found) return;
  var mod = found.mod, les = found.lesson, mi = found.mi, li = found.li;
  var titleEl = document.getElementById("lessonTitle");
  var subEl = document.getElementById("lessonSubtitle");
  var bodyEl = document.getElementById("lessonBody");
  if (titleEl) titleEl.textContent = les.title;
  if (subEl) subEl.textContent = mod.title + " — " + mod.sub;
  var chapterNum = '<div class="lesson-chapter-num">' + mod.title.replace(/^Book \d+: /,"Chapter " + (mi+1) + " • ") + " • Lesson " + (li+1) + "/" + mod.lessons.length + '</div>';
  // Add prev/next navigation
  var prevBtn = "", nextBtn = "";
  var prev = null, next = null;
  if (li > 0) prev = mod.lessons[li-1];
  else if (mi > 0) {
    var pm = EDU[academyState.lang].modules[mi-1];
    prev = pm.lessons[pm.lessons.length-1];
    prevMod = pm;
  }
  var prevMod = mod;
  if (li < mod.lessons.length-1) next = mod.lessons[li+1];
  else if (mi < EDU[academyState.lang].modules.length-1) {
    var nm = EDU[academyState.lang].modules[mi+1];
    next = nm.lessons[0];
    nextMod = nm;
  }
  var nextMod = mod;
  // recalc with mod tracking
  prev = null; next = null; var prevModT=null, nextModT=null;
  var allLessons = [];
  EDU[academyState.lang].modules.forEach(function(mo){ mo.lessons.forEach(function(le){ allLessons.push({m:mo,l:le}); }); });
  var flatIdx = -1;
  for (var i=0;i<allLessons.length;i++){ if(allLessons[i].m.id===mod.id && allLessons[i].l.id===les.id){ flatIdx=i; break; } }
  var totalLessons = allLessons.length;
  var progressPct = ((flatIdx+1)/totalLessons*100).toFixed(0);
  var progressBar = '<div class="lesson-progress"><div class="lesson-progress-fill" style="width:'+progressPct+'%"></div></div>';
  var navHtml = '<div class="lesson-nav-row">';
  if (flatIdx > 0) {
    var p = allLessons[flatIdx-1];
    navHtml += '<button class="lesson-nav-btn nav-prev" data-mid="'+p.m.id+'" data-lid="'+p.l.id+'"><i class="fa-solid fa-arrow-left"></i><span>'+p.l.title+'</span></button>';
  } else { navHtml += '<span></span>'; }
  if (flatIdx < totalLessons-1) {
    var n = allLessons[flatIdx+1];
    navHtml += '<button class="lesson-nav-btn nav-next" data-mid="'+n.m.id+'" data-lid="'+n.l.id+'"><span>'+n.l.title+'</span><i class="fa-solid fa-arrow-right"></i></button>';
  }
  navHtml += '</div>';
  if (bodyEl) bodyEl.innerHTML = chapterNum + progressBar + les.body + navHtml;
  // Wire nav buttons
  var navBtns = bodyEl.querySelectorAll(".lesson-nav-btn");
  for (var b=0;b<navBtns.length;b++){
    navBtns[b].addEventListener("click", function(){
      openLesson(this.dataset.mid, this.dataset.lid);
    });
  }
}
function backToModules() { renderModules(); window.scrollTo({top:0,behavior:"smooth"}); }

// ─────── PDF download (full book, print-ready) ───────
function openPdf() {
  var w = window.open("", "_blank");
  var data = EDU[academyState.lang];
  var langLabel = academyState.lang === "zu" ? "isiZulu" : "English";
  var html = '<!doctype html><html><head><meta charset="utf-8"><title>' + data.title + '</title>' +
    '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">' +
    '<style>' +
    '@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;700;800&family=Playfair+Display:wght@700;900&display=swap");' +
    '*{box-sizing:border-box}body{font-family:Inter,Arial,sans-serif;background:#fff;color:#111;padding:20px;max-width:780px;margin:0 auto;font-size:12px;line-height:1.7;}' +
    'h1,h2,h3{font-family:"Playfair Display",serif;color:#111;page-break-after:avoid;}' +
    'h3{font-size:18px;margin-top:24px;border-bottom:2px solid #d4af37;padding-bottom:4px;}' +
    'h4{font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:#39d2c0;margin-top:18px;}' +
    'p{margin-bottom:10px;}' +
    'ul,ol{padding-left:22px;margin-bottom:10px;}' +
    'li{margin-bottom:4px;}' +
    'table{width:100%;border-collapse:collapse;margin:12px 0;font-size:11px;}' +
    'th{background:#1a2030;color:#d4af37;padding:6px;text-align:left;border:1px solid #ccc;font-size:10px;letter-spacing:1px;}' +
    'td{padding:6px;border:1px solid #ccc;}' +
    '.print-cover{text-align:center;padding:80px 20px;page-break-after:always;min-height:90vh;display:flex;flex-direction:column;justify-content:center;align-items:center;}' +
    '.print-cover h1{color:#d4af37;font-size:36px;margin-bottom:10px;}' +
    '.print-cover p{color:#555;font-size:14px;}' +
    '.lesson-chapter-num{color:#39d2c0;font-size:10px;font-weight:800;letter-spacing:2px;text-transform:uppercase;margin:24px 0 6px;}' +
    '.lesson-example,.lesson-box{background:#f7f5ec;border-left:4px solid #39d2c0;padding:10px 14px;margin:12px 0;border-radius:4px;}' +
    '.lesson-warn{background:#fff0f0;border-left:4px solid #dc2626;padding:10px 14px;margin:12px 0;border-radius:4px;}' +
    '.lesson-tip{background:#f7f5ec;border-left:4px solid #d4af37;padding:10px 14px;margin:12px 0;border-radius:4px;}' +
    '.lesson-quote{font-style:italic;color:#555;border-left:4px solid #d4af37;padding:10px 16px;margin:14px 0;font-family:"Playfair Display",serif;}' +
    '.lesson-math{background:#f4f4f4;border:1px solid #ccc;border-radius:6px;padding:12px;margin:12px 0;font-family:"Courier New",monospace;text-align:center;font-size:13px;color:#111;font-weight:700;}' +
    '.lesson-chart{background:#f4f4f4;border:1px solid #ccc;border-radius:6px;padding:12px;margin:12px 0;font-family:"Courier New",monospace;font-size:10px;line-height:1.4;white-space:pre;overflow-x:auto;}' +
    '.lesson-chart-title{font-family:Inter,sans-serif;font-size:9px;letter-spacing:2px;text-transform:uppercase;color:#d4af37;font-weight:800;}' +
    '.ex-title{font-size:9px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:#39d2c0;display:block;margin-bottom:4px;}' +
    '.lesson-step-list{list-style:none;padding:0;margin:12px 0;counter-reset:step;}' +
    '.lesson-step-list li{padding:8px 10px 8px 38px;margin-bottom:6px;background:#f9f9f9;border-radius:6px;position:relative;}' +
    '.lesson-step-list li::before{counter-increment:step;content:counter(step);position:absolute;left:10px;top:8px;width:20px;height:20px;background:#d4af37;color:#000;font-weight:800;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;}' +
    '.lesson-two-col{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:12px 0;}' +
    '.lesson-two-col > div{background:#f9f9f9;border:1px solid #ccc;border-radius:6px;padding:10px;}' +
    '.lesson-two-col h5{margin:0 0 4px 0;font-size:9px;letter-spacing:1px;}' +
    '.edu-module{page-break-inside:auto;margin-bottom:20px;}' +
    '.edu-mod-head{background:linear-gradient(135deg,#141a28,#0a0d14);color:#fff;padding:14px;border-radius:6px 6px 0 0;page-break-after:avoid;}' +
    '.edu-mod-head h3{color:#d4af37;margin:0 0 2px 0;font-size:15px;}' +
    '.edu-mod-head p{color:#39d2c0;margin:0;font-size:10px;}' +
    '.edu-lesson-item{color:#111;font-weight:700;padding:8px 0;border-bottom:1px solid #eee;page-break-after:avoid;}' +
    '.lesson-body{padding:12px 0;}' +
    '.lesson-divider{height:1px;background:#ccc;margin:16px 0;}' +
    '.lesson-progress,.lesson-nav-row,.back-btn,.edu-toolbar,.nav-btn,.bottom-nav,.app-header,#splash,.update-banner{display:none!important;}' +
    'code{background:#f0f0f0;padding:1px 4px;border-radius:3px;font-size:11px;color:#111;}' +
    '@page{margin:15mm;size:A4;}' +
    '.bull{color:#22c55e;font-weight:700;}.bear{color:#dc2626;font-weight:700;}.resist{color:#dc2626;}.sup{color:#22c55e;}.label{color:#555;}.entry{color:#d4af37;font-weight:700;}' +
    '.col-bull h5{color:#22c55e;}' +
    '</style></head><body>' +
    '<div class="print-cover"><div style="font-size:64px">🐆</div><h1>' + data.title + '</h1><p style="font-size:16px;color:#39d2c0;text-transform:uppercase;letter-spacing:3px;">' + data.subtitle + '</p>' +
    '<p style="margin-top:40px;color:#888;font-size:11px;">Complete course · ' + langLabel + ' edition</p>' +
    '<p style="color:#888;font-size:11px;">' + new Date().toISOString().slice(0,10) + '</p>' +
    '<p style="margin-top:60px;font-style:italic;color:#555;font-family:Playfair Display,serif;">Precision • Discipline • Mastery</p></div>';
  data.modules.forEach(function(mod){
    html += '<div class="edu-module"><div class="edu-mod-head"><h3>' + mod.title + '</h3><p>' + mod.sub + '</p></div>';
    mod.lessons.forEach(function(les){
      html += '<div class="edu-lesson-item">' + les.title + '</div>';
      html += '<div class="lesson-body">' + les.body + '</div>';
    });
    html += '</div>';
  });
  html += '<div style="text-align:center;margin:40px 0;color:#888;font-size:11px;font-family:Playfair Display,serif;">🐆 Precision · Discipline · Mastery</div>';
  html += '<script>window.onload=function(){setTimeout(function(){window.print();},600);};</scr' + 'ipt>';
  html += '</body></html>';
  w.document.write(html);
  w.document.close();
}
