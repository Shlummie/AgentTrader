# AgentTrader v1 acceptance record

Verified locally on 2026-08-13 America/Phoenix (2026-08-14 UTC). This is point-in-time implementation evidence, not a profitability claim.

## Runtime and deterministic suite

- Node: `v22.20.0`.
- Test suite: **35 passed, 0 failed**.
- Covered DST/EST/EDT conversion, exact noon/fill boundaries, weekends, recurring NYSE holidays, reported early closes, stale bars, long/short arithmetic, five-basis-point adverse fills, fractional sizing, margin reservation, negative equity pause, confidence scoring, drawdown, atomic recovery, request validation, and Scheduled Task XML guardrails.
- Integration fixtures covered malformed JSON, missing research, model timeout/auth/quota/unavailable failures, duplicate ticks, sleep-through-close recovery, reflection failure, exact model identity, disallowed tools, and corrupted state.

## Simulated market-day proof

`npm run dry-run` completed in fixture-only storage with:

- exactly 1 decision invocation;
- exactly 1 paper fill;
- exactly 1 close;
- exactly 1 append-only ledger row;
- exactly 1 reflection and Markdown journal;
- duplicate decision/close ticks suppressed;
- no position left open;
- frozen input file SHA-256 equal to the checksum carried by the run and ledger.

Most recent fixture run ID: `2026-08-10-FIXT-c92cd776`.

## Live provider checks

- OMP executable: `omp/17.3.0`.
- Requested model: `openai-codex/gpt-5.6-sol`.
- OMP-confirmed provider/model: `openai-codex` / `gpt-5.6-sol`.
- OMP-confirmed reasoning effort: `max`.
- The fictional, non-trading full decision contract returned valid `BUY`, integer allocation/confidence, thesis, evidence, risks, invalidation, lessons, and research status fields.
- That contract check ran with all tools disabled. Trading calls are configured with only `web_search` enabled and no session, extensions, skills, rules, LSP, PTY, filesystem, or shell tools.
- No API key was created or stored; the OMP child explicitly removes `OPENAI_API_KEY` and uses the authenticated `openai-codex` provider.

## Live market-data check

Yahoo's unofficial chart endpoint returned HTTP-successful SPY data with 391 one-minute bars:

- latest bar: `2026-08-13T20:00:00.000Z`;
- latest observed price: `777.8800048828125`;
- reported regular session: `2026-08-13T13:30:00.000Z` through `2026-08-13T20:00:00.000Z`;
- exchange timezone: `America/New_York`.

No fallback or generated price path exists.

## Windows Scheduled Task

Installed task: `AgentTrader-Midday-PaperTrader`.

- State: `Ready`.
- Current-user interactive execution, limited/least-privilege run level.
- Interval: `PT5M`; bounded duration: `PT5H30M` from a Phoenix-local 08:55 weekday start.
- `WakeToRun=false`.
- `StartWhenAvailable=false`.
- `MultipleInstancesPolicy=IgnoreNew`.
- `ExecutionTimeLimit=PT20M`.
- Action: Node 22 running `src/cli.mjs tick` in this project.
- A manual task execution completed with Windows result code `0`; production runtime recorded `source=scheduled-cli`, `outcome=automation_paused`, and created zero trading runs.

## Dashboard and lifecycle

Playwright verified a real Chromium-rendered dashboard at desktop and 390-pixel phone widths with zero console errors. Verified interactions included ticker save, reload persistence, pause, resume, still-time-gated manual tick, backup export, equity chart, brokerage ledger, playbook, and journal. Machine-specific screenshots are intentionally excluded from the public source tree.
- One-click start script reached `127.0.0.1:4180`; the stop script shut down only that server and the port stopped listening.
- A production JSON export's reported SHA-256 exactly matched the file hash (`7858dd21d351c8be923e9b322aed03dbc62d1a18acbec11226a39fba8f651f1c`).

## Safe handoff state

- Production ticker: blank, awaiting the user's choice.
- Production automation: paused.
- Production equity: $100,000.
- Production paper orders/runs: 0 / 0.
- Scheduled Task: installed and ready; while automation is paused it performs only safe recovery/status ticks.
