import { test } from "node:test";
import assert from "node:assert/strict";
import { calculatePerformance, equityCurve } from "../performance.js";

test("calculatePerformance on empty trades returns zeros", () => {
  const p = calculatePerformance([]);
  assert.equal(p.totalTrades, 0);
  assert.equal(p.winRate, 0);
});

test("calculatePerformance counts wins/losses correctly", () => {
  const trades = [
    { result: "WIN",  pips: 50, rr: 2.0, closedAt: "2024-01-01T10:00:00Z", pair: "EURUSD" },
    { result: "LOSS", pips: 25, rr: 1.0, closedAt: "2024-01-02T10:00:00Z", pair: "EURUSD" },
    { result: "WIN",  pips: 70, rr: 2.5, closedAt: "2024-01-03T10:00:00Z", pair: "GBPUSD" },
  ];
  const p = calculatePerformance(trades);
  assert.equal(p.totalTrades, 3);
  assert.equal(p.wins, 2);
  assert.equal(p.losses, 1);
  assert.ok(p.winRate > 0);
  assert.ok(p.profitFactor > 1);
  assert.ok(p.expectancy > 0);
});

test("calculatePerformance correctly computes drawdown", () => {
  const trades = [
    { result: "WIN",  pips: 30, rr: 2.0, closedAt: "2024-01-01T00:00:00Z" },
    { result: "WIN",  pips: 30, rr: 2.0, closedAt: "2024-01-02T00:00:00Z" },
    { result: "LOSS", pips: 20, rr: 1.0, closedAt: "2024-01-03T00:00:00Z" },
    { result: "LOSS", pips: 20, rr: 1.0, closedAt: "2024-01-04T00:00:00Z" },
    { result: "LOSS", pips: 20, rr: 1.0, closedAt: "2024-01-05T00:00:00Z" },
  ];
  const p = calculatePerformance(trades);
  assert.ok(p.maxDrawdown >= 2, `Max drawdown should be at least 2R, got ${p.maxDrawdown}`);
});

test("equityCurve length matches trades", () => {
  const trades = [
    { result: "WIN",  pips: 50, rr: 2.0, closedAt: "2024-01-01T00:00:00Z" },
    { result: "LOSS", pips: 25, rr: 1.0, closedAt: "2024-01-02T00:00:00Z" },
  ];
  const ec = equityCurve(trades);
  assert.equal(ec.length, 2);
  assert.ok(ec[1].equity > 0);
});
