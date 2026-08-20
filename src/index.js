/**
 * DSH token-usage plugin.
 *
 * QwenPaw-style cross-session token accounting: aggregates every model
 * call's provider-reported usage into (date, provider, model) buckets and
 * serves them through the `/usage` command.
 *
 * Single ingestion path = the persisted session logs under
 * `<DSH_HOME>/sessions` (the durable source of truth). An incremental
 * backfill walks each session's zstd frames, decoding only the frames that
 * were not ingested before; a persisted per-file watermark
 * `{hiSeq, framesIngested}` makes the walk idempotent across restarts, so
 * history is counted exactly once. `/usage` runs a fresh pass first, so the
 * numbers are current to the last flushed turn (the agent loop flushes at
 * turn end).
 *
 * No external dependencies (Node 22 built-in zstd + Cordis ctx API only).
 *
 * @module dsh-plugin-token-usage
 */

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { TokenUsageStore } from './store.js';
import { backfillOnce } from './backfill.js';
import { parseUsageArgs, renderUsageReport } from './render.js';
import { buildPanelPayload, panelResponse } from './web-panel.js';

// ---------------------------------------------------------------------------
// Plugin metadata
// ---------------------------------------------------------------------------

export const name = 'dsh-plugin-token-usage';
// No hard dependencies: `commands` is consumed through an optional child
// fiber (see apply), so the plugin also loads in command-less assemblies.
export const inject = [];

const DEFAULTS = {
  /** Default lookback window for `/usage` with no explicit Nd. */
  defaultDays: 30,
  /** Seconds between incremental backfill passes (keeps the state file warm). */
  backfillIntervalSec: 30,
  /**
   * Root directory holding DSH session logs. Empty = auto: <DSH_HOME>/sessions.
   */
  sessionsRoot: '',
  /** Where the aggregated state JSON is written. Empty = auto: <DSH_HOME>/token-usage.json */
  stateFile: '',
  /** Flush debounce for the state file, ms. */
  flushDelayMs: 5000,
  /** Register the /usage command. */
  enableCommand: true,
  /**
   * Register the Web GUI panel's data endpoint (GET <panelPath>). The panel
   * itself is a client-side settings section (see src/client + cordis.patch.yml).
   */
  enablePanel: true,
  /** Data endpoint path served by the host's webServer. */
  panelPath: '/api/token-usage',
  verbose: false,
};

export const Config = {
  '~standard': {
    validate: (raw) => {
      const cfg = raw ?? {};
      if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) {
        throw new Error('Plugin config must be an object');
      }
      const schema = {
        defaultDays: ['number'],
        backfillIntervalSec: ['number'],
        sessionsRoot: ['string'],
        stateFile: ['string'],
        flushDelayMs: ['number'],
        enableCommand: ['boolean'],
        enablePanel: ['boolean'],
        panelPath: ['string'],
        verbose: ['boolean'],
      };
      const errors = [];
      for (const [key, expected] of Object.entries(schema)) {
        if (key in cfg && !expected.includes(typeof cfg[key])) {
          errors.push(`config.${key}: expected ${expected.join('|')}, got ${typeof cfg[key]}`);
        }
      }
      if (errors.length) throw new Error(`Invalid plugin config:\n  - ${errors.join('\n  - ')}`);
      // Cordis's standard-schema contract: resolveConfig reads result.value
      // (and result.issues). Return the envelope, not the bare config.
      return { value: cfg };
    },
  },
};

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export async function apply(ctx, rawConfig) {
  const c = { ...DEFAULTS, ...(rawConfig ?? {}) };
  const log = (level, msg) => (ctx.logger?.[level] ? ctx.logger[level](msg) : console[level === 'warn' ? 'warn' : 'log'](msg));
  const vlog = (msg) => c.verbose && log('info', msg);

  const dshHome =
    process.env.DSH_HOME || join(process.env.HOME || process.env.USERPROFILE || '', '.dsh');
  const sessionsRoot = c.sessionsRoot || join(dshHome, 'sessions');
  const stateFile = c.stateFile || join(dshHome, 'token-usage.json');

  // -- Store ----------------------------------------------------------------
  const store = new TokenUsageStore({
    filePath: stateFile,
    flushDelayMs: c.flushDelayMs,
    log,
  });
  // Restores both the aggregate buckets AND the per-file backfill watermark
  // (so a restart never double-counts).
  const restored = store.load();
  vlog(`token-usage: store ready at ${stateFile} (restored ${restored} model buckets)`);

  // -- Backfill ----------------------------------------------------------------
  // file path -> { hiSeq, framesIngested }; persisted with the store so the
  // incremental walk resumes exactly where it left off after a restart.
  const pass = () => {
    try {
      const r = backfillOnce({ store, root: sessionsRoot, log: vlog });
      if (r.ingested > 0 || r.errors > 0) {
        vlog(
          `token-usage: backfill scanned=${r.scanned} ingested=${r.ingested} skipped=${r.skipped} errors=${r.errors}`,
        );
      }
      return r;
    } catch (err) {
      log('warn', `token-usage: backfill pass failed: ${err.message}`);
      return null;
    }
  };

  let timer = null;
  const intervalSec = Math.max(5, c.backfillIntervalSec);
  if (exists(sessionsRoot)) {
    setTimeout(pass, 500); // first pass shortly after boot
    timer = setInterval(pass, intervalSec * 1000);
    if (timer.unref) timer.unref();
  }

  // -- /usage command ----------------------------------------------------------
  // `commands` is optional: the same optional-child-fiber idiom dsh-token-meter
  // uses for `sessionProjections`. In a command-less assembly the callback
  // never runs and the plugin simply stores + serves nothing interactive.
  if (c.enableCommand) {
    ctx.inject(['commands'], (commandsCtx) => {
      const days = Math.max(1, Math.min(3650, Number(c.defaultDays) || 30));
      commandsCtx.commands.register({
        name: 'usage',
        description: `Show token usage across sessions (default: last ${days} days). /usage [Nd] [model]`,
        recordInput: true,
        handler: async ({ rawInput }) => {
          // Fresh pass so the numbers reflect the last flushed turn.
          pass();
          const args = parseUsageArgs(rawInput);
          if (args.error) return { kind: 'error', text: args.error };
          const end = new Date();
          const start = new Date(end.getTime() - (args.days ?? days) * 86_400_000);
          const summary = store.summarize({ start, end, modelFilter: args.modelFilter });
          return { kind: 'success', text: renderUsageReport({ summary }) };
        },
      });
      vlog('token-usage: /usage command registered');
    });
  }

  // -- Web GUI panel data endpoint --------------------------------------------
  // The Web panel (client bundle, settings section "Token 用量") fetches
  // aggregate data from this exact path. `webServer` is an optional service:
  // in non-web assemblies the optional inject never runs and the plugin
  // keeps working command-only. A route registration failure (e.g. path
  // collision with another plugin) degrades to command-only, logged.
  if (c.enablePanel) {
    const path = c.panelPath || '/api/token-usage';
    try {
      await ctx.inject(['webServer'], async (webCtx) => {
        webCtx.webServer.register({
          kind: 'exact',
          path,
          handler: (_req, res) => {
            try {
              // Fresh pass so the numbers reflect the last flushed turn,
              // same as the /usage command.
              pass();
              const r = panelResponse(buildPanelPayload(store));
              res.writeHead(r.status, r.headers);
              res.end(r.body);
            } catch (err) {
              log('warn', `token-usage: panel response failed: ${err.message}`);
              try {
                res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: 'token-usage: internal error' }));
              } catch { /* socket already gone */ }
            }
          },
        });
        vlog(`token-usage: panel data endpoint registered at ${path}`);
      });
    } catch (err) {
      log('warn', `token-usage: panel endpoint not registered (${err.message}); /usage still works`);
    }
  }

  // -- Teardown ----------------------------------------------------------------
  ctx.effect(() => () => {
    if (timer) clearInterval(timer);
    store.dispose();
    log('info', 'token-usage: plugin unloaded, state flushed.');
  });
}

function exists(p) {
  try {
    mkdirSync(p, { recursive: true });
    return true;
  } catch {
    return false;
  }
}
