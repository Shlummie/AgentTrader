# AgentTrader v1

AgentTrader is a local, **paper-only** experiment that asks the exact OMP-authenticated `openai-codex/gpt-5.6-sol` model at `max` reasoning to choose one intraday long or short position around noon Eastern. It never connects to a broker, never places a real order, and makes no profitability claim.

## What it does

- Starts each explicit experiment at $100,000.
- Trades at most one user-selected active US equity or ETF per market date.
- Permits a new decision only from 12:00:00 through 12:15:00 p.m. `America/New_York`; a valid decision must fill by 12:20:00.
- Interprets `BUY` as an intraday long and `SELL` as an intraday short.
- Lets GPT select an integer allocation from 1% through 100% of current equity, with no leverage or concurrent position.
- Applies five basis points of adverse slippage at entry and exit, uses fractional shares, and reserves the full short notional as margin.
- Closes at Yahoo's reported regular-session end, including early closes. A later tick recovers a missed close from historical data without changing the entry.
- Calls the same Sol-Max model once after settlement to separate decision quality from outcome quality, write an immutable daily journal, and update a bounded playbook.

Yahoo's keyless chart endpoint is used through a replaceable server adapter. It is unofficial and has no SLA. Missing, future-dated, or more-than-five-minute-old midday data produces a durable no-trade failure; AgentTrader never invents a fallback price.

## Requirements

- Windows 10 or later for Scheduled Task installation and the one-click launchers.
- Node.js 22 or newer.
- OMP installed and already authenticated to the `openai-codex` provider through your ChatGPT subscription.
- OMP must resolve `openai-codex/gpt-5.6-sol` with `max` reasoning.

AgentTrader does **not** create, request, copy, display, or store an OpenAI API key or OMP credential. The child OMP process has `OPENAI_API_KEY` removed from its environment to prevent accidental provider substitution. OMP is invoked without sessions, extensions, skills, rules, LSP, PTY, filesystem tools, or shell tools. The only enabled model tool during decision/reflection is `web_search`; the non-trading contract check disables tools entirely.

## Start safely

1. Double-click `Start AgentTrader.cmd`, or run:

   ```powershell
   npm run serve
   ```

2. Open [http://127.0.0.1:4180](http://127.0.0.1:4180).
3. Enter the ticker you want. The server verifies it through Yahoo before saving it.
4. Explicitly enable scheduled decisions.

Automation starts paused on a fresh install so the default cannot choose a ticker for you. If today's run already started, a saved ticker change applies to the next market session because today's run retains its frozen symbol and checksum.

Stopping the dashboard does not change the automation setting or remove the Scheduled Task. Use the dashboard toggle to pause new decisions. Close reconciliation remains active while new decisions are paused.

## Commands

```powershell
npm run serve                  # dashboard on 127.0.0.1:4180
npm run tick                   # one time-gated/recovery state-machine tick
npm run health                 # live Yahoo, OMP executable, storage, and task health
npm run health -- --live-omp   # one non-trading exact-model JSON contract check
npm run dry-run                # deterministic fixture only; no network or model call
npm run task:install           # install/update current-user Windows task
npm run task:remove            # remove only AgentTrader's Windows task
node src/cli.mjs export        # complete JSON backup
npm test                       # deterministic unit and integration suite
```

`npm run dry-run` uses isolated fixture storage and proves one simulated market day creates exactly one decision, one fill, one close, one ledger row, and one reflection. It never invokes Yahoo or OMP. The optional `health --live-omp` check uses fictional data and validates the complete decision JSON shape without creating a trading run.

## Windows schedule

The current-user task is named `AgentTrader-Midday-PaperTrader`. It runs every five minutes on weekdays from 8:55 a.m. through 2:25 p.m. Phoenix local time. That bounded window covers noon Eastern and the regular close in both EST and EDT. All actual eligibility is still calculated in `America/New_York`; the task trigger is not trusted as a market clock.

The installed XML explicitly sets:

- `WakeToRun=false`
- `StartWhenAvailable=false`
- `MultipleInstancesPolicy=IgnoreNew`
- `ExecutionTimeLimit=PT20M`
- `LogonType=InteractiveToken`
- `RunLevel=LeastPrivilege`

It cannot wake the PC. If the PC sleeps through the close, a later scheduled tick reconciles the historical close before considering a new date.

## Durable records

Runtime data is stored under `data/` and is excluded from source control:

- `settings.json`, `account.json`, and `runtime.json`: atomic state with `.bak` recovery copies.
- `orders.jsonl`: append-only, one line per settled paper order.
- `runs/<run-id>/`: immutable frozen input, SHA-256 checksum, validated decision, sanitized allowlisted search evidence, model identity/usage, entry, close, reflection, and failures.
- `memory/journals/<market-date>.md`: immutable daily journals.
- `memory/playbook.md`: current bounded learning playbook.

Raw OMP output, private reasoning, session data, authentication payloads, and full scraped content are not persisted. Only final validated rationale, allowlisted search query/source URLs, usage metadata, and explicit artifacts are retained.

The dashboard's **Export JSON backup** button writes a checksummed complete export under `exports/`.

## Loopback API

The server binds only to `127.0.0.1` and exposes no generic order or brokerage route:

- `GET /api/status`
- `GET /api/account`
- `GET /api/orders`
- `GET /api/memory`
- `GET /api/runs/:id`
- `PUT /api/settings`
- `POST /api/tick`
- `POST /api/export`
- `POST /api/shutdown`

`POST /api/shutdown` stops only the dashboard process. It does not pause scheduled trading.

## Failure behavior

Model timeout, malformed JSON, auth expiry, quota exhaustion, unavailable exact model, or model-identity mismatch produces no trade. AgentTrader never retries that date with a lower model. The invocation-start checkpoint prevents a crash from creating a second signal. The paper ledger's run ID makes close recovery idempotent. If equity reaches zero or below, all future entries pause until **Start a new $100k experiment** is explicitly confirmed; prior runs, orders, and journals remain intact.

News and search results are untrusted evidence only. The model prompt tells GPT to ignore instructions embedded in sources and continue from the frozen market snapshot if research is limited.
