import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  DATA_ROOT,
  DEFAULT_PLAYBOOK,
  EXPORT_ROOT,
  MEMORY_ROOT,
  PATHS,
  RUNS_ROOT,
  defaultAccount,
  defaultRuntime,
  defaultSettings
} from './constants.mjs';

export async function ensureDataLayout() {
  await Promise.all([
    fsp.mkdir(DATA_ROOT, { recursive: true }),
    fsp.mkdir(RUNS_ROOT, { recursive: true }),
    fsp.mkdir(MEMORY_ROOT, { recursive: true }),
    fsp.mkdir(PATHS.journals, { recursive: true }),
    fsp.mkdir(EXPORT_ROOT, { recursive: true })
  ]);
  await ensureJson(PATHS.settings, defaultSettings);
  await ensureJson(PATHS.account, defaultAccount);
  await ensureJson(PATHS.runtime, defaultRuntime);
  try {
    await fsp.access(PATHS.playbook);
  } catch {
    await atomicWriteText(PATHS.playbook, DEFAULT_PLAYBOOK);
  }
  try {
    await fsp.access(PATHS.ledger);
  } catch {
    await fsp.writeFile(PATHS.ledger, '', { encoding: 'utf8', flag: 'wx' });
  }
}

async function ensureJson(filePath, factory) {
  try {
    await readJsonRecovered(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await atomicWriteJson(filePath, factory());
  }
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(typeof value === 'string' ? value : canonicalJson(value));
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function syncWrite(filePath, text, flag = 'w') {
  const handle = await fsp.open(filePath, flag, 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function atomicWriteText(filePath, text, { preserveBackup = false } = {}) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const backupPath = `${filePath}.bak`;
  await syncWrite(tempPath, text);
  try {
    if (!preserveBackup) {
      try {
        await fsp.copyFile(filePath, backupPath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    try {
      await fsp.rename(tempPath, filePath);
    } catch (error) {
      if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
      await fsp.rm(filePath, { force: true });
      await fsp.rename(tempPath, filePath);
    }
  } finally {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
  }
}

export async function atomicWriteJson(filePath, value) {
  await atomicWriteText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJsonRecovered(filePath) {
  let primaryError;
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch (error) {
    primaryError = error;
    if (error.code === 'ENOENT') throw error;
  }
  try {
    const recovered = JSON.parse(await fsp.readFile(`${filePath}.bak`, 'utf8'));
    await atomicWriteText(filePath, `${JSON.stringify(recovered, null, 2)}\n`, { preserveBackup: true });
    return recovered;
  } catch (backupError) {
    const error = new Error(`State recovery failed for ${filePath}: primary=${primaryError.message}; backup=${backupError.message}`);
    error.code = 'STATE_RECOVERY_FAILED';
    throw error;
  }
}

export async function loadState() {
  await ensureDataLayout();
  const [settings, account, runtime, playbook, orders] = await Promise.all([
    readJsonRecovered(PATHS.settings),
    readJsonRecovered(PATHS.account),
    readJsonRecovered(PATHS.runtime),
    fsp.readFile(PATHS.playbook, 'utf8'),
    readLedger()
  ]);
  return { settings, account, runtime, playbook, orders };
}

export async function readLedger() {
  try {
    const text = await fsp.readFile(PATHS.ledger, 'utf8');
    return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid ledger JSON at line ${index + 1}: ${error.message}`);
      }
    });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export async function appendLedger(order) {
  await fsp.mkdir(path.dirname(PATHS.ledger), { recursive: true });
  const handle = await fsp.open(PATHS.ledger, 'a', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(order)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function safeRunId(runId) {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(runId)) throw new Error('Invalid run id');
  return runId;
}

export function runDirectory(runId) {
  return path.join(RUNS_ROOT, safeRunId(runId));
}

export async function writeRunArtifact(runId, name, value, { immutable = false } = {}) {
  if (!/^[A-Za-z0-9._-]{1,80}$/.test(name)) throw new Error('Invalid artifact name');
  const directory = runDirectory(runId);
  await fsp.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, name);
  const text = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
  if (immutable) {
    await syncWrite(filePath, text, 'wx');
  } else {
    await atomicWriteText(filePath, text);
  }
  return { filePath, sha256: sha256(text), bytes: Buffer.byteLength(text) };
}

export async function readRun(runId) {
  const directory = runDirectory(runId);
  const names = await fsp.readdir(directory);
  const result = { id: runId, artifacts: {} };
  for (const name of names.sort()) {
    if (name.endsWith('.bak') || name.endsWith('.tmp')) continue;
    const filePath = path.join(directory, name);
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) continue;
    const text = await fsp.readFile(filePath, 'utf8');
    let content = text;
    if (name.endsWith('.json')) {
      try { content = JSON.parse(text); } catch { /* expose exact corrupt artifact as text */ }
    }
    result.artifacts[name] = { sha256: sha256(text), bytes: stat.size, content };
  }
  return result;
}

export async function writeJournal(marketDate, markdown) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(marketDate)) throw new Error('Invalid journal date');
  const filePath = path.join(PATHS.journals, `${marketDate}.md`);
  await syncWrite(filePath, markdown, 'wx');
  return { filePath, sha256: sha256(markdown) };
}

export async function listJournals() {
  await ensureDataLayout();
  const names = (await fsp.readdir(PATHS.journals)).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name)).sort().reverse();
  return Promise.all(names.map(async (name) => ({
    marketDate: name.slice(0, 10),
    markdown: await fsp.readFile(path.join(PATHS.journals, name), 'utf8')
  })));
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export async function acquireProcessLock({ staleAfterMs = 30 * 60 * 1000 } = {}) {
  await fsp.mkdir(DATA_ROOT, { recursive: true });
  const token = crypto.randomUUID();
  const payload = { token, pid: process.pid, acquiredAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fsp.open(PATHS.lock, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(payload)}\n`, 'utf8');
      await handle.sync();
      return {
        payload,
        async release() {
          await handle.close().catch(() => {});
          try {
            const current = JSON.parse(await fsp.readFile(PATHS.lock, 'utf8'));
            if (current.token === token) await fsp.rm(PATHS.lock, { force: true });
          } catch { /* a replaced or already-released lock is not ours */ }
        }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let existing = null;
      try { existing = JSON.parse(await fsp.readFile(PATHS.lock, 'utf8')); } catch {}
      const age = existing?.acquiredAt ? Date.now() - Date.parse(existing.acquiredAt) : Infinity;
      if (existing && isProcessAlive(existing.pid) && age <= staleAfterMs) {
        const busy = new Error(`Another AgentTrader tick is active (PID ${existing.pid})`);
        busy.code = 'LOCKED';
        throw busy;
      }
      await fsp.rm(PATHS.lock, { force: true });
    }
  }
  throw new Error('Unable to acquire AgentTrader lock');
}

export async function withProcessLock(callback, options) {
  const lock = await acquireProcessLock(options);
  try {
    return await callback();
  } finally {
    await lock.release();
  }
}

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export async function exportBackup() {
  const state = await loadState();
  const journals = await listJournals();
  const runIds = [...new Set(Object.values(state.runtime.runsByMarketDate || {}).map((run) => run.id).filter(Boolean))];
  const runs = [];
  for (const runId of runIds) {
    try { runs.push(await readRun(runId)); } catch (error) { runs.push({ id: runId, error: error.message }); }
  }
  const payload = {
    format: 'agenttrader-backup-v1',
    exportedAt: new Date().toISOString(),
    settings: state.settings,
    account: state.account,
    runtime: state.runtime,
    orders: state.orders,
    playbook: state.playbook,
    journals,
    runs
  };
  const filePath = path.join(EXPORT_ROOT, `agenttrader-backup-${timestampSlug()}.json`);
  await atomicWriteJson(filePath, payload);
  const bytes = await fsp.readFile(filePath);
  return { filePath, sha256: sha256(bytes), bytes: bytes.length };
}

export async function fileExists(filePath) {
  return fs.existsSync(filePath);
}
