import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agenttrader-server-'));
process.env.AGENTTRADER_DATA_DIR = root;
const { FixtureMarketData } = await import(`../src/fixtures.mjs?server=${Date.now()}`);
const { startServer } = await import(`../src/server.mjs?server=${Date.now()}`);

test('loopback API validates settings, persists reloads, exports, and shuts down only the server', async () => {
  const { server, url } = await startServer({ port: 0, market: new FixtureMarketData() });
  try {
    const home = await fetch(url);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /PAPER ONLY/);

    const initial = await (await fetch(`${url}/api/status`)).json();
    assert.equal(initial.settings.ticker, '');
    assert.equal(initial.settings.automationEnabled, false);

    const invalid = await fetch(`${url}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticker: '../BAD' }) });
    assert.equal(invalid.status, 400);
    const unknown = await fetch(`${url}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ genericOrder: 'BUY' }) });
    assert.equal(unknown.status, 400);
    const formPost = await fetch(`${url}/api/tick`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    assert.equal(formPost.status, 415);

    const saved = await (await fetch(`${url}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticker: 'FIXT', automationEnabled: true }) })).json();
    assert.equal(saved.settings.ticker, 'FIXT');
    assert.equal(saved.settings.automationEnabled, true);

    const reloaded = await (await fetch(`${url}/api/status`)).json();
    assert.equal(reloaded.settings.ticker, 'FIXT');
    assert.equal(reloaded.settings.automationEnabled, true);

    const backup = await (await fetch(`${url}/api/export`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
    assert.match(backup.filePath, /agenttrader-backup/);
    assert.equal((await fs.stat(backup.filePath)).isFile(), true);

    const shutdown = await (await fetch(`${url}/api/shutdown`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
    assert.equal(shutdown.ok, true);
    await new Promise((resolve) => server.once('close', resolve));
    const settings = JSON.parse(await fs.readFile(path.join(root, 'settings.json'), 'utf8'));
    assert.equal(settings.automationEnabled, true);
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
});

test('server refuses any non-loopback bind', async () => {
  await assert.rejects(() => startServer({ host: '0.0.0.0', port: 0, market: new FixtureMarketData() }), /loopback-only/);
});
