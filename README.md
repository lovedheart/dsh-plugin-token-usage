# dsh-plugin-token-usage

QwenPaw-style **cross-session token usage statistics** for DSH.

The plugin aggregates the provider-reported token usage of every model call
across *all* persisted sessions (including subagent sessions) into
`(date, provider, model)` buckets and serves them through a single `/usage`
command.

- **Zero runtime dependencies** — only the Cordis `ctx` API and Node 22's
  built-in `node:zlib` (zstd) are used.
- **Durable source of truth** — it reads the session logs under
  `~/.dsh/sessions`, so it works on history that predates the plugin and needs
  no separate bookkeeping at write time.
- **No double counting** — a committed `assistant/message.usage` wins; a step
  that never produced a message (failure) falls back to its last streaming
  `usage` chunk, flushed at `turn/end`. A persisted per-file watermark
  (`{hiSeq, framesIngested}`) makes the incremental scan idempotent across
  restarts and crash-recovery re-encodes.

## Command

```
/usage                 # last 30 days (configurable defaultDays)
/usage 7d              # last 7 days
/usage 7d qwen3.8      # last 7 days, model filter (substring on provider/model)
/usage qwen3.6         # default range, model filter
```

Example output:

```
📊 Token Usage  2026-07-17 → 2026-08-16

Total: 906.9M tokens · 4954 calls
  input 473.3M · output 3.4M · cache read 430.1M

By model:
  sglang/Qwen3.8-27B  —  719.4M tokens · 3320 calls
      in 337.7M · out 2.8M · cacheR 378.9M
  sglang/Qwen3.6-27B  —  187.4M tokens · 1634 calls
      in 135.6M · out 669900 · cacheR 51.2M

By day:
  2026-08-13  42.6M tokens · 481 calls
  2026-08-14  195.7M tokens · 1587 calls
  2026-08-15  380.5M tokens · 1513 calls
  2026-08-16  288.1M tokens · 1373 calls
```

Token units: `1.2M` for >= 1,000,000 (million), `1.5B` for >= 1,000,000,000
(billion), plain integer below (one decimal, trailing `.0` dropped).

## Config

| key | default | description |
|-----|---------|-------------|
| `defaultDays` | `30` | lookback window for a bare `/usage`. |
| `backfillIntervalSec` | `30` | seconds between incremental backfill passes (keeps the state file warm). |
| `sessionsRoot` | `~/.dsh/sessions` | DSH session-log root (empty = auto from `DSH_HOME`). |
| `stateFile` | `~/.dsh/token-usage.json` | aggregated state + watermark. |
| `flushDelayMs` | `5000` | debounce for the state write. |
| `enableCommand` | `true` | register `/usage`. |
| `verbose` | `false` | log backfill progress. |

## Mounting

The plugin is an out-of-tree module mounted through a profile patch (same
pattern as the telegram / thinking-mode plugins). Add an `insert` row to
`~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: token-usage
      name: '/home/lovedheart/Documents/dsh-plugin-token-usage/lib/index.js'
      config:
        defaultDays: 30
        backfillIntervalSec: 30
        enableCommand: true
        verbose: true
```

`commands` is an **optional** dependency (consumed via an optional child
fiber), so the plugin also loads in command-less assemblies — it just stores
without registering the interactive command.

## Layout

- `src/frames.js` — zstd frame scanner (mirrors DSH's `scanZstdFrames`).
- `src/store.js`  — bucket aggregation, dedup, persistence, `summarize`.
- `src/backfill.js` — incremental session-log walk + `listSessionFiles`.
- `src/render.js` — `fmtTokens`, `renderUsageReport`, `parseUsageArgs`.
- `src/index.js`  — plugin entry (`name`/`inject`/`Config`/`apply`).
- `lib/`          — build output (`npm run prepare` copies `src/*.js`).
- `test/`         — `node --test` unit + harness tests.

## Development

```bash
npm install        # installs the cordis peer for the harness test
npm test           # node --test test/*.test.mjs
npm run prepare    # sync lib/ from src/
```
