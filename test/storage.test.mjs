import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agenttrader-storage-'));
process.env.AGENTTRADER_DATA_DIR = root;
const storage = await import(`../src/storage.mjs?storage=${Date.now()}`);

test('atomic JSON state keeps a recovery copy and restores it after primary corruption', async () => {
  const file = path.join(root, 'state.json');
  await storage.atomicWriteJson(file, { version: 1, value: 'safe' });
  await storage.atomicWriteJson(file, { version: 2, value: 'newest' });
  await fs.writeFile(file, '{corrupt', 'utf8');
  const recovered = await storage.readJsonRecovered(file);
  assert.deepEqual(recovered, { version: 1, value: 'safe' });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), recovered);
  assert.deepEqual(JSON.parse(await fs.readFile(`${file}.bak`, 'utf8')), recovered);
});

test('corrupt primary and recovery state fail closed instead of resetting equity', async () => {
  const file = path.join(root, 'both-corrupt.json');
  await fs.writeFile(file, '{bad', 'utf8');
  await fs.writeFile(`${file}.bak`, '{also bad', 'utf8');
  await assert.rejects(() => storage.readJsonRecovered(file), (error) => error.code === 'STATE_RECOVERY_FAILED');
});

test('append-only ledger preserves each JSON row', async () => {
  await storage.ensureDataLayout();
  await storage.appendLedger({ id: 'one', status: 'CLOSED' });
  await storage.appendLedger({ id: 'two', status: 'CLOSED' });
  const rows = await storage.readLedger();
  assert.deepEqual(rows.map((row) => row.id), ['one', 'two']);
});
