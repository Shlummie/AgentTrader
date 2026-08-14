import { SLIPPAGE_RATE, STARTING_EQUITY } from './constants.mjs';

function assertFinitePositive(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive finite number`);
}

export function effectiveEntryPrice(action, observedPrice, slippageRate = SLIPPAGE_RATE) {
  assertFinitePositive(observedPrice, 'observedPrice');
  if (action === 'BUY') return observedPrice * (1 + slippageRate);
  if (action === 'SELL') return observedPrice * (1 - slippageRate);
  throw new Error(`Unsupported action: ${action}`);
}

export function effectiveExitPrice(action, observedPrice, slippageRate = SLIPPAGE_RATE) {
  assertFinitePositive(observedPrice, 'observedPrice');
  if (action === 'BUY') return observedPrice * (1 - slippageRate);
  if (action === 'SELL') return observedPrice * (1 + slippageRate);
  throw new Error(`Unsupported action: ${action}`);
}

export function openPaperPosition({ action, allocationPct, equity, observedPrice, enteredAt, symbol }) {
  if (!Number.isInteger(allocationPct) || allocationPct < 1 || allocationPct > 100) {
    throw new Error('allocationPct must be an integer from 1 to 100');
  }
  assertFinitePositive(equity, 'equity');
  const entryPrice = effectiveEntryPrice(action, observedPrice);
  const notional = equity * allocationPct / 100;
  const quantity = notional / entryPrice;
  return {
    symbol,
    action,
    allocationPct,
    equityBefore: equity,
    notional,
    reservedMargin: action === 'SELL' ? notional : 0,
    quantity,
    observedEntryPrice: observedPrice,
    entryPrice,
    enteredAt
  };
}

export function settlePaperPosition(position, observedExitPrice, exitedAt) {
  const exitPrice = effectiveExitPrice(position.action, observedExitPrice);
  const pnl = position.action === 'BUY'
    ? position.quantity * (exitPrice - position.entryPrice)
    : position.quantity * (position.entryPrice - exitPrice);
  const equityAfter = position.equityBefore + pnl;
  const alwaysLongEntry = effectiveEntryPrice('BUY', position.observedEntryPrice);
  const alwaysLongExit = effectiveExitPrice('BUY', observedExitPrice);
  const alwaysLongQuantity = position.notional / alwaysLongEntry;
  const alwaysLongPnl = alwaysLongQuantity * (alwaysLongExit - alwaysLongEntry);
  return {
    ...position,
    observedExitPrice,
    exitPrice,
    exitedAt,
    pnl,
    returnPct: pnl / position.equityBefore * 100,
    positionReturnPct: pnl / position.notional * 100,
    equityAfter,
    alwaysLongPnl,
    alwaysLongReturnPct: alwaysLongPnl / position.equityBefore * 100
  };
}

export function confidenceBrierScore(order) {
  const confidence = Math.max(0, Math.min(100, Number(order.confidencePct))) / 100;
  const predictedUp = order.action === 'BUY' ? confidence : 1 - confidence;
  const outcomeUp = order.observedExitPrice > order.observedEntryPrice
    ? 1
    : order.observedExitPrice < order.observedEntryPrice ? 0 : 0.5;
  return (predictedUp - outcomeUp) ** 2;
}

export function computePerformance(orders, startingEquity = STARTING_EQUITY) {
  const closed = orders.filter((order) => order.status === 'CLOSED' && Number.isFinite(order.equityAfter));
  let peak = startingEquity;
  let maxDrawdownPct = 0;
  let wins = 0;
  let losses = 0;
  let currentStreak = 0;
  let currentStreakType = null;
  let longestWinStreak = 0;
  let longestLossStreak = 0;
  let alwaysLongPnl = 0;
  const equityCurve = [{ index: 0, equity: startingEquity, marketDate: null }];
  const confidenceBuckets = new Map();

  for (const [index, order] of closed.entries()) {
    const equity = order.equityAfter;
    peak = Math.max(peak, equity);
    if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, (peak - equity) / peak * 100);
    equityCurve.push({ index: index + 1, equity, marketDate: order.marketDate });
    alwaysLongPnl += Number(order.alwaysLongPnl || 0);

    const result = order.pnl > 0 ? 'win' : order.pnl < 0 ? 'loss' : 'flat';
    if (result === 'win') wins += 1;
    if (result === 'loss') losses += 1;
    if (result === 'flat') {
      currentStreak = 0;
      currentStreakType = null;
    } else if (currentStreakType === result) {
      currentStreak += 1;
    } else {
      currentStreakType = result;
      currentStreak = 1;
    }
    if (result === 'win') longestWinStreak = Math.max(longestWinStreak, currentStreak);
    if (result === 'loss') longestLossStreak = Math.max(longestLossStreak, currentStreak);

    const bucketStart = Math.floor(Math.min(99, Number(order.confidencePct || 0)) / 10) * 10;
    const bucket = confidenceBuckets.get(bucketStart) || { from: bucketStart, to: bucketStart + 9, count: 0, wins: 0 };
    bucket.count += 1;
    if (order.pnl > 0) bucket.wins += 1;
    confidenceBuckets.set(bucketStart, bucket);
  }

  const finalEquity = closed.length ? closed.at(-1).equityAfter : startingEquity;
  const brierScore = closed.length
    ? closed.reduce((sum, order) => sum + confidenceBrierScore(order), 0) / closed.length
    : null;
  return {
    startingEquity,
    equity: finalEquity,
    netPnl: finalEquity - startingEquity,
    netReturnPct: (finalEquity - startingEquity) / startingEquity * 100,
    trades: closed.length,
    wins,
    losses,
    winRatePct: closed.length ? wins / closed.length * 100 : null,
    maxDrawdownPct,
    brierScore,
    currentStreak: currentStreakType ? { type: currentStreakType, count: currentStreak } : null,
    longestWinStreak,
    longestLossStreak,
    alwaysLongPnl,
    actualVsAlwaysLongPnl: finalEquity - startingEquity - alwaysLongPnl,
    confidenceCalibration: [...confidenceBuckets.values()].sort((a, b) => a.from - b.from).map((bucket) => ({
      ...bucket,
      winRatePct: bucket.count ? bucket.wins / bucket.count * 100 : null
    })),
    equityCurve
  };
}
