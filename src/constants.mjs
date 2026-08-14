import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DATA_ROOT = path.resolve(process.env.AGENTTRADER_DATA_DIR || path.join(PROJECT_ROOT, 'data'));
export const EXPORT_ROOT = path.resolve(process.env.AGENTTRADER_EXPORT_DIR || path.join(PROJECT_ROOT, 'exports'));
export const PUBLIC_ROOT = path.join(PROJECT_ROOT, 'public');
export const MEMORY_ROOT = path.join(DATA_ROOT, 'memory');
export const RUNS_ROOT = path.join(DATA_ROOT, 'runs');

export const APP_VERSION = '1.0.0';
export const HOST = '127.0.0.1';
export const PORT = Number.parseInt(process.env.AGENTTRADER_PORT || '4180', 10);
export const STARTING_EQUITY = 100_000;
export const SLIPPAGE_BPS = 5;
export const SLIPPAGE_RATE = SLIPPAGE_BPS / 10_000;
export const MAX_BAR_AGE_MS = 5 * 60 * 1000;
export const DECISION_START_MINUTE_ET = 12 * 60;
export const DECISION_END_MINUTE_ET = 12 * 60 + 15;
export const FILL_DEADLINE_MINUTE_ET = 12 * 60 + 20;
export const MODEL_ID = 'openai-codex/gpt-5.6-sol';
export const REASONING_EFFORT = 'max';
export const OMP_TIMEOUT_SECONDS = Number.parseInt(process.env.AGENTTRADER_OMP_TIMEOUT_SECONDS || '720', 10);
export const TASK_NAME = 'AgentTrader-Midday-PaperTrader';

export const PATHS = {
  settings: path.join(DATA_ROOT, 'settings.json'),
  account: path.join(DATA_ROOT, 'account.json'),
  runtime: path.join(DATA_ROOT, 'runtime.json'),
  ledger: path.join(DATA_ROOT, 'orders.jsonl'),
  lock: path.join(DATA_ROOT, 'agenttrader.lock'),
  serverPid: path.join(DATA_ROOT, 'server.pid.json'),
  taskReceipt: path.join(DATA_ROOT, 'scheduled-task.json'),
  playbook: path.join(MEMORY_ROOT, 'playbook.md'),
  journals: path.join(MEMORY_ROOT, 'journals')
};

export const defaultSettings = () => ({
  version: 1,
  ticker: '',
  tickerName: '',
  automationEnabled: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
});

export const defaultAccount = () => ({
  version: 1,
  experimentId: crypto.randomUUID(),
  startingEquity: STARTING_EQUITY,
  equity: STARTING_EQUITY,
  openPosition: null,
  paused: false,
  pauseReason: null,
  completedTrades: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
});

export const defaultRuntime = () => ({
  version: 1,
  runsByMarketDate: {},
  lastTickAt: null,
  lastTickResult: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
});

export const DEFAULT_PLAYBOOK = `# AgentTrader Learning Playbook

This playbook starts empty. It is updated only by the exact configured reflection model after a settled paper trade.

## Durable lessons

- No learned lessons yet.

## Sizing and confidence

- Begin without historical calibration; express uncertainty honestly.
`;
