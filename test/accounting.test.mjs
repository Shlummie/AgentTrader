import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computePerformance,
  effectiveEntryPrice,
  effectiveExitPrice,
  openPaperPosition,
  settlePaperPosition
} from '../src/accounting.mjs';

test('five-basis-point prices are adverse for longs and shorts', () => {
  assert.equal(effectiveEntryPrice('BUY', 100), 100.05);
  assert.equal(effectiveExitPrice('BUY', 100), 99.95);
  assert.equal(effectiveEntryPrice('SELL', 100), 99.95);
  assert.equal(effectiveExitPrice('SELL', 100), 100.05);
});

test('fractional long sizing uses effective entry and closes net of both slippages', () => {
  const open = openPaperPosition({ action: 'BUY', allocationPct: 25, equity: 100_000, observedPrice: 100, enteredAt: 'entry', symbol: 'TEST' });
  assert.equal(open.notional, 25_000);
  assert.equal(open.quantity, 25_000 / 100.05);
  assert.equal(open.reservedMargin, 0);
  const settled = settlePaperPosition(open, 101, 'exit');
  assert.ok(settled.pnl > 0);
  assert.equal(settled.equityAfter, 100_000 + settled.pnl);
});

test('short notional is fully reserved and never becomes reusable buying power', () => {
  const open = openPaperPosition({ action: 'SELL', allocationPct: 100, equity: 100_000, observedPrice: 100, enteredAt: 'entry', symbol: 'TEST' });
  assert.equal(open.notional, 100_000);
  assert.equal(open.reservedMargin, 100_000);
  assert.equal(open.quantity, 100_000 / 99.95);
  const win = settlePaperPosition(open, 90, 'exit');
  assert.ok(win.pnl > 0);
  const catastrophic = settlePaperPosition(open, 210, 'exit');
  assert.ok(catastrophic.equityAfter < 0);
});

test('performance computes drawdown, calibration, streak, and always-long comparison', () => {
  const orders = [
    { status: 'CLOSED', marketDate: '2026-01-01', action: 'BUY', confidencePct: 80, observedEntryPrice: 100, observedExitPrice: 110, pnl: 10_000, alwaysLongPnl: 9_000, equityAfter: 110_000 },
    { status: 'CLOSED', marketDate: '2026-01-02', action: 'SELL', confidencePct: 70, observedEntryPrice: 100, observedExitPrice: 105, pnl: -15_000, alwaysLongPnl: 5_000, equityAfter: 95_000 }
  ];
  const result = computePerformance(orders);
  assert.equal(result.trades, 2);
  assert.equal(result.winRatePct, 50);
  assert.equal(result.maxDrawdownPct, (15_000 / 110_000) * 100);
  assert.equal(result.currentStreak.type, 'loss');
  assert.equal(result.actualVsAlwaysLongPnl, -19_000);
  assert.ok(result.brierScore >= 0 && result.brierScore <= 1);
});
