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

function renderDashboard() {
  try {
    var active = [];
    for (var i = 0; i < state.signals.length; i++) {
      if (state.signals[i].status !== "CLOSED") active.push(state.signals[i]);
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
    for (var i = 0; i < state.signals.length; i++) if (state.signals[i].status !== "CLOSED") active.push(state.signals[i]);
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
      if (state.signals[s].pair === state.currentPair && state.signals[s].status !== 'CLOSED') { sig = state.signals[s]; break; }
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
