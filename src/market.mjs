import { MAX_BAR_AGE_MS } from './constants.mjs';
import { dateKey, isoFromEpochSeconds } from './time.mjs';

const YAHOO_CHART_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const ALLOWED_TYPES = new Set(['EQUITY', 'ETF']);
const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.-]{0,9}$/;

export class MarketDataError extends Error {
  constructor(message, code = 'MARKET_DATA_ERROR', details = undefined) {
    super(message);
    this.name = 'MarketDataError';
    this.code = code;
    this.details = details;
  }
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function normalizeBars(result) {
  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const adjusted = result.indicators?.adjclose?.[0]?.adjclose || [];
  return timestamps.map((timestamp, index) => ({
    timestamp,
    time: isoFromEpochSeconds(timestamp),
    open: finiteOrNull(quote.open?.[index]),
    high: finiteOrNull(quote.high?.[index]),
    low: finiteOrNull(quote.low?.[index]),
    close: finiteOrNull(quote.close?.[index]),
    adjustedClose: finiteOrNull(adjusted[index]),
    volume: finiteOrNull(quote.volume?.[index])
  })).filter((bar) => bar.close !== null);
}

function normalizeMeta(meta = {}) {
  const regular = meta.currentTradingPeriod?.regular || null;
  return {
    symbol: meta.symbol || null,
    currency: meta.currency || null,
    exchangeName: meta.exchangeName || null,
    fullExchangeName: meta.fullExchangeName || null,
    instrumentType: meta.instrumentType || null,
    exchangeTimezoneName: meta.exchangeTimezoneName || null,
    regularMarketPrice: finiteOrNull(meta.regularMarketPrice),
    regularMarketTime: Number.isFinite(meta.regularMarketTime) ? isoFromEpochSeconds(meta.regularMarketTime) : null,
    longName: meta.longName || meta.shortName || meta.symbol || null,
    session: regular && Number.isFinite(regular.start) && Number.isFinite(regular.end) ? {
      startEpoch: regular.start,
      endEpoch: regular.end,
      start: isoFromEpochSeconds(regular.start),
      end: isoFromEpochSeconds(regular.end),
      timezone: meta.exchangeTimezoneName || 'America/New_York'
    } : null
  };
}

export function normalizeTicker(input) {
  if (typeof input !== 'string') throw new MarketDataError('Ticker must be text', 'INVALID_TICKER');
  const entered = input.trim().toUpperCase();
  if (!SYMBOL_PATTERN.test(entered)) {
    throw new MarketDataError('Ticker must be 1-10 characters using letters, numbers, dot, or hyphen', 'INVALID_TICKER');
  }
  return entered.replaceAll('.', '-');
}

async function fetchWithTimeout(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'AgentTrader/1.0 paper-only research'
      }
    });
  } catch (error) {
    if (error.name === 'AbortError') throw new MarketDataError('Yahoo Finance request timed out', 'YAHOO_TIMEOUT');
    throw new MarketDataError(`Yahoo Finance request failed: ${error.message}`, 'YAHOO_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
  }
}

export class YahooMarketData {
  constructor({ fetchImpl = globalThis.fetch, baseUrl = YAHOO_CHART_BASE, timeoutMs = 15_000 } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
    this.fetchImpl = fetchImpl;
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
  }

  async chart(symbolInput, { range, interval, period1, period2 } = {}) {
    const symbol = symbolInput === '^VIX' ? '^VIX' : normalizeTicker(symbolInput);
    const params = new URLSearchParams({ interval: interval || '1d', includePrePost: 'false', events: 'div,splits,capitalGains' });
    if (range) params.set('range', range);
    if (period1) params.set('period1', String(period1));
    if (period2) params.set('period2', String(period2));
    if (!range && !period1) params.set('range', '5d');
    const url = `${this.baseUrl}/${encodeURIComponent(symbol)}?${params}`;
    const response = await fetchWithTimeout(this.fetchImpl, url, this.timeoutMs);
    if (!response.ok) throw new MarketDataError(`Yahoo Finance returned HTTP ${response.status}`, 'YAHOO_HTTP', { status: response.status });
    let payload;
    try { payload = await response.json(); } catch (error) {
      throw new MarketDataError(`Yahoo Finance returned invalid JSON: ${error.message}`, 'YAHOO_INVALID_JSON');
    }
    const apiError = payload?.chart?.error;
    if (apiError) throw new MarketDataError(`Yahoo Finance rejected ${symbol}: ${apiError.description || apiError.code}`, 'YAHOO_REJECTED');
    const result = payload?.chart?.result?.[0];
    if (!result) throw new MarketDataError(`Yahoo Finance returned no chart for ${symbol}`, 'YAHOO_EMPTY');
    const bars = normalizeBars(result);
    return {
      source: 'Yahoo Finance chart API (unofficial, no SLA)',
      requestedSymbol: symbol,
      requestedAt: new Date().toISOString(),
      request: { range: range || null, interval: interval || '1d', period1: period1 || null, period2: period2 || null },
      meta: normalizeMeta(result.meta),
      bars
    };
  }

  async validateTicker(input) {
    const symbol = normalizeTicker(input);
    const chart = await this.chart(symbol, { range: '5d', interval: '1d' });
    if (!ALLOWED_TYPES.has(chart.meta.instrumentType)) {
      throw new MarketDataError(`${symbol} is not an active US equity or ETF`, 'UNSUPPORTED_INSTRUMENT', {
        instrumentType: chart.meta.instrumentType
      });
    }
    if (chart.meta.exchangeTimezoneName !== 'America/New_York') {
      throw new MarketDataError(`${symbol} is not listed in a supported US market timezone`, 'UNSUPPORTED_EXCHANGE', {
        exchange: chart.meta.fullExchangeName || chart.meta.exchangeName,
        timezone: chart.meta.exchangeTimezoneName
      });
    }
    if (!chart.bars.length || !Number.isFinite(chart.bars.at(-1).close)) {
      throw new MarketDataError(`${symbol} has no recent tradable price bars`, 'INACTIVE_TICKER');
    }
    const latestAgeDays = (Date.now() - chart.bars.at(-1).timestamp * 1000) / 86_400_000;
    if (latestAgeDays > 14) throw new MarketDataError(`${symbol} has no recent market activity`, 'INACTIVE_TICKER');
    return {
      symbol,
      name: chart.meta.longName || symbol,
      instrumentType: chart.meta.instrumentType,
      exchange: chart.meta.fullExchangeName || chart.meta.exchangeName,
      timezone: chart.meta.exchangeTimezoneName,
      lastBarAt: chart.bars.at(-1).time,
      lastPrice: chart.bars.at(-1).close
    };
  }

  async buildSnapshot(symbolInput, now = new Date()) {
    const symbol = normalizeTicker(symbolInput);
    const specs = [
      ['targetIntraday', symbol, '1d', '1m'],
      ['targetFiveDay', symbol, '5d', '5m'],
      ['targetSixMonth', symbol, '6mo', '1d'],
      ['spyIntraday', 'SPY', '1d', '1m'],
      ['spyFiveDay', 'SPY', '5d', '5m'],
      ['spySixMonth', 'SPY', '6mo', '1d'],
      ['vixIntraday', '^VIX', '1d', '1m'],
      ['vixFiveDay', '^VIX', '5d', '5m'],
      ['vixSixMonth', '^VIX', '6mo', '1d']
    ];
    const settled = await Promise.all(specs.map(async ([key, requested, range, interval]) => [key, await this.chart(requested, { range, interval })]));
    const data = Object.fromEntries(settled);
    const validation = await this.validateSnapshot(symbol, data, now);
    return {
      schemaVersion: 1,
      source: 'Yahoo Finance chart API (unofficial, no SLA)',
      symbol,
      capturedAt: now.toISOString(),
      marketDate: dateKey(now),
      freshness: validation.freshness,
      session: validation.session,
      data
    };
  }

  async validateSnapshot(symbol, data, now = new Date()) {
    const target = data.targetIntraday;
    if (!target || target.meta.symbol?.toUpperCase() !== symbol.toUpperCase()) {
      throw new MarketDataError('Yahoo returned a mismatched target symbol', 'SYMBOL_MISMATCH');
    }
    if (!ALLOWED_TYPES.has(target.meta.instrumentType)) {
      throw new MarketDataError(`${symbol} is not an equity or ETF`, 'UNSUPPORTED_INSTRUMENT');
    }
    if (target.meta.exchangeTimezoneName !== 'America/New_York') {
      throw new MarketDataError(`${symbol} is outside the supported US market timezone`, 'UNSUPPORTED_EXCHANGE');
    }
    if (!target.meta.session) throw new MarketDataError('Yahoo did not report a regular market session', 'SESSION_MISSING');
    const today = dateKey(now);
    if (dateKey(target.meta.session.start) !== today) {
      throw new MarketDataError(`No regular session is reported for ${today}; market may be closed`, 'MARKET_CLOSED');
    }
    const freshness = {};
    for (const key of ['targetIntraday', 'spyIntraday', 'vixIntraday']) {
      const bars = data[key]?.bars || [];
      const latest = bars.at(-1);
      if (!latest) throw new MarketDataError(`${key} has no current intraday bars`, 'MISSING_BARS');
      if (dateKey(latest.time) !== today) throw new MarketDataError(`${key} has no bars for ${today}`, 'MARKET_CLOSED');
      const ageMs = now.getTime() - latest.timestamp * 1000;
      freshness[key] = { latestBarAt: latest.time, ageMs, maxAgeMs: MAX_BAR_AGE_MS };
      if (ageMs > MAX_BAR_AGE_MS || ageMs < -90_000) {
        throw new MarketDataError(`${key} price data is stale or future-dated`, 'STALE_DATA', freshness[key]);
      }
    }
    for (const key of Object.keys(data)) {
      if (!data[key].bars.length) throw new MarketDataError(`${key} contains no usable bars`, 'MISSING_BARS');
    }
    return { freshness, session: target.meta.session };
  }

  async fetchObservedPrice(symbolInput, now = new Date()) {
    const symbol = normalizeTicker(symbolInput);
    const chart = await this.chart(symbol, { range: '1d', interval: '1m' });
    const latest = chart.bars.at(-1);
    if (!latest) throw new MarketDataError(`${symbol} has no current price`, 'MISSING_BARS');
    const ageMs = now.getTime() - latest.timestamp * 1000;
    if (dateKey(latest.time) !== dateKey(now) || ageMs > MAX_BAR_AGE_MS || ageMs < -90_000) {
      throw new MarketDataError(`${symbol} entry price is not fresh`, 'STALE_DATA', { latestBarAt: latest.time, ageMs });
    }
    return {
      symbol,
      observedAt: latest.time,
      observedPrice: latest.close,
      freshnessAgeMs: ageMs,
      session: chart.meta.session,
      source: chart.source
    };
  }

  async fetchSessionClose(symbolInput, marketDate, session) {
    const symbol = normalizeTicker(symbolInput);
    let intradayError = null;
    try {
      const chart = await this.chart(symbol, { range: '5d', interval: '1m' });
      const start = session.startEpoch;
      const end = session.endEpoch;
      const candidates = chart.bars.filter((bar) => bar.timestamp >= start && bar.timestamp <= end + 60 && dateKey(bar.time) === marketDate);
      if (candidates.length) {
        const bar = candidates.at(-1);
        return { symbol, marketDate, observedAt: bar.time, observedPrice: bar.close, method: 'final-regular-session-minute', source: chart.source };
      }
    } catch (error) {
      intradayError = error;
    }

    const period1 = session.startEpoch - 7 * 86_400;
    const period2 = session.endEpoch + 7 * 86_400;
    try {
      const chart = await this.chart(symbol, { period1, period2, interval: '1d' });
      const bar = chart.bars.find((candidate) => dateKey(candidate.time) === marketDate);
      if (!bar) throw new MarketDataError(`No historical close exists for ${symbol} on ${marketDate}`, 'CLOSE_MISSING');
      return { symbol, marketDate, observedAt: bar.time, observedPrice: bar.close, method: 'historical-daily-close', source: chart.source };
    } catch (error) {
      throw new MarketDataError(`Unable to recover ${symbol} close for ${marketDate}: ${error.message}`, 'CLOSE_UNAVAILABLE', {
        intradayError: intradayError?.message || null
      });
    }
  }
}

export function latestPriceFromSnapshot(snapshot) {
  const bar = snapshot?.data?.targetIntraday?.bars?.at(-1);
  if (!bar) throw new MarketDataError('Frozen snapshot contains no target price', 'MISSING_BARS');
  return bar.close;
}
