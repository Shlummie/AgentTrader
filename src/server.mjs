import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { APP_VERSION, HOST, PATHS, PORT, PUBLIC_ROOT, STARTING_EQUITY, defaultAccount } from './constants.mjs';
import { computePerformance } from './accounting.mjs';
import { tick, statusTiming } from './engine.mjs';
import { healthCheck } from './health.mjs';
import { YahooMarketData, normalizeTicker } from './market.mjs';
import { probeOmpExecutable } from './omp.mjs';
import { inspectScheduledTask } from './scheduler.mjs';
import { exportBackup, atomicWriteJson, ensureDataLayout, listJournals, loadState, readRun, withProcessLock } from './storage.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function json(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'"
  });
  response.end(payload);
}

async function requestJson(request) {
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    throw Object.assign(new Error('Mutating requests require application/json'), { statusCode: 415 });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32 * 1024) throw Object.assign(new Error('Request body is too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
    throw Object.assign(new Error('Request body must be valid JSON'), { statusCode: 400 });
  }
}

function validateLoopbackRequest(request) {
  const host = String(request.headers.host || '');
  if (!/^127\.0\.0\.1:\d+$/.test(host)) throw Object.assign(new Error('Loopback Host header required'), { statusCode: 403 });
  const origin = request.headers.origin;
  if (origin && origin !== `http://${host}`) throw Object.assign(new Error('Cross-origin request rejected'), { statusCode: 403 });
}

function assertAllowedObject(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('Request body must be a JSON object'), { statusCode: 400 });
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) throw Object.assign(new Error(`Unknown request field${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`), { statusCode: 400 });
}

function statusForError(error) {
  if (error.statusCode) return error.statusCode;
  if (error.code === 'LOCKED') return 409;
  if (error.code === 'ENOENT') return 404;
  if (['INVALID_TICKER', 'UNSUPPORTED_INSTRUMENT', 'UNSUPPORTED_EXCHANGE', 'INACTIVE_TICKER'].includes(error.code)) return 400;
  if (String(error.code || '').startsWith('YAHOO_')) return 503;
  if (error.message === 'Invalid run id') return 400;
  return 500;
}

function publicSettings(settings, runtime, marketDate) {
  const activeRun = runtime.runsByMarketDate?.[marketDate] || null;
  return {
    ...settings,
    appliesTo: activeRun ? 'next_session' : 'today_if_eligible',
    currentRunTicker: activeRun?.symbol || null
  };
}

async function buildStatus(healthCache) {
  const state = await loadState();
  const timing = statusTiming();
  const todayRun = state.runtime.runsByMarketDate?.[timing.marketDate] || null;
  const openRun = state.account.openPosition ? state.runtime.runsByMarketDate?.[state.account.openPosition.marketDate] : null;
  const latestRun = Object.values(state.runtime.runsByMarketDate || {}).sort((a, b) => b.marketDate.localeCompare(a.marketDate))[0] || null;
  const currentRun = todayRun || openRun || latestRun;
  let cached = healthCache.value;
  if (!cached || Date.now() - healthCache.at > 60_000) {
    const [omp, scheduledTask] = await Promise.all([probeOmpExecutable(), inspectScheduledTask()]);
    cached = { omp, scheduledTask };
    healthCache.value = cached;
    healthCache.at = Date.now();
  }
  return {
    app: { name: 'AgentTrader', version: APP_VERSION, paperOnly: true, profitabilityClaim: false },
    settings: publicSettings(state.settings, state.runtime, timing.marketDate),
    account: state.account,
    timing,
    currentRun,
    lastTick: { at: state.runtime.lastTickAt, source: state.runtime.lastTickSource, result: state.runtime.lastTickResult },
    health: {
      storage: { ok: true },
      model: { ...cached.omp, required: 'openai-codex/gpt-5.6-sol', reasoningEffort: 'max' },
      marketData: todayRun?.failure?.code?.startsWith('YAHOO') || todayRun?.failure?.code === 'STALE_DATA'
        ? { ok: false, failure: todayRun.failure }
        : { ok: true, source: 'Yahoo Finance chart API (unofficial, no SLA)' },
      scheduledTask: cached.scheduledTask
    },
    performance: computePerformance(state.orders, state.account.startingEquity)
  };
}

async function updateSettings(body, market) {
  assertAllowedObject(body, ['ticker', 'automationEnabled', 'startNewExperiment']);
  if (!Object.keys(body).length) throw Object.assign(new Error('At least one settings field is required'), { statusCode: 400 });
  return withProcessLock(async () => {
    const state = await loadState();
    let tickerValidation = null;
    if (Object.hasOwn(body, 'ticker')) {
      const symbol = normalizeTicker(body.ticker);
      tickerValidation = await market.validateTicker(symbol);
      state.settings.ticker = tickerValidation.symbol;
      state.settings.tickerName = tickerValidation.name;
    }
    if (Object.hasOwn(body, 'automationEnabled')) {
      if (typeof body.automationEnabled !== 'boolean') throw Object.assign(new Error('automationEnabled must be true or false'), { statusCode: 400 });
      if (body.automationEnabled && !state.settings.ticker) throw Object.assign(new Error('Save a verified ticker before enabling automation'), { statusCode: 400 });
      if (body.automationEnabled && state.account.paused) throw Object.assign(new Error(state.account.pauseReason || 'Start a new experiment before resuming'), { statusCode: 409 });
      state.settings.automationEnabled = body.automationEnabled;
    }
    if (Object.hasOwn(body, 'startNewExperiment')) {
      if (body.startNewExperiment !== true) throw Object.assign(new Error('startNewExperiment must be explicitly true'), { statusCode: 400 });
      if (state.account.openPosition) throw Object.assign(new Error('Cannot start a new experiment while a paper position is open'), { statusCode: 409 });
      state.account = { ...defaultAccount(), startingEquity: STARTING_EQUITY, equity: STARTING_EQUITY };
      await atomicWriteJson(PATHS.account, state.account);
    }
    state.settings.updatedAt = new Date().toISOString();
    await atomicWriteJson(PATHS.settings, state.settings);
    const timing = statusTiming();
    return {
      settings: publicSettings(state.settings, state.runtime, timing.marketDate),
      tickerValidation,
      account: state.account
    };
  });
}

async function serveStatic(requestPath, response) {
  const requested = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
  const decoded = decodeURIComponent(requested);
  const filePath = path.resolve(PUBLIC_ROOT, decoded);
  if (filePath !== PUBLIC_ROOT && !filePath.startsWith(`${PUBLIC_ROOT}${path.sep}`)) return false;
  try {
    const content = await fs.readFile(filePath);
    response.writeHead(200, {
      'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'content-length': content.length,
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    });
    response.end(content);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EISDIR') return false;
    throw error;
  }
}

export async function startServer({ host = HOST, port = PORT, market = new YahooMarketData() } = {}) {
  if (host !== '127.0.0.1') throw new Error('AgentTrader is intentionally loopback-only');
  await ensureDataLayout();
  const healthCache = { at: 0, value: null };
  let shuttingDown = false;
  let server;
  const handler = async (request, response) => {
    try {
      validateLoopbackRequest(request);
      const url = new URL(request.url, `http://${host}:${port}`);
      if (request.method === 'GET' && url.pathname === '/api/status') return json(response, 200, await buildStatus(healthCache));
      if (request.method === 'GET' && url.pathname === '/api/account') {
        const state = await loadState();
        return json(response, 200, { account: state.account, performance: computePerformance(state.orders, state.account.startingEquity) });
      }
      if (request.method === 'GET' && url.pathname === '/api/orders') {
        const state = await loadState();
        return json(response, 200, { orders: state.orders.slice().reverse(), count: state.orders.length });
      }
      if (request.method === 'GET' && url.pathname === '/api/memory') {
        const state = await loadState();
        return json(response, 200, { playbook: state.playbook, journals: await listJournals() });
      }
      if (request.method === 'GET' && url.pathname === '/api/health') {
        const liveYahoo = url.searchParams.get('liveYahoo') === '1';
        return json(response, 200, await healthCheck({ liveYahoo }));
      }
      if (request.method === 'GET' && url.pathname.startsWith('/api/runs/')) {
        const runId = decodeURIComponent(url.pathname.slice('/api/runs/'.length));
        return json(response, 200, await readRun(runId));
      }
      if (request.method === 'PUT' && url.pathname === '/api/settings') return json(response, 200, await updateSettings(await requestJson(request), market));
      if (request.method === 'POST' && url.pathname === '/api/tick') {
        assertAllowedObject(await requestJson(request), []);
        return json(response, 200, await tick({ source: 'dashboard', market }));
      }
      if (request.method === 'POST' && url.pathname === '/api/export') {
        assertAllowedObject(await requestJson(request), []);
        return json(response, 200, await exportBackup());
      }
      if (request.method === 'POST' && url.pathname === '/api/shutdown') {
        assertAllowedObject(await requestJson(request), []);
        json(response, 200, { ok: true, message: 'Dashboard server is shutting down. Scheduled trading setting is unchanged.' });
        if (!shuttingDown) {
          shuttingDown = true;
          setTimeout(() => server.close(), 50).unref();
        }
        return;
      }
      if (request.method === 'GET' || request.method === 'HEAD') {
        if (await serveStatic(url.pathname, response)) return;
      }
      return json(response, 404, { error: 'Not found' });
    } catch (error) {
      const status = statusForError(error);
      return json(response, status, { error: error.message, code: error.code || 'SERVER_ERROR' });
    }
  };

  server = http.createServer(handler);
  server.keepAliveTimeout = 5_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const boundPort = server.address().port;
  await atomicWriteJson(PATHS.serverPid, { pid: process.pid, host, port: boundPort, startedAt: new Date().toISOString() });
  const cleanup = async () => {
    try {
      const pid = JSON.parse(await fs.readFile(PATHS.serverPid, 'utf8'));
      if (pid.pid === process.pid) await fs.rm(PATHS.serverPid, { force: true });
    } catch {}
  };
  server.on('close', cleanup);
  process.once('SIGINT', () => server.close());
  process.once('SIGTERM', () => server.close());
  return { server, url: `http://${host}:${boundPort}` };
}
