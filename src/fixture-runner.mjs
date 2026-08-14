import { PATHS } from './constants.mjs';
import { tick } from './engine.mjs';
import { FixtureMarketData, FixtureModelRunner } from './fixtures.mjs';
import { atomicWriteJson, ensureDataLayout, listJournals, loadState, readRun } from './storage.mjs';

async function main() {
  await ensureDataLayout();
  const initial = await loadState();
  initial.settings.ticker = 'FIXT';
  initial.settings.tickerName = 'Fixture Corp';
  initial.settings.automationEnabled = true;
  initial.settings.updatedAt = new Date().toISOString();
  await atomicWriteJson(PATHS.settings, initial.settings);

  const market = new FixtureMarketData();
  const models = new FixtureModelRunner();
  const modelRunner = (request) => models.run(request);
  const open = await tick({ source: 'fixture', clock: () => new Date('2026-08-10T16:05:00.000Z'), market, modelRunner, lock: false });
  const duplicateDecision = await tick({ source: 'fixture-duplicate', clock: () => new Date('2026-08-10T16:06:00.000Z'), market, modelRunner, lock: false });
  const close = await tick({ source: 'fixture-close', clock: () => new Date('2026-08-10T20:05:00.000Z'), market, modelRunner, lock: false });
  const duplicateClose = await tick({ source: 'fixture-duplicate-close', clock: () => new Date('2026-08-10T20:06:00.000Z'), market, modelRunner, lock: false });
  const finalState = await loadState();
  const journals = await listJournals();
  const decisionCalls = models.calls.filter((call) => call.type === 'decision').length;
  const reflectionCalls = models.calls.filter((call) => call.type === 'reflection').length;
  const completedRun = finalState.runtime.runsByMarketDate['2026-08-10'];
  const runArtifacts = await readRun(completedRun.id);
  const assertions = {
    exactlyOneDecision: decisionCalls === 1,
    exactlyOneFill: open.outcome === 'paper_position_opened' && duplicateDecision.outcome === 'close_pending',
    exactlyOneClose: finalState.orders.length === 1 && close.outcome === 'settled_and_reflected',
    exactlyOneLedgerRow: finalState.orders.length === 1,
    exactlyOneReflection: reflectionCalls === 1 && journals.length === 1,
    duplicateCloseSafe: duplicateClose.outcome === 'already_processed',
    noOpenPosition: finalState.account.openPosition === null,
    snapshotChecksumMatches: runArtifacts.artifacts['input.snapshot.json'].sha256 === completedRun.snapshotSha256
  };
  const ok = Object.values(assertions).every(Boolean);
  process.stdout.write(JSON.stringify({
    ok,
    fixtureOnly: true,
    dataDirectory: process.env.AGENTTRADER_DATA_DIR,
    invocations: { decision: decisionCalls, reflection: reflectionCalls },
    assertions,
    outcomes: { open: open.outcome, duplicateDecision: duplicateDecision.outcome, close: close.outcome, duplicateClose: duplicateClose.outcome },
    order: finalState.orders[0],
    journal: journals[0] ? { marketDate: journals[0].marketDate, characters: journals[0].markdown.length } : null
  }));
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
