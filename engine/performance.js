/**
 * performance.js — Trade performance statistics (pure functions).
 *
 * Computes win rate, profit factor, expectancy, max drawdown, etc.
 * Works on closed trades only — never invents or smooths results.
 */

/**
 * Calculate performance stats from a list of closed trades.
 * Each trade: { signalId, result: 'WIN'|'LOSS'|'BREAKEVEN', pips, rr, closedAt, ... }
 */
export function calculatePerformance(trades) {
  if (!trades || trades.length === 0) {
    return {
      totalTrades: 0,
      wins: 0, losses: 0, breakEvens: 0,
      winRate: 0,
      totalPips: 0,
      avgWin: 0, avgLoss: 0,
      profitFactor: 0,
      expectancy: 0,
      maxDrawdown: 0,
      longestWinStreak: 0,
      longestLossStreak: 0,
      byPair: {},
    };
  }
  let wins = 0, losses = 0, be = 0;
  let totalWinR = 0, totalLossR = 0, totalPips = 0;
  let winPips = 0, lossPips = 0;
  let curWinStreak = 0, curLossStreak = 0, maxWinStr = 0, maxLossStr = 0;
  const byPair = {};

  // Equity curve in R units (for drawdown)
  let equity = 0;
  let peak = 0;
  let maxDD = 0;

  const sorted = [...trades].sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt));
  for (const t of sorted) {
    const p = t.pair || "unknown";
    if (!byPair[p]) byPair[p] = { wins: 0, losses: 0, total: 0, pips: 0 };
    byPair[p].total++;
    if (t.result === "WIN") {
      wins++;
      winPips += t.pips || 0;
      totalWinR += t.rr || 1;
      curWinStreak++; curLossStreak = 0;
      if (curWinStreak > maxWinStr) maxWinStr = curWinStreak;
      equity += t.rr || 1;
    } else if (t.result === "LOSS") {
      losses++;
      lossPips += t.pips || 0;
      totalLossR += 1;
      curLossStreak++; curWinStreak = 0;
      if (curLossStreak > maxLossStr) maxLossStr = curLossStreak;
      equity -= 1;
    } else {
      be++;
    }
    totalPips += (t.pips || 0) * (t.result === "LOSS" ? -1 : 1);
    byPair[p].pips += (t.pips || 0) * (t.result === "LOSS" ? -1 : 1);
    if (t.result === "WIN") byPair[p].wins++;
    if (t.result === "LOSS") byPair[p].losses++;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }

  const total = wins + losses;
  const winRate = total > 0 ? (wins / total) * 100 : 0;
  const avgWin = wins > 0 ? totalWinR / wins : 0;
  const avgLoss = losses > 0 ? totalLossR / losses : 0;
  const profitFactor = totalLossR > 0 ? totalWinR / totalLossR : (wins > 0 ? Infinity : 0);
  const expectancy = total > 0 ? (winRate / 100 * avgWin - (losses / total) * avgLoss) : 0;

  return {
    totalTrades: sorted.length,
    wins, losses, breakEvens: be,
    winRate: Math.round(winRate * 10) / 10,
    totalPips: Math.round(totalPips * 10) / 10,
    avgWin: Math.round(avgWin * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    profitFactor: Math.round(profitFactor * 100) / 100,
    expectancy: Math.round(expectancy * 100) / 100,
    maxDrawdown: Math.round(maxDD * 100) / 100,
    longestWinStreak: maxWinStr,
    longestLossStreak: maxLossStr,
    byPair,
  };
}

/**
 * Build an equity curve from closed trades (in R multiples).
 */
export function equityCurve(trades) {
  const sorted = [...(trades || [])].sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt));
  let equity = 0;
  return sorted.map(t => {
    if (t.result === "WIN") equity += t.rr || 1;
    else if (t.result === "LOSS") equity -= 1;
    return { time: t.closedAt, equity: Math.round(equity * 100) / 100 };
  });
}
