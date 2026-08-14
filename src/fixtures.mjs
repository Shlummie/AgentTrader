import { spawn } from 'node:child_process';
import path from 'node:path';
import { DATA_ROOT, PROJECT_ROOT } from './constants.mjs';

export function fixtureSeries(symbol, instrumentType, bars, session) {
  return {
    source: 'AgentTrader deterministic fixture',
    requestedSymbol: symbol,
    requestedAt: '2026-08-10T16:05:00.000Z',
    request: { range: 'fixture', interval: 'fixture', period1: null, period2: null },
    meta: {
      symbol,
      currency: 'USD',
      exchangeName: symbol === '^VIX' ? 'CBOE' : 'NMS',
      fullExchangeName: symbol === '^VIX' ? 'Cboe Indices' : 'NasdaqGS',
      instrumentType,
      exchangeTimezoneName: 'America/New_York',
      regularMarketPrice: bars.at(-1).close,
      regularMarketTime: bars.at(-1).time,
      longName: symbol,
      session
    },
    bars
  };
}

function bar(time, close, index = 0) {
  const timestamp = Math.floor(Date.parse(time) / 1000);
  return {
    timestamp,
    time,
    open: close - 0.15,
    high: close + 0.25,
    low: close - 0.35,
    close,
    adjustedClose: close,
    volume: 100_000 + index * 1_000
  };
}

export class FixtureMarketData {
  constructor() {
    this.session = {
      startEpoch: Math.floor(Date.parse('2026-08-10T13:30:00.000Z') / 1000),
      endEpoch: Math.floor(Date.parse('2026-08-10T20:00:00.000Z') / 1000),
      start: '2026-08-10T13:30:00.000Z',
      end: '2026-08-10T20:00:00.000Z',
      timezone: 'America/New_York'
    };
  }

  async validateTicker(input) {
    return { symbol: String(input).toUpperCase(), name: 'Fixture Corp', instrumentType: 'EQUITY', exchange: 'NasdaqGS', timezone: 'America/New_York', lastPrice: 100 };
  }

  async buildSnapshot(symbol, now) {
    const targetBars = [
      bar('2026-08-10T13:30:00.000Z', 98.5, 0),
      bar('2026-08-10T15:00:00.000Z', 99.2, 1),
      bar('2026-08-10T16:04:00.000Z', 100, 2)
    ];
    const spyBars = [bar('2026-08-10T13:30:00.000Z', 550, 0), bar('2026-08-10T16:04:00.000Z', 552, 1)];
    const vixBars = [bar('2026-08-10T13:30:00.000Z', 17.5, 0), bar('2026-08-10T16:04:00.000Z', 16.9, 1)];
    const target = fixtureSeries(symbol, 'EQUITY', targetBars, this.session);
    const spy = fixtureSeries('SPY', 'ETF', spyBars, this.session);
    const vix = fixtureSeries('^VIX', 'INDEX', vixBars, this.session);
    return {
      schemaVersion: 1,
      source: 'AgentTrader deterministic fixture',
      symbol,
      capturedAt: now.toISOString(),
      marketDate: '2026-08-10',
      freshness: {
        targetIntraday: { latestBarAt: targetBars.at(-1).time, ageMs: 60_000, maxAgeMs: 300_000 },
        spyIntraday: { latestBarAt: spyBars.at(-1).time, ageMs: 60_000, maxAgeMs: 300_000 },
        vixIntraday: { latestBarAt: vixBars.at(-1).time, ageMs: 60_000, maxAgeMs: 300_000 }
      },
      session: this.session,
      data: {
        targetIntraday: target,
        targetFiveDay: target,
        targetSixMonth: target,
        spyIntraday: spy,
        spyFiveDay: spy,
        spySixMonth: spy,
        vixIntraday: vix,
        vixFiveDay: vix,
        vixSixMonth: vix
      }
    };
  }

  async fetchObservedPrice(symbol) {
    return { symbol, observedAt: '2026-08-10T16:05:00.000Z', observedPrice: 100, freshnessAgeMs: 60_000, session: this.session, source: 'AgentTrader deterministic fixture' };
  }

  async fetchSessionClose(symbol, marketDate) {
    return { symbol, marketDate, observedAt: '2026-08-10T20:00:00.000Z', observedPrice: 102, method: 'fixture-regular-session-close', source: 'AgentTrader deterministic fixture' };
  }
}

export class FixtureModelRunner {
  constructor({ malformedDecision = false, reflectionFailure = false } = {}) {
    this.calls = [];
    this.malformedDecision = malformedDecision;
    this.reflectionFailure = reflectionFailure;
  }

  async run({ prompt, tools }) {
    const type = prompt.includes('after-close reflection model') ? 'reflection' : 'decision';
    this.calls.push({ type, tools });
    if (type === 'decision' && this.malformedDecision) return this.response('{not-json');
    if (type === 'reflection' && this.reflectionFailure) throw Object.assign(new Error('Fixture reflection timeout'), { code: 'OMP_TIMEOUT' });
    if (type === 'decision') {
      return this.response(JSON.stringify({
        action: 'BUY',
        allocationPct: 50,
        confidencePct: 70,
        thesis: 'Price strength is positive relative to the morning range in the frozen fixture.',
        evidence: [{ claim: 'Target rose from 98.50 to 100.00 while SPY also advanced.', source: 'Frozen snapshot', asOf: '2026-08-10T16:04:00.000Z' }],
        risks: ['The midday move could reverse before the close.'],
        invalidation: 'A break below the fixture morning midpoint would invalidate the momentum thesis.',
        lessonsUsed: [],
        researchStatus: 'not_used'
      }));
    }
    return this.response(JSON.stringify({
      verdict: 'good_decision_good_outcome',
      dailyReflectionMarkdown: '# Decision and outcome\n\nThe frozen setup supported a bounded momentum decision, and the favorable close matched the thesis. The outcome does not prove repeatability.\n\n## Sizing\n\nFifty percent was assertive; future sizing should depend on calibration.\n\n## Confidence\n\nSeventy percent was directionally calibrated for this one observation.\n\n## Lesson\n\nSeparate contemporaneous evidence from hindsight.',
      updatedPlaybookMarkdown: '# AgentTrader Learning Playbook\n\n## Durable lessons\n\n- Judge a trade from evidence frozen before entry, not from its outcome.\n- Use broad-market confirmation as context, not as proof.\n\n## Sizing and confidence\n\n- Keep sizing proportional to demonstrated calibration; one win does not justify higher allocation.',
      lessons: ['Separate decision quality from outcome quality.'],
      sizingAssessment: 'The 50% allocation was high for an uncalibrated first observation.',
      confidenceAssessment: 'The 70% confidence is one data point and cannot yet be considered calibrated.'
    }));
  }

  response(finalText) {
    return {
      finalText,
      model: { provider: 'openai-codex', id: 'gpt-5.6-sol', requested: 'openai-codex/gpt-5.6-sol', reasoningEffort: 'max' },
      usage: { input: 100, output: 50 },
      research: { queries: [], sources: [] },
      elapsedMs: 5
    };
  }
}

export async function runFixtureDryRun() {
  const fixtureRoot = path.join(DATA_ROOT, 'fixture-dry-runs', new Date().toISOString().replace(/[:.]/g, '-'));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/fixture-runner.mjs'], {
      cwd: PROJECT_ROOT,
      shell: false,
      windowsHide: true,
      env: { ...process.env, AGENTTRADER_DATA_DIR: fixtureRoot },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || stdout.trim() || `Fixture runner exited ${code}`));
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(new Error(`Fixture runner returned invalid JSON: ${error.message}`)); }
    });
  });
}
