import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agenttrader-engine-'));
process.env.AGENTTRADER_DATA_DIR = root;
const { PATHS } = await import(`../src/constants.mjs?engine=${Date.now()}`);
const { tick } = await import(`../src/engine.mjs?engine=${Date.now()}`);
const { FixtureMarketData, FixtureModelRunner } = await import(`../src/fixtures.mjs?engine=${Date.now()}`);
const { atomicWriteJson, ensureDataLayout, loadState, listJournals } = await import(`../src/storage.mjs?engine=${Date.now()}`);

async function reset() {
  await fs.rm(root, { recursive: true, force: true });
  await ensureDataLayout();
  const state = await loadState();
  state.settings.ticker = 'FIXT'; state.settings.tickerName = 'Fixture Corp'; state.settings.automationEnabled = true;
  await atomicWriteJson(PATHS.settings, state.settings);
}

test('simulated market day produces exactly one decision, fill, close, ledger row, and reflection', async () => {
  await reset();
  const market = new FixtureMarketData(); const models = new FixtureModelRunner(); const runner = (request) => models.run(request);
  const open = await tick({ clock: () => new Date('2026-08-10T16:05:00Z'), market, modelRunner: runner, lock: false });
  const overlap = await tick({ clock: () => new Date('2026-08-10T16:06:00Z'), market, modelRunner: runner, lock: false });
  const close = await tick({ clock: () => new Date('2026-08-10T20:05:00Z'), market, modelRunner: runner, lock: false });
  const again = await tick({ clock: () => new Date('2026-08-10T20:06:00Z'), market, modelRunner: runner, lock: false });
  const state = await loadState();
  assert.equal(open.outcome, 'paper_position_opened');
  assert.equal(overlap.outcome, 'close_pending');
  assert.equal(close.outcome, 'settled_and_reflected');
  assert.equal(again.outcome, 'already_processed');
  assert.equal(models.calls.filter((call) => call.type === 'decision').length, 1);
  assert.equal(models.calls.filter((call) => call.type === 'reflection').length, 1);
  assert.equal(state.orders.length, 1);
  assert.equal((await listJournals()).length, 1);
});

test('malformed model JSON is a terminal no-trade with no retry', async () => {
  await reset();
  const models = new FixtureModelRunner({ malformedDecision: true }); const runner = (request) => models.run(request);
  const first = await tick({ clock: () => new Date('2026-08-10T16:05:00Z'), market: new FixtureMarketData(), modelRunner: runner, lock: false });
  const second = await tick({ clock: () => new Date('2026-08-10T16:10:00Z'), market: new FixtureMarketData(), modelRunner: runner, lock: false });
  assert.equal(first.outcome, 'no_trade'); assert.equal(first.failure.code, 'INVALID_MODEL_OUTPUT');
  assert.equal(second.outcome, 'already_no_trade'); assert.equal(models.calls.length, 1);
  assert.equal((await loadState()).orders.length, 0);
});

for (const code of ['OMP_TIMEOUT', 'OMP_AUTH_FAILURE', 'OMP_QUOTA_FAILURE', 'OMP_MODEL_UNAVAILABLE']) {
  test(`${code} yields no trade and never substitutes a model`, async () => {
    await reset();
    let calls = 0;
    const runner = async () => { calls += 1; throw Object.assign(new Error(`Fixture ${code}`), { code }); };
    const first = await tick({ clock: () => new Date('2026-08-10T16:05:00Z'), market: new FixtureMarketData(), modelRunner: runner, lock: false });
    const second = await tick({ clock: () => new Date('2026-08-10T16:10:00Z'), market: new FixtureMarketData(), modelRunner: runner, lock: false });
    assert.equal(first.failure.code, code); assert.equal(second.outcome, 'already_no_trade'); assert.equal(calls, 1);
  });
}

test('missing web research proceeds from frozen price data when model flags not_used', async () => {
  await reset();
  const models = new FixtureModelRunner();
  const result = await tick({ clock: () => new Date('2026-08-10T16:05:00Z'), market: new FixtureMarketData(), modelRunner: (request) => models.run(request), lock: false });
  assert.equal(result.outcome, 'paper_position_opened');
  assert.equal(result.position.researchStatus, 'not_used');
});

test('sleep-through-close recovery preserves entry and settles from historical close later', async () => {
  await reset();
  const market = new FixtureMarketData(); const models = new FixtureModelRunner(); const runner = (request) => models.run(request);
  const open = await tick({ clock: () => new Date('2026-08-10T16:05:00Z'), market, modelRunner: runner, lock: false });
  const recovered = await tick({ clock: () => new Date('2026-08-11T16:05:00Z'), market, modelRunner: runner, lock: false });
  const state = await loadState();
  assert.equal(recovered.outcome, 'settled_and_reflected');
  assert.equal(state.orders[0].entryPrice, open.position.entryPrice);
  assert.equal(state.orders[0].closeMethod, 'fixture-regular-session-close');
});

test('reflection failure preserves settlement, creates immutable journal, and is not retried', async () => {
  await reset();
  const market = new FixtureMarketData(); const models = new FixtureModelRunner({ reflectionFailure: true }); const runner = (request) => models.run(request);
  await tick({ clock: () => new Date('2026-08-10T16:05:00Z'), market, modelRunner: runner, lock: false });
  const settled = await tick({ clock: () => new Date('2026-08-10T20:05:00Z'), market, modelRunner: runner, lock: false });
  const again = await tick({ clock: () => new Date('2026-08-10T20:06:00Z'), market, modelRunner: runner, lock: false });
  const state = await loadState();
  assert.equal(settled.outcome, 'settled_reflection_failed');
  assert.equal(state.orders.length, 1); assert.equal(state.account.openPosition, null);
  assert.equal((await listJournals()).length, 1);
  assert.equal(models.calls.filter((call) => call.type === 'reflection').length, 1);
  assert.equal(again.outcome, 'already_processed');
});

test('reported early close time controls settlement eligibility', async () => {
  await reset();
  const market = new FixtureMarketData();
  market.session = { startEpoch: Math.floor(Date.parse('2026-08-10T13:30:00Z') / 1000), endEpoch: Math.floor(Date.parse('2026-08-10T18:00:00Z') / 1000), start: '2026-08-10T13:30:00.000Z', end: '2026-08-10T18:00:00.000Z', timezone: 'America/New_York' };
  const models = new FixtureModelRunner(); const runner = (request) => models.run(request);
  await tick({ clock: () => new Date('2026-08-10T16:05:00Z'), market, modelRunner: runner, lock: false });
  const before = await tick({ clock: () => new Date('2026-08-10T17:59:59Z'), market, modelRunner: runner, lock: false });
  const after = await tick({ clock: () => new Date('2026-08-10T18:00:01Z'), market, modelRunner: runner, lock: false });
  assert.equal(before.outcome, 'close_pending'); assert.equal(after.outcome, 'settled_and_reflected');
});

test('equity at or below zero pauses every future experiment tick until explicit reset', async () => {
  await reset();
  const market = new FixtureMarketData();
  market.fetchSessionClose = async (symbol, marketDate) => ({ symbol, marketDate, observedAt: '2026-08-10T20:00:00.000Z', observedPrice: 210, method: 'fixture-catastrophic-close', source: 'fixture' });
  const models = new FixtureModelRunner();
  const originalRun = models.run.bind(models);
  const runner = async (request) => {
    const result = await originalRun(request);
    if (!request.prompt.includes('after-close reflection model')) {
      const value = JSON.parse(result.finalText); value.action = 'SELL'; value.allocationPct = 100; result.finalText = JSON.stringify(value);
    }
    return result;
  };
  await tick({ clock: () => new Date('2026-08-10T16:05:00Z'), market, modelRunner: runner, lock: false });
  await tick({ clock: () => new Date('2026-08-10T20:05:00Z'), market, modelRunner: runner, lock: false });
  const state = await loadState();
  assert.ok(state.account.equity < 0);
  assert.equal(state.account.paused, true);
  const future = await tick({ clock: () => new Date('2026-08-11T16:05:00Z'), market, modelRunner: runner, lock: false });
  assert.equal(future.outcome, 'paused');
  assert.equal(models.calls.filter((call) => call.type === 'decision').length, 1);
});
