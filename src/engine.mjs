import fs from 'node:fs/promises';
import path from 'node:path';
import {
  MODEL_ID,
  PATHS,
  REASONING_EFFORT
} from './constants.mjs';
import {
  computePerformance,
  openPaperPosition,
  settlePaperPosition
} from './accounting.mjs';
import { YahooMarketData } from './market.mjs';
import { runOmp } from './omp.mjs';
import { decisionPrompt, reflectionPrompt, recentTradeSummaries } from './prompts.mjs';
import { parseJsonText, validateDecision, validateReflection } from './schemas.mjs';
import {
  appendLedger,
  atomicWriteJson,
  atomicWriteText,
  ensureDataLayout,
  loadState,
  readRun,
  sha256,
  withProcessLock,
  writeJournal,
  writeRunArtifact
} from './storage.mjs';
import {
  dateKey,
  decisionWindowStatus,
  isBeforeOrAtFillDeadline,
  isTradingDate,
  nextTradingDate
} from './time.mjs';

const TERMINAL_NO_TRADE = new Set(['NO_TRADE', 'MISSED', 'FAILED']);

function nowIso(clock) {
  return clock().toISOString();
}

function compactError(error) {
  return {
    code: error?.code || 'UNEXPECTED_ERROR',
    message: String(error?.message || error).slice(0, 4_000),
    at: new Date().toISOString()
  };
}

function newRun(marketDate, symbol, clock) {
  const id = `${marketDate}-${symbol || 'NO-TICKER'}-${crypto.randomUUID().slice(0, 8)}`;
  const timestamp = nowIso(clock);
  return {
    schemaVersion: 1,
    id,
    marketDate,
    symbol: symbol || null,
    status: 'PREPARING',
    paperOnly: true,
    modelRequested: MODEL_ID,
    reasoningEffort: REASONING_EFFORT,
    session: null,
    snapshotSha256: null,
    decisionInvocation: null,
    reflectionInvocation: null,
    decision: null,
    failure: null,
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

async function saveRuntime(runtime, clock) {
  runtime.updatedAt = nowIso(clock);
  await atomicWriteJson(PATHS.runtime, runtime);
}

async function saveAccount(account, clock) {
  account.updatedAt = nowIso(clock);
  await atomicWriteJson(PATHS.account, account);
}

async function transition(runtime, run, status, clock, extra = {}) {
  Object.assign(run, extra, { status, updatedAt: nowIso(clock) });
  runtime.runsByMarketDate[run.marketDate] = run;
  await saveRuntime(runtime, clock);
  return run;
}

async function terminalFailure(runtime, run, error, clock, status = 'NO_TRADE') {
  const failure = compactError(error);
  await writeRunArtifact(run.id, 'failure.json', failure).catch(() => {});
  await transition(runtime, run, status, clock, { failure });
  return { ok: false, outcome: 'no_trade', runId: run.id, marketDate: run.marketDate, status, failure };
}

function frozenInput({ marketSnapshot, account, orders, playbook }) {
  return {
    schemaVersion: 1,
    paperOnly: true,
    frozenAt: marketSnapshot.capturedAt,
    marketDate: marketSnapshot.marketDate,
    symbol: marketSnapshot.symbol,
    marketData: marketSnapshot,
    account: {
      experimentId: account.experimentId,
      startingEquity: account.startingEquity,
      equity: account.equity,
      paused: account.paused,
      openPosition: account.openPosition
    },
    recentTrades: recentTradeSummaries(orders),
    deterministicPerformance: computePerformance(orders, account.startingEquity),
    learningPlaybook: playbook
  };
}

function modelMetadata(result, invocationType, clock) {
  return {
    invocationType,
    completedAt: nowIso(clock),
    model: result.model,
    usage: result.usage,
    elapsedMs: result.elapsedMs,
    privateReasoningPersisted: false,
    authenticationPayloadPersisted: false
  };
}

async function persistModelResult(runId, prefix, result, validated, clock) {
  await writeRunArtifact(runId, `${prefix}.json`, validated, { immutable: true });
  await writeRunArtifact(runId, `${prefix}.model.json`, modelMetadata(result, prefix, clock), { immutable: true });
  await writeRunArtifact(runId, `${prefix}.research.json`, {
    allowlistedTool: 'web_search',
    queries: result.research?.queries || [],
    sources: result.research?.sources || []
  }, { immutable: true });
}

async function readArtifact(runId, name) {
  const run = await readRun(runId);
  return run.artifacts[name]?.content;
}

function journalMarkdown(run, order, reflection, failure = null) {
  const money = (value) => Number(value).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
  const header = `# AgentTrader Reflection — ${run.marketDate}

> Paper-only GPT experiment. No real order was placed and no profitability claim is made.

- Run: \`${run.id}\`
- Ticker: **${order.symbol}**
- Signal: **${order.action}** at ${order.allocationPct}% allocation
- Confidence: ${order.confidencePct}%
- Entry / exit: ${money(order.entryPrice)} / ${money(order.exitPrice)} (5 bps adverse each side)
- P&L: **${money(order.pnl)}**
- Equity: ${money(order.equityBefore)} → ${money(order.equityAfter)}
- Frozen input SHA-256: \`${run.snapshotSha256}\`
- Model: \`${MODEL_ID}\`, reasoning \`${REASONING_EFFORT}\`

`;
  if (reflection) return `${header}${reflection.dailyReflectionMarkdown.trim()}\n`;
  return `${header}## Reflection unavailable

The settled paper trade is intact, but the one permitted reflection invocation failed. It was not retried and the prior playbook was preserved.

- Failure code: \`${failure.code}\`
- Failure: ${failure.message}
`;
}

async function ensureJournal(run, order, reflection, failure) {
  const markdown = journalMarkdown(run, order, reflection, failure);
  try {
    return await writeJournal(run.marketDate, markdown);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await fs.readFile(path.join(PATHS.journals, `${run.marketDate}.md`), 'utf8');
    return { filePath: path.join(PATHS.journals, `${run.marketDate}.md`), sha256: sha256(existing), existing: true };
  }
}

async function finishReflection({ state, run, order, reflection, clock }) {
  const journal = await ensureJournal(run, order, reflection, null);
  await atomicWriteText(PATHS.playbook, `${reflection.updatedPlaybookMarkdown.trim()}\n`);
  await transition(state.runtime, run, 'COMPLETE', clock, {
    reflection: {
      verdict: reflection.verdict,
      lessons: reflection.lessons,
      sizingAssessment: reflection.sizingAssessment,
      confidenceAssessment: reflection.confidenceAssessment,
      journalSha256: journal.sha256
    },
    reflectionInvocation: {
      ...run.reflectionInvocation,
      status: 'completed',
      completedAt: nowIso(clock)
    }
  });
  return { ok: true, outcome: 'settled_and_reflected', runId: run.id, order };
}

async function failReflection({ state, run, order, error, clock }) {
  const failure = compactError(error);
  await writeRunArtifact(run.id, 'reflection.failure.json', failure).catch(() => {});
  const journal = await ensureJournal(run, order, null, failure);
  await transition(state.runtime, run, 'REFLECTION_FAILED', clock, {
    reflectionFailure: failure,
    reflectionInvocation: {
      ...run.reflectionInvocation,
      status: 'failed',
      completedAt: nowIso(clock)
    },
    reflection: { journalSha256: journal.sha256 }
  });
  return { ok: true, outcome: 'settled_reflection_failed', runId: run.id, order, failure };
}

async function runReflection({ state, run, order, clock, modelRunner }) {
  const input = await readArtifact(run.id, 'input.snapshot.json');
  if (!input?.marketData) return failReflection({ state, run, order, error: new Error('Frozen input snapshot is unavailable'), clock });
  run.reflectionInvocation = { status: 'started', startedAt: nowIso(clock), model: MODEL_ID, reasoningEffort: REASONING_EFFORT };
  await transition(state.runtime, run, 'REFLECTION_RUNNING', clock);
  try {
    const performance = computePerformance(state.orders, state.account.startingEquity);
    const result = await modelRunner({
      prompt: reflectionPrompt({
        snapshot: input.marketData,
        snapshotSha256: run.snapshotSha256,
        decision: run.decision,
        order,
        playbook: state.playbook,
        orders: state.orders,
        performance
      }),
      tools: ['web_search']
    });
    const reflection = validateReflection(parseJsonText(result.finalText));
    await persistModelResult(run.id, 'reflection', result, reflection, clock);
    return finishReflection({ state, run, order, reflection, clock });
  } catch (error) {
    return failReflection({ state, run, order, error, clock });
  }
}

async function recoverInterrupted(state, clock) {
  let changed = false;
  for (const run of Object.values(state.runtime.runsByMarketDate || {})) {
    if (run.status === 'DECISION_RUNNING') {
      try {
        const decision = validateDecision(await readArtifact(run.id, 'decision.json'));
        const metadata = await readArtifact(run.id, 'decision.model.json');
        if (metadata?.model?.provider !== 'openai-codex' || metadata?.model?.id !== 'gpt-5.6-sol' || metadata?.model?.reasoningEffort !== 'max') {
          throw new Error('Exact model metadata was not durably recorded');
        }
        run.decision = decision;
        run.status = 'DECISION_VALID';
        run.updatedAt = nowIso(clock);
      } catch {
        run.status = 'NO_TRADE';
        run.failure = { code: 'INTERRUPTED_DECISION', message: 'The decision invocation was interrupted or its validated result was not durably recorded; it will not be retried.', at: nowIso(clock) };
        run.updatedAt = nowIso(clock);
      }
      changed = true;
    } else if (run.status === 'REFLECTION_RUNNING') {
      // Reflection recovery is completed later with the settled ledger row.
      changed = true;
    }
  }
  if (changed) await saveRuntime(state.runtime, clock);
}

async function reconcileSettledReflection({ state, clock, modelRunner }) {
  const candidates = Object.values(state.runtime.runsByMarketDate || {})
    .filter((run) => ['OPEN', 'CLOSE_PENDING', 'SETTLED', 'REFLECTION_RUNNING'].includes(run.status))
    .sort((a, b) => b.marketDate.localeCompare(a.marketDate));
  for (const run of candidates) {
    const order = state.orders.find((item) => item.runId === run.id && item.status === 'CLOSED');
    if (!order) continue;
    if (run.status === 'OPEN' || run.status === 'CLOSE_PENDING') {
      state.account.equity = order.equityAfter;
      state.account.openPosition = null;
      if (state.account.equity <= 0) {
        state.account.paused = true;
        state.account.pauseReason = 'Equity reached zero or below. Start a new experiment explicitly to resume.';
      }
      await saveAccount(state.account, clock);
      await transition(state.runtime, run, 'SETTLED', clock, {
        close: {
          observedExitPrice: order.observedExitPrice,
          exitPrice: order.exitPrice,
          exitedAt: order.exitedAt,
          pnl: order.pnl,
          equityAfter: order.equityAfter
        }
      });
    }
    if (run.reflectionInvocation?.status === 'started' || run.status === 'REFLECTION_RUNNING') {
      try {
        const reflection = validateReflection(await readArtifact(run.id, 'reflection.json'));
        return finishReflection({ state, run, order, reflection, clock });
      } catch {
        return failReflection({
          state,
          run,
          order,
          error: Object.assign(new Error('The prior reflection invocation was interrupted and will not be retried.'), { code: 'INTERRUPTED_REFLECTION' }),
          clock
        });
      }
    }
    if (run.status === 'SETTLED') return runReflection({ state, run, order, clock, modelRunner });
  }
  return null;
}

async function settleOpenPosition({ state, clock, market, modelRunner }) {
  const position = state.account.openPosition;
  if (!position) return null;
  const run = state.runtime.runsByMarketDate[position.marketDate];
  if (!run || run.id !== position.runId) {
    throw Object.assign(new Error('Open position does not match its durable run record'), { code: 'STATE_MISMATCH' });
  }
  if (clock().getTime() < position.session.endEpoch * 1000) {
    return { ok: true, outcome: 'close_pending', runId: run.id, closesAt: position.session.end };
  }

  const existingOrder = state.orders.find((order) => order.runId === run.id && order.status === 'CLOSED');
  let order = existingOrder;
  if (!order) {
    let close;
    try {
      close = await market.fetchSessionClose(position.symbol, position.marketDate, position.session);
    } catch (error) {
      run.closeFailure = compactError(error);
      await transition(state.runtime, run, 'CLOSE_PENDING', clock);
      return { ok: false, outcome: 'close_recovery_pending', runId: run.id, failure: run.closeFailure };
    }
    const settled = settlePaperPosition(position, close.observedPrice, close.observedAt);
    order = {
      ledgerVersion: 1,
      id: `paper-${run.id}`,
      runId: run.id,
      experimentId: state.account.experimentId,
      marketDate: position.marketDate,
      paperOnly: true,
      status: 'CLOSED',
      model: { provider: 'openai-codex', id: 'gpt-5.6-sol', reasoningEffort: REASONING_EFFORT },
      snapshotSha256: run.snapshotSha256,
      symbol: position.symbol,
      action: position.action,
      allocationPct: position.allocationPct,
      confidencePct: position.confidencePct,
      thesis: position.thesis,
      evidence: position.evidence,
      risks: position.risks,
      invalidation: position.invalidation,
      lessonsUsed: position.lessonsUsed,
      researchStatus: position.researchStatus,
      observedEntryAt: position.observedEntryAt,
      closeMethod: close.method,
      closeSource: close.source,
      ...settled,
      recordedAt: nowIso(clock)
    };
    await writeRunArtifact(run.id, 'close.json', { close, order }, { immutable: true });
    await appendLedger(order);
    state.orders.push(order);
  }

  state.account.equity = order.equityAfter;
  state.account.openPosition = null;
  state.account.completedTrades = Math.max(state.account.completedTrades || 0, state.orders.filter((item) => item.experimentId === state.account.experimentId && item.status === 'CLOSED').length);
  if (state.account.equity <= 0) {
    state.account.paused = true;
    state.account.pauseReason = 'Equity reached zero or below. Start a new experiment explicitly to resume.';
  }
  await saveAccount(state.account, clock);
  await transition(state.runtime, run, 'SETTLED', clock, {
    close: {
      observedExitPrice: order.observedExitPrice,
      exitPrice: order.exitPrice,
      exitedAt: order.exitedAt,
      pnl: order.pnl,
      equityAfter: order.equityAfter
    }
  });

  if (run.reflectionInvocation?.status === 'completed' || run.status === 'COMPLETE') {
    return { ok: true, outcome: 'already_settled', runId: run.id, order };
  }
  if (run.reflectionInvocation?.status === 'started' || run.status === 'REFLECTION_RUNNING') {
    try {
      const reflection = validateReflection(await readArtifact(run.id, 'reflection.json'));
      return finishReflection({ state, run, order, reflection, clock });
    } catch {
      return failReflection({
        state,
        run,
        order,
        error: Object.assign(new Error('The prior reflection invocation was interrupted and will not be retried.'), { code: 'INTERRUPTED_REFLECTION' }),
        clock
      });
    }
  }
  if (run.status === 'REFLECTION_FAILED') return { ok: true, outcome: 'already_settled_reflection_failed', runId: run.id, order };
  return runReflection({ state, run, order, clock, modelRunner });
}

async function continueDecision({ state, run, clock, market }) {
  if (!isBeforeOrAtFillDeadline(clock())) {
    return terminalFailure(state.runtime, run, Object.assign(new Error('Valid decision completed after the 12:20 p.m. Eastern fill deadline'), { code: 'FILL_DEADLINE_MISSED' }), clock);
  }
  let observed;
  try {
    observed = await market.fetchObservedPrice(run.symbol, clock());
  } catch (error) {
    return terminalFailure(state.runtime, run, error, clock);
  }
  if (!isBeforeOrAtFillDeadline(clock())) {
    return terminalFailure(state.runtime, run, Object.assign(new Error('Fresh entry price arrived after the 12:20 p.m. Eastern fill deadline'), { code: 'FILL_DEADLINE_MISSED' }), clock);
  }
  if (state.account.openPosition) {
    return terminalFailure(state.runtime, run, Object.assign(new Error('A concurrent position already exists'), { code: 'POSITION_CONFLICT' }), clock);
  }
  const base = openPaperPosition({
    action: run.decision.action,
    allocationPct: run.decision.allocationPct,
    equity: state.account.equity,
    observedPrice: observed.observedPrice,
    enteredAt: nowIso(clock),
    symbol: run.symbol
  });
  const position = {
    ...base,
    runId: run.id,
    marketDate: run.marketDate,
    session: run.session,
    observedEntryAt: observed.observedAt,
    confidencePct: run.decision.confidencePct,
    thesis: run.decision.thesis,
    evidence: run.decision.evidence,
    risks: run.decision.risks,
    invalidation: run.decision.invalidation,
    lessonsUsed: run.decision.lessonsUsed,
    researchStatus: run.decision.researchStatus
  };
  state.account.openPosition = position;
  await saveAccount(state.account, clock);
  await writeRunArtifact(run.id, 'entry.json', { observed, position }, { immutable: true });
  await transition(state.runtime, run, 'OPEN', clock, {
    entry: {
      observedPrice: position.observedEntryPrice,
      effectivePrice: position.entryPrice,
      quantity: position.quantity,
      notional: position.notional,
      enteredAt: position.enteredAt
    }
  });
  return { ok: true, outcome: 'paper_position_opened', runId: run.id, position };
}

async function startDecision({ state, run, clock, market, modelRunner }) {
  let marketSnapshot;
  try {
    marketSnapshot = await market.buildSnapshot(run.symbol, clock());
  } catch (error) {
    return terminalFailure(state.runtime, run, error, clock);
  }
  const input = frozenInput({ marketSnapshot, account: state.account, orders: state.orders, playbook: state.playbook });
  const inputArtifact = await writeRunArtifact(run.id, 'input.snapshot.json', input, { immutable: true });
  const inputHash = inputArtifact.sha256;
  await writeRunArtifact(run.id, 'input.snapshot.sha256', `${inputHash}\n`, { immutable: true });
  run.snapshotSha256 = inputHash;
  run.session = marketSnapshot.session;
  await transition(state.runtime, run, 'SNAPSHOT_FROZEN', clock);

  run.decisionInvocation = { status: 'started', startedAt: nowIso(clock), model: MODEL_ID, reasoningEffort: REASONING_EFFORT };
  await transition(state.runtime, run, 'DECISION_RUNNING', clock);
  try {
    const result = await modelRunner({
      prompt: decisionPrompt({
        snapshot: marketSnapshot,
        snapshotSha256: inputHash,
        account: state.account,
        orders: state.orders,
        playbook: state.playbook,
        performance: input.deterministicPerformance
      }),
      tools: ['web_search']
    });
    const decision = validateDecision(parseJsonText(result.finalText));
    await persistModelResult(run.id, 'decision', result, decision, clock);
    run.decision = decision;
    run.decisionInvocation = { ...run.decisionInvocation, status: 'completed', completedAt: nowIso(clock) };
    await transition(state.runtime, run, 'DECISION_VALID', clock);
    return continueDecision({ state, run, clock, market });
  } catch (error) {
    run.decisionInvocation = { ...run.decisionInvocation, status: 'failed', completedAt: nowIso(clock) };
    return terminalFailure(state.runtime, run, error, clock);
  }
}

async function tickUnlocked({ source, clock, market, modelRunner }) {
  await ensureDataLayout();
  const state = await loadState();
  state.runtime.lastTickAt = nowIso(clock);
  state.runtime.lastTickSource = source;
  await recoverInterrupted(state, clock);

  const settlement = await settleOpenPosition({ state, clock, market, modelRunner });
  if (settlement) {
    state.runtime.lastTickResult = settlement;
    await saveRuntime(state.runtime, clock);
    return settlement;
  }

  const reflectionRecovery = await reconcileSettledReflection({ state, clock, modelRunner });
  if (reflectionRecovery) {
    state.runtime.lastTickResult = reflectionRecovery;
    await saveRuntime(state.runtime, clock);
    return reflectionRecovery;
  }

  const today = dateKey(clock());
  const existing = state.runtime.runsByMarketDate[today];
  if (existing) {
    let result;
    if (existing.status === 'DECISION_VALID') result = await continueDecision({ state, run: existing, clock, market });
    else if (TERMINAL_NO_TRADE.has(existing.status)) result = { ok: false, outcome: 'already_no_trade', runId: existing.id, status: existing.status, failure: existing.failure };
    else result = { ok: true, outcome: 'already_processed', runId: existing.id, status: existing.status };
    state.runtime.lastTickResult = result;
    await saveRuntime(state.runtime, clock);
    return result;
  }

  if (state.account.paused || state.account.equity <= 0) {
    const result = { ok: false, outcome: 'paused', reason: state.account.pauseReason || 'Account equity is zero or below' };
    state.runtime.lastTickResult = result;
    await saveRuntime(state.runtime, clock);
    return result;
  }
  if (!state.settings.automationEnabled) {
    const result = { ok: false, outcome: 'automation_paused', reason: 'Enable automation explicitly before a new decision can run' };
    state.runtime.lastTickResult = result;
    await saveRuntime(state.runtime, clock);
    return result;
  }
  if (!state.settings.ticker) {
    const result = { ok: false, outcome: 'ticker_required' };
    state.runtime.lastTickResult = result;
    await saveRuntime(state.runtime, clock);
    return result;
  }
  if (!isTradingDate(today)) {
    const result = { ok: true, outcome: 'market_calendar_closed', marketDate: today };
    state.runtime.lastTickResult = result;
    await saveRuntime(state.runtime, clock);
    return result;
  }
  const window = decisionWindowStatus(clock());
  if (window === 'before') {
    const result = { ok: true, outcome: 'before_decision_window', marketDate: today };
    state.runtime.lastTickResult = result;
    await saveRuntime(state.runtime, clock);
    return result;
  }

  const run = newRun(today, state.settings.ticker, clock);
  state.runtime.runsByMarketDate[today] = run;
  await saveRuntime(state.runtime, clock);
  await writeRunArtifact(run.id, 'run.json', run, { immutable: true }).catch(() => {});
  if (window === 'missed') {
    const result = await terminalFailure(state.runtime, run, Object.assign(new Error('No new decision is allowed after 12:15 p.m. Eastern'), { code: 'DECISION_WINDOW_MISSED' }), clock, 'MISSED');
    state.runtime.lastTickResult = result;
    await saveRuntime(state.runtime, clock);
    return result;
  }
  const result = await startDecision({ state, run, clock, market, modelRunner });
  state.runtime.lastTickResult = result;
  await saveRuntime(state.runtime, clock);
  return result;
}

export async function tick({
  source = 'cli',
  clock = () => new Date(),
  market = new YahooMarketData(),
  modelRunner = runOmp,
  lock = true
} = {}) {
  const action = () => tickUnlocked({ source, clock, market, modelRunner });
  if (!lock) return action();
  try {
    return await withProcessLock(action, { staleAfterMs: 25 * 60 * 1000 });
  } catch (error) {
    if (error.code === 'LOCKED') return { ok: true, outcome: 'ignored_overlap', reason: error.message };
    throw error;
  }
}

export function statusTiming(now = new Date()) {
  const today = dateKey(now);
  const window = decisionWindowStatus(now);
  return {
    marketDate: today,
    isTradingDate: isTradingDate(today),
    decisionWindow: window,
    nextEligibleMarketDate: window === 'missed' || !isTradingDate(today) ? nextTradingDate(today) : today,
    timezone: 'America/New_York',
    decisionWindowLabel: '12:00–12:15 p.m. ET',
    fillDeadlineLabel: '12:20 p.m. ET'
  };
}
