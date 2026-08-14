import { MODEL_ID, REASONING_EFFORT } from './constants.mjs';
import { YahooMarketData } from './market.mjs';
import { probeOmpExecutable, runOmp } from './omp.mjs';
import { fixtureContractPrompt } from './prompts.mjs';
import { parseJsonText, validateFixtureContract } from './schemas.mjs';
import { inspectScheduledTask } from './scheduler.mjs';
import { ensureDataLayout, loadState } from './storage.mjs';

export async function healthCheck({ liveYahoo = true, liveOmp = false, market = new YahooMarketData(), modelRunner = runOmp } = {}) {
  const checkedAt = new Date().toISOString();
  const result = {
    ok: true,
    checkedAt,
    paperOnly: true,
    storage: { ok: false },
    model: {
      ok: false,
      required: MODEL_ID,
      reasoningEffort: REASONING_EFFORT,
      authentication: 'OMP authenticated openai-codex subscription session; no API key is created or stored',
      liveContract: null
    },
    marketData: { ok: false, source: 'Yahoo Finance chart API (unofficial, no SLA)', liveChecked: liveYahoo },
    scheduledTask: null
  };
  try {
    await ensureDataLayout();
    const state = await loadState();
    result.storage = { ok: true, orders: state.orders.length, runs: Object.keys(state.runtime.runsByMarketDate || {}).length };
    result.settings = { ticker: state.settings.ticker, automationEnabled: state.settings.automationEnabled };
  } catch (error) {
    result.storage = { ok: false, error: error.message };
    result.ok = false;
  }

  const omp = await probeOmpExecutable();
  result.model = { ...result.model, ...omp, ok: omp.available };
  if (!omp.available) result.ok = false;
  if (liveOmp && omp.available) {
    try {
      const response = await modelRunner({ prompt: fixtureContractPrompt(), tools: [] });
      const contract = validateFixtureContract(parseJsonText(response.finalText));
      result.model.liveContract = {
        ok: true,
        contract,
        resolvedModel: response.model,
        usage: response.usage,
        elapsedMs: response.elapsedMs
      };
    } catch (error) {
      result.model.liveContract = { ok: false, code: error.code || 'ERROR', error: error.message };
      result.model.ok = false;
      result.ok = false;
    }
  }

  if (liveYahoo) {
    try {
      const chart = await market.chart('SPY', { range: '1d', interval: '1m' });
      const latest = chart.bars.at(-1);
      result.marketData = {
        ok: Boolean(latest),
        source: chart.source,
        liveChecked: true,
        symbol: chart.meta.symbol,
        latestBarAt: latest?.time || null,
        latestPrice: latest?.close || null,
        bars: chart.bars.length,
        session: chart.meta.session
      };
      if (!latest) result.ok = false;
    } catch (error) {
      result.marketData = { ok: false, source: 'Yahoo Finance chart API (unofficial, no SLA)', liveChecked: true, code: error.code, error: error.message };
      result.ok = false;
    }
  } else {
    result.marketData = { ok: null, source: 'Yahoo Finance chart API (unofficial, no SLA)', liveChecked: false };
  }
  result.scheduledTask = await inspectScheduledTask();
  return result;
}
