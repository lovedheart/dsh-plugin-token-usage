/**
 * Cross-session token-usage aggregation store.
 *
 * Records one usage row per (date, provider, model) bucket. The unit of
 * accounting is one model step (turn, step): the committed
 * `assistant/message.usage` wins; a step whose request never produced a
 * message (failure) falls back to its last streaming `usage` chunk, flushed
 * at `turn/end` — the same no-double-count rule `@deepseek-ai/dsh-token-meter`
 * applies.
 *
 * The store also owns the backfill progress map (session file ->
 * `{hiSeq, framesIngested}`), persisted in the same atomic write as the
 * buckets, so an incremental scan is idempotent across restarts and a crash
 * can never double-count.
 *
 * @module dsh-plugin-token-usage/store
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** @typedef {{input:number, output:number, cacheRead:number, cacheWrite:number, reasoning:number, calls:number}} BucketStats */

const EMPTY_STATS = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0 });

export class TokenUsageStore {
  /**
   * @param {object} opts
   * @param {string} opts.filePath - where the aggregated state is persisted
   * @param {number} [opts.flushDelayMs] - debounce window for the state write
   * @param {number} [opts.retentionDays] - drop buckets older than this (default 365)
   * @param {(level:string, msg:string)=>void} [opts.log]
   */
  constructor({ filePath, flushDelayMs = 5000, retentionDays = 365, log = () => {} }) {
    this.filePath = filePath;
    this.flushDelayMs = flushDelayMs;
    this.retentionDays = retentionDays;
    this.log = log;
    /** @type {Map<string, Map<string, BucketStats>>} date -> "provider|model" -> stats */
    this.buckets = new Map();
    /**
     * Backfill progress: session transcript path -> { hiSeq, framesIngested? }.
     * Persisted with the buckets so scans resume exactly after a restart.
     * @type {Record<string, {hiSeq:number, framesIngested?:number}>}
     */
    this.progress = {};
    this.flushTimer = null;
    /** @type {Map<string, {usage:object}>} global pending usage chunks keyed "sid:turn:step" */
    this.pendingChunks = new Map();
    /** @type {Map<string, {provider:string, model:string}>} last request/header route per session */
    this.lastRoute = new Map();
  }

  // ------------------------------------------------------------------
  // Ingestion
  // ------------------------------------------------------------------

  /**
   * Feed one committed session event into the store.
   *
   * @param {object} event - a SessionEvent-shaped object {type, seq, time, data}
   * @param {object} opts
   * @param {string} opts.key - session id (pending-row scope)
   * @param {number} [opts.hiSeq] - events with seq <= hiSeq are ignored
   *   (the backfill passes the watermark it is about to advance).
   */
  ingestEvent(event, { key, hiSeq = -1 }) {
    if (!event || typeof event !== 'object' || typeof event.seq !== 'number' || !key) return;
    if (event.seq <= hiSeq) return;
    switch (event.type) {
      case 'request/header': {
        // Event data is { header: EpochHeader, reason }; the route sits in
        // EpochHeader.config (LlmCallConfig: provider, model, ...).
        const cfg = event.data?.header?.config;
        if (cfg && typeof cfg.provider === 'string' && typeof cfg.model === 'string') {
          this.lastRoute.set(key, { provider: cfg.provider, model: cfg.model });
        }
        break;
      }
      case 'assistant/chunk': {
        const d = event.data;
        if (d && d.chunk && d.chunk.type === 'usage' && d.chunk.usage) {
          this.pendingChunks.set(`${key}:${d.turn}:${d.step}`, d.chunk.usage);
        }
        break;
      }
      case 'assistant/message': {
        const d = event.data;
        if (!d || !d.message) break;
        const committed = d.usage;
        const fallback = this.takePending(key, d.turn, d.step);
        // The committed usage wins; the chunk sample is replaced, not summed.
        const usage = committed && hasTokens(committed) ? committed : fallback;
        if (usage && hasTokens(usage)) {
          const src = d.message.source || {};
          this.add(event.time, src.provider ?? 'unknown', src.model ?? 'unknown', usage);
        }
        break;
      }
      case 'session/disposed': {
        // The session is done for good: drop its route and any leftover
        // pending rows so the in-memory maps stay bounded over long-running
        // processes. (Persisted state is flushed at the caller's discretion.)
        this.lastRoute.delete(key);
        for (const k of [...this.pendingChunks.keys()]) {
          if (k.startsWith(`${key}:`)) this.pendingChunks.delete(k);
        }
        break;
      }
      case 'turn/end': {
        // Failure path: usage chunks that never reached an assistant message
        // still billed the provider — commit them at the turn boundary.
        //
        // The route is intentionally NOT deleted here. Real session logs emit a
        // single request/header that spans many turns, so the session's
        // provider/model route stays valid across turns: a later failed turn
        // must still be attributed to the session's real model, not
        // "unknown". (Deleting it on the first flushed turn/end also leaked the
        // route whenever another session still had pending chunks, because the
        // old check used the global pending.size.) lastRoute is pruned on
        // session/disposed and persisted/restored across a restart, so a failed
        // turn in a resumed session's new tail still attributes correctly.
        const route = this.lastRoute.get(key) ?? { provider: 'unknown', model: 'unknown' };
        const pending = this.pendingChunks;
        for (const [k, usage] of [...pending]) {
          if (k.startsWith(`${key}:`) && hasTokens(usage)) {
            this.add(event.time, route.provider, route.model, usage);
            pending.delete(k);
          }
        }
        break;
      }
    }
  }

  /**
   * Ingest one decoded session log in seq order. `sessionId` must be set on
   * every event; `hiSeq` is the watermark to advance past.
   *
   * @param {ReadonlyArray<object>} events
   * @param {object} opts
   * @param {number} [opts.hiSeq] - seqs at or below this are ignored
   * @returns {number} highest seq seen
   */
  ingestLog(events, { hiSeq = -1 } = {}) {
    let hi = hiSeq;
    for (const event of events) {
      this.ingestEvent(event, { key: event.sessionId, hiSeq: hi });
      if (typeof event.seq === 'number' && event.seq > hi) hi = event.seq;
    }
    return hi;
  }

  takePending(key, turn, step) {
    const pending = this.pendingChunks;
    if (!pending) return undefined;
    const k = `${key}:${turn}:${step}`;
    const usage = pending.get(k);
    if (usage !== undefined) pending.delete(k);
    return usage;
  }

  /**
   * Add one usage sample to its (date, provider, model) bucket.
   * @param {number} timeMs - Unix ms of the producing event (local date)
   */
  add(timeMs, provider, model, usage) {
    const dateKey = localDateKey(new Date(timeMs));
    const modelKey = `${provider}|${model}`;
    let byModel = this.buckets.get(dateKey);
    if (!byModel) {
      byModel = new Map();
      this.buckets.set(dateKey, byModel);
    }
    let stats = byModel.get(modelKey);
    if (!stats) {
      stats = EMPTY_STATS();
      byModel.set(modelKey, stats);
    }
    stats.input += num(usage.inputTokens);
    stats.output += num(usage.outputTokens);
    stats.cacheRead += num(usage.cacheReadTokens);
    stats.cacheWrite += num(usage.cacheWriteTokens);
    stats.reasoning += num(usage.reasoningTokens);
    stats.calls += 1;
    this.scheduleFlush();
  }

  // ------------------------------------------------------------------
  // Queries
  // ------------------------------------------------------------------

  /**
   * Build a QwenPaw-shaped summary over [start, end] (local dates,
   * inclusive, ISO YYYY-MM-DD).
   *
   * @param {object} opts
   * @param {Date} opts.start
   * @param {Date} opts.end
   * @param {string} [opts.modelFilter] - case-insensitive substring on "provider/model"
   */
  summarize({ start, end, modelFilter }) {
    const startKey = localDateKey(start);
    const endKey = localDateKey(end);
    const total = EMPTY_STATS();
    /** @type {Map<string, {provider:string, model:string, stats:BucketStats}>} */
    const byModel = new Map();
    /** @type {Map<string, BucketStats>} */
    const byDate = new Map();
    for (const [dateKey, models] of this.buckets) {
      if (dateKey < startKey || dateKey > endKey) continue;
      let dayStats = byDate.get(dateKey);
      for (const [modelKey, stats] of models) {
        const [provider, ...rest] = modelKey.split('|');
        const model = rest.join('|');
        const label = `${provider}/${model}`;
        if (modelFilter && !label.toLowerCase().includes(modelFilter.toLowerCase())) continue;
        if (!dayStats) {
          dayStats = EMPTY_STATS();
          byDate.set(dateKey, dayStats);
        }
        accumulate(total, stats);
        accumulate(dayStats, stats);
        const entry = byModel.get(modelKey) ?? { provider, model, stats: EMPTY_STATS() };
        accumulate(entry.stats, stats);
        byModel.set(modelKey, entry);
      }
    }
    return { startKey, endKey, total, byModel, byDate };
  }

  /** @returns {number} number of distinct date buckets (any range) */
  dateCount() {
    return this.buckets.size;
  }

  // ------------------------------------------------------------------
  // Persistence
  // ------------------------------------------------------------------

  /** @returns {number} number of model buckets restored */
  load() {
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return 0;
      let n = 0;
      if (parsed.buckets && typeof parsed.buckets === 'object') {
        for (const [dateKey, models] of Object.entries(parsed.buckets)) {
          if (typeof models !== 'object' || models === null) continue;
          const byModel = new Map();
          for (const [modelKey, stats] of Object.entries(models)) {
            const s = EMPTY_STATS();
            s.input = num(stats?.input);
            s.output = num(stats?.output);
            s.cacheRead = num(stats?.cacheRead);
            s.cacheWrite = num(stats?.cacheWrite);
            s.reasoning = num(stats?.reasoning);
            s.calls = num(stats?.calls);
            byModel.set(modelKey, s);
            n += 1;
          }
          this.buckets.set(dateKey, byModel);
        }
      }
      if (parsed.progress && typeof parsed.progress === 'object') {
        for (const [file, mark] of Object.entries(parsed.progress)) {
          if (mark && typeof mark.hiSeq === 'number') {
            this.progress[file] = {
              hiSeq: mark.hiSeq,
              framesIngested: typeof mark.framesIngested === 'number' ? mark.framesIngested : 0,
            };
          }
        }
      }
      if (parsed.routes && typeof parsed.routes === 'object') {
        for (const [sid, route] of Object.entries(parsed.routes)) {
          if (route && typeof route.provider === 'string' && typeof route.model === 'string') {
            this.lastRoute.set(sid, { provider: route.provider, model: route.model });
          }
        }
      }
      return n;
    } catch (err) {
      if (err && err.code === 'ENOENT') return 0;
      this.log('warn', `token-usage: failed to load ${this.filePath}: ${err.message}`);
      return 0;
    }
  }

  flushNow() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      this.prune();
      const buckets = {};
      for (const [dateKey, models] of this.buckets) {
        buckets[dateKey] = {};
        for (const [modelKey, stats] of models) buckets[dateKey][modelKey] = { ...stats };
      }
      const routes = {};
      for (const [sid, route] of this.lastRoute) routes[sid] = route;
      const payload = JSON.stringify(
        { version: 1, updatedAt: Date.now(), buckets, progress: this.progress, routes },
        null,
        2,
      );
      const dir = dirname(this.filePath);
      mkdirSync(dir, { recursive: true });
      const tmp = `${this.filePath}.${process.pid}.tmp`;
      writeFileSync(tmp, payload, 'utf8');
      renameSync(tmp, this.filePath);
    } catch (err) {
      this.log('warn', `token-usage: flush failed: ${err.message}`);
    }
  }

  /** Drop date buckets older than the retention window (keeps the state file bounded). */
  prune() {
    if (!(this.retentionDays > 0)) return;
    const cutoff = localDateKey(new Date(Date.now() - this.retentionDays * 86_400_000));
    for (const dateKey of [...this.buckets.keys()]) {
      if (dateKey < cutoff) this.buckets.delete(dateKey);
    }
  }

  scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushNow();
    }, this.flushDelayMs);
    if (typeof this.flushTimer.unref === 'function') this.flushTimer.unref();
  }

  dispose() {
    this.flushNow();
    this.buckets.clear();
    this.progress = {};
    this.pendingChunks.clear();
    this.lastRoute.clear();
  }
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function hasTokens(u) {
  return (
    num(u.inputTokens) > 0 ||
    num(u.outputTokens) > 0 ||
    num(u.cacheReadTokens) > 0 ||
    num(u.cacheWriteTokens) > 0
  );
}

function accumulate(dst, src) {
  dst.input += src.input;
  dst.output += src.output;
  dst.cacheRead += src.cacheRead;
  dst.cacheWrite += src.cacheWrite;
  dst.reasoning += src.reasoning;
  dst.calls += src.calls;
}

/** Local-calendar date key YYYY-MM-DD for a Date. */
export function localDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
