import test from 'node:test';
import assert from 'node:assert/strict';
import { YahooMarketData, MarketDataError, normalizeTicker } from '../src/market.mjs';

function payload(symbol = 'AAPL', type = 'EQUITY', timestamp = 1786377840, close = 200) {
  return {
    chart: { error: null, result: [{
      meta: {
        symbol, instrumentType: type, currency: 'USD', exchangeName: 'NMS', fullExchangeName: 'NasdaqGS',
        exchangeTimezoneName: 'America/New_York', regularMarketPrice: close, regularMarketTime: timestamp,
        currentTradingPeriod: { regular: { start: 1786368600, end: 1786392000 } }
      },
      timestamp: [timestamp], indicators: { quote: [{ open: [close - 1], high: [close + 1], low: [close - 2], close: [close], volume: [1000] }], adjclose: [{ adjclose: [close] }] }
    }] }
  };
}

test('ticker syntax is normalized and rejects unsafe symbols', () => {
  assert.equal(normalizeTicker(' aapl '), 'AAPL');
  assert.equal(normalizeTicker('brk.b'), 'BRK-B');
  assert.throws(() => normalizeTicker('../AAPL'), /Ticker/);
  assert.throws(() => normalizeTicker('^VIX'), /Ticker/);
});

test('Yahoo adapter validates supported active US equities/ETFs through deterministic HTTP fixtures', async () => {
  const adapter = new YahooMarketData({ fetchImpl: async () => new Response(JSON.stringify(payload()), { status: 200, headers: { 'content-type': 'application/json' } }) });
  const result = await adapter.validateTicker('AAPL');
  assert.equal(result.symbol, 'AAPL');
  assert.equal(result.instrumentType, 'EQUITY');
  assert.equal(result.exchange, 'NasdaqGS');
});

test('unsupported instruments and upstream failures do not create fallback prices', async () => {
  const cryptoAdapter = new YahooMarketData({ fetchImpl: async () => new Response(JSON.stringify(payload('BTC-USD', 'CRYPTOCURRENCY')), { status: 200 }) });
  await assert.rejects(() => cryptoAdapter.validateTicker('BTC-USD'), (error) => error instanceof MarketDataError && error.code === 'UNSUPPORTED_INSTRUMENT');
  const failed = new YahooMarketData({ fetchImpl: async () => new Response('down', { status: 503 }) });
  await assert.rejects(() => failed.chart('AAPL', { range: '1d', interval: '1m' }), (error) => error.code === 'YAHOO_HTTP');
});

test('stale intraday target, SPY, or VIX bars block the frozen snapshot', async () => {
  const adapter = new YahooMarketData({ fetchImpl: async () => { throw new Error('unused'); } });
  const now = new Date('2026-08-10T16:10:01.000Z');
  const series = (symbol, type) => ({ meta: { symbol, instrumentType: type, exchangeTimezoneName: 'America/New_York', session: { start: '2026-08-10T13:30:00.000Z', end: '2026-08-10T20:00:00.000Z', startEpoch: 1786368600, endEpoch: 1786392000 } }, bars: [{ timestamp: 1786377840, time: '2026-08-10T16:04:00.000Z', close: 100 }] });
  const target = series('AAPL', 'EQUITY');
  const spy = series('SPY', 'ETF');
  const vix = series('^VIX', 'INDEX');
  const data = { targetIntraday: target, targetFiveDay: target, targetSixMonth: target, spyIntraday: spy, spyFiveDay: spy, spySixMonth: spy, vixIntraday: vix, vixFiveDay: vix, vixSixMonth: vix };
  await assert.rejects(() => adapter.validateSnapshot('AAPL', data, now), (error) => error.code === 'STALE_DATA');
});
