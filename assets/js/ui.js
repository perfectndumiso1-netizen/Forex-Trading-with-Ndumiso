/**
 * ui.js — DOM rendering helpers.
 */

import { PAIRS } from "./config.js";

// ── Formatting helpers ───────────────────────────────────────────────────────
export function fmtPrice(price, symbol) {
  const digits = symbol?.includes("JPY") ? 3 : 5;
  return price?.toFixed(digits) ?? "—";
}
export function fmtPips(pips) {
  if (pips == null) return "—";
  return (pips >= 0 ? "+" : "") + pips.toFixed(1);
}
export function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}
export function fmtRR(rr) {
  if (rr == null) return "—";
  return "1:" + rr.toFixed(2);
}

// ── Signal cards ─────────────────────────────────────────────────────────────
export function renderSignals(signals, container, filterPair = "", filterDir = "") {
  const filtered = signals.filter(s => {
    if (filterPair && s.pair !== filterPair) return false;
    if (filterDir && s.signal !== filterDir) return false;
    return true;
  });
  if (filtered.length === 0) {
    container.innerHTML = `<div class="loading">No signals match the current filter. NO TRADE is a normal outcome.</div>`;
    return;
  }
  container.innerHTML = filtered.map(s => signalCardHTML(s)).join("");
}

function signalCardHTML(s) {
  const isBuy = s.signal === "BUY";
  const tp1 = s.takeProfitLevels?.[0]?.level ?? s.takeProfit;
  return `
    <div class="signal-card ${isBuy ? "buy" : "sell"}">
      <div class="signal-top">
        <span class="signal-pair">${s.pair}</span>
        <span class="signal-direction ${isBuy ? "buy" : "sell"}">${s.signal}</span>
      </div>
      <div class="signal-levels">
        <div class="level-block">
          <div class="level-label">Entry</div>
          <div class="level-value entry">${fmtPrice(s.entry, s.pair)}</div>
        </div>
        <div class="level-block">
          <div class="level-label">Stop Loss</div>
          <div class="level-value sl">${fmtPrice(s.stopLoss, s.pair)}</div>
        </div>
        <div class="level-block">
          <div class="level-label">Take Profit</div>
          <div class="level-value tp">${fmtPrice(tp1, s.pair)}</div>
        </div>
      </div>
      <div class="signal-meta">
        <span>${s.entryTF} entry</span>
        <span class="rr-badge">R:R ${s.riskReward?.toFixed(2) ?? "—"}</span>
        <span>Quality ${s.dataQuality ?? "—"}%</span>
      </div>
      <div class="strength-bar">
        <div class="strength-bar-fill" style="width:${s.strength}%"></div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;">
        <span style="color:var(--text-muted)">Strength: <strong style="color:var(--text-primary)">${s.strength}/100</strong> (confluence only)</span>
        <span style="color:var(--text-muted)">${fmtTime(s.timestamp)}</span>
      </div>
      <div class="signal-reasons">
        <ul>${(s.reasons || []).map(r => `<li>${r}</li>`).join("")}</ul>
        <div style="margin-top:6px;color:var(--text-muted);font-size:10px;">v${s.strategyVersion || "?"} • ${s.status || "ACTIVE"}</div>
      </div>
    </div>`;
}

// ── Populate pair selectors ──────────────────────────────────────────────────
export function populatePairSelect(selectEl) {
  selectEl.innerHTML = PAIRS.map(p => `<option value="${p.symbol}">${p.label}</option>`).join("");
}

export function populateFilterSelect(selectEl) {
  const existing = selectEl.innerHTML;
  selectEl.innerHTML = existing + PAIRS.map(p => `<option value="${p.symbol}">${p.label}</option>`).join("");
}

// ── Pairs table ──────────────────────────────────────────────────────────────
export function renderPairsTable(pairsData, signals, tbody) {
  const getActiveSignal = (pair) => signals.find(s => s.pair === pair.symbol && s.status === "ACTIVE");
  const getBias = (pair, tf) => {
    const tfData = pairsData[pair.symbol]?.meta?.[tf];
    // Determine bias from available indicators or last candle direction
    const candles = pairsData[pair.symbol]?.candles?.[tf] || [];
    if (candles.length < 50) return { label: "—", cls: "neutral" };
    const lastCandle = candles.at(-1);
    const prevCandle = candles.at(-10) || candles.at(-1);
    const diff = lastCandle.close - prevCandle.close;
    const pct = diff / lastCandle.close;
    if (pct > 0.002) return { label: "BULL", cls: "bull" };
    if (pct < -0.002) return { label: "BEAR", cls: "bear" };
    return { label: "NEUT", cls: "neutral" };
  };

  let html = "";
  for (const pair of PAIRS) {
    const h1 = pairsData[pair.symbol]?.candles?.H1 || [];
    const price = h1.at(-1)?.close;
    const sig = getActiveSignal(pair);
    html += `<tr>
      <td><strong>${pair.label}</strong></td>
      <td>${biasCell(getBias(pair, "D1"))}</td>
      <td>${biasCell(getBias(pair, "H4"))}</td>
      <td>${biasCell(getBias(pair, "H1"))}</td>
      <td>${biasCell(getBias(pair, "M15"))}</td>
      <td style="font-weight:600">${fmtPrice(price, pair.symbol)}</td>
      <td>${sig ? `<span class="tf-bias ${sig.signal === "BUY" ? "bull" : "bear"}">${sig.signal}</span>` : `<span class="tf-bias neutral">—</span>`}</td>
      <td>${sig ? sig.strength : "—"}</td>
    </tr>`;
  }
  tbody.innerHTML = html;
}

function biasCell(bias) {
  return `<span class="tf-bias ${bias.cls}">${bias.label}</span>`;
}

// ── Performance stats ────────────────────────────────────────────────────────
export function renderStats(stats, elements) {
  elements.total.textContent = stats.totalTrades;
  elements.winrate.textContent = stats.totalTrades ? stats.winRate + "%" : "—";
  elements.pf.textContent = stats.totalTrades ? stats.profitFactor : "—";
  elements.pips.textContent = stats.totalTrades ? fmtPips(stats.totalPips) : "—";
  elements.expectancy.textContent = stats.totalTrades ? stats.expectancy.toFixed(2) + "R" : "—";
  elements.dd.textContent = stats.totalTrades ? stats.maxDrawdown.toFixed(2) + "R" : "—";
  elements.avgwin.textContent = stats.totalTrades ? stats.avgWin.toFixed(2) + "R" : "—";
  elements.avgloss.textContent = stats.totalTrades ? stats.avgLoss.toFixed(2) + "R" : "—";
  // Color coding
  elements.expectancy.className = "stat-value " + (stats.expectancy >= 0 ? "positive" : "negative");
  elements.pips.className = "stat-value " + (stats.totalPips >= 0 ? "positive" : "negative");
  elements.pf.className = "stat-value " + (stats.profitFactor >= 1 ? "positive" : "negative");
}

export function renderTradesLog(trades, container) {
  if (!trades.length) {
    container.innerHTML = `<div class="loading">No closed trades yet. Signals are in forward-test. Mark trades as WIN/LOSS as they close.</div>`;
    return;
  }
  const rows = trades.slice().reverse().map(t => `
    <div class="trade-row ${t.result?.toLowerCase()}">
      <span>${fmtTime(t.closedAt)}</span>
      <span class="result">${t.result || "—"}</span>
      <span>${t.pair || "—"}</span>
      <span>${fmtPips(t.pips)} pips</span>
      <span>${t.notes || ""}</span>
    </div>`).join("");
  container.innerHTML = `
    <div class="trade-row header">
      <span>Closed</span><span>Result</span><span>Pair</span><span>Pips</span><span>Notes</span>
    </div>${rows}`;
}
