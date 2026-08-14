#!/usr/bin/env node
import { tick } from './engine.mjs';
import { healthCheck } from './health.mjs';
import { runFixtureDryRun } from './fixtures.mjs';
import { installScheduledTask, removeScheduledTask } from './scheduler.mjs';
import { startServer } from './server.mjs';
import { exportBackup } from './storage.mjs';

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const [command = 'help', ...args] = process.argv.slice(2);
  if (command === 'serve') {
    const { url } = await startServer();
    print({ ok: true, paperOnly: true, url, pid: process.pid });
    return;
  }
  if (command === 'tick') return print(await tick({ source: args.includes('--manual') ? 'manual-cli' : 'scheduled-cli' }));
  if (command === 'health') return print(await healthCheck({ liveYahoo: !args.includes('--offline'), liveOmp: args.includes('--live-omp') }));
  if (command === 'dry-run') return print(await runFixtureDryRun());
  if (command === 'install-task') return print(await installScheduledTask());
  if (command === 'remove-task') return print(await removeScheduledTask());
  if (command === 'export') return print(await exportBackup());
  print({
    app: 'AgentTrader v1',
    paperOnly: true,
    usage: [
      'node src/cli.mjs serve',
      'node src/cli.mjs tick',
      'node src/cli.mjs health [--offline] [--live-omp]',
      'node src/cli.mjs dry-run',
      'node src/cli.mjs install-task',
      'node src/cli.mjs remove-task',
      'node src/cli.mjs export'
    ]
  });
}

main().catch((error) => {
  print({ ok: false, code: error.code || 'ERROR', error: error.message });
  process.exitCode = 1;
});
