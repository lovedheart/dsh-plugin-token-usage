/**
 * Unit tests for the usage store: step-level accounting, no-double-count,
 * failure-path fallback, summarize, and persistence round-trip.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenUsageStore, localDateKey } from '../src/store.js';

const T0 = Date.parse('2026-08-01T12:00:00Z');
const T1 = Date.parse('2026-08-02T12:00:00Z');

function storeInTmp() {
  const dir = mkdtempSync(join(tmpdir(), 'tu-test-'));
  return new TokenUsageStore({ filePath: join(dir, 'state.json'), flushDelayMs: 60_000, log: () => {} });
}

test('committed assistant/message.usage lands in the (date, provider, model) bucket', () => {
  const s = storeInTmp();
  s.ingestEvent(
    {
      type: 'assistant/message',
      seq: 5,
      time: T0,
      data: {
        turn: 1,
        step: 1,
        message: { role: 'assistant', source: { kind: 'model', provider: 'provA', model: 'm1' } },
        usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 30 },
      },
    },
    { key: 'sid1', hiSeq: 4 },
  );
  const sum = s.summarize({ start: new Date(T0 - 864e5), end: new Date(T0 + 864e5) });
  assert.equal(sum.total.calls, 1);
  assert.equal(sum.total.input, 100);
  assert.equal(sum.total.output, 40);
  assert.equal(sum.total.cacheRead, 30);
  assert.equal(sum.byModel.size, 1);
  assert.ok(sum.byModel.has('provA|m1'));
});

test('chunk usage followed by committed message is NOT double counted', () => {
  const s = storeInTmp();
  const events = [
    { type: 'assistant/chunk', seq: 1, time: T0, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 40 } } } },
    { type: 'assistant/message', seq: 2, time: T0, data: { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' } }, usage: { inputTokens: 100, outputTokens: 40 } } },
  ];
  for (const e of events) s.ingestEvent(e, { key: 'sid1', hiSeq: e.seq - 1 });
  const sum = s.summarize({ start: new Date(T0 - 864e5), end: new Date(T0 + 864e5) });
  assert.equal(sum.total.calls, 1);
  assert.equal(sum.total.input, 100);
});

test('message without usage falls back to the chunk sample', () => {
  const s = storeInTmp();
  s.ingestEvent({ type: 'assistant/chunk', seq: 1, time: T0, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 55, outputTokens: 7 } } } }, { key: 'sid1', hiSeq: 0 });
  s.ingestEvent({ type: 'assistant/message', seq: 2, time: T0, data: { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' } } } }, { key: 'sid1', hiSeq: 1 });
  const sum = s.summarize({ start: new Date(T0 - 864e5), end: new Date(T0 + 864e5) });
  assert.equal(sum.total.calls, 1);
  assert.equal(sum.total.input, 55);
  assert.equal(sum.total.output, 7);
});

test('chunks of a failed step are committed at turn/end via the request route', () => {
  const s = storeInTmp();
  s.ingestEvent({ type: 'request/header', seq: 0, time: T0, data: { header: { config: { provider: 'provB', model: 'm2' } }, reason: 'initial' } }, { key: 'sid2', hiSeq: -1 });
  s.ingestEvent({ type: 'assistant/chunk', seq: 1, time: T0, data: { turn: 3, step: 1, chunk: { type: 'usage', usage: { inputTokens: 200, outputTokens: 10 } } } }, { key: 'sid2', hiSeq: 0 });
  s.ingestEvent({ type: 'turn/end', seq: 2, time: T0, data: { turn: 3, reason: { kind: 'error' } } }, { key: 'sid2', hiSeq: 1 });
  const sum = s.summarize({ start: new Date(T0 - 864e5), end: new Date(T0 + 864e5) });
  assert.equal(sum.total.calls, 1);
  assert.ok(sum.byModel.has('provB|m2'));
  assert.equal(sum.byModel.get('provB|m2').stats.input, 200);
});

test('hiSeq watermark ignores already-counted events (resume dedup)', () => {
  const s = storeInTmp();
  const ev = { type: 'assistant/message', seq: 5, time: T0, data: { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' } }, usage: { inputTokens: 10, outputTokens: 1 } } };
  s.ingestEvent(ev, { key: 'sid1', hiSeq: 4 });
  s.ingestEvent(ev, { key: 'sid1', hiSeq: 5 }); // replayed — ignored
  s.ingestEvent(ev, { key: 'sid1', hiSeq: 9 }); // below watermark — ignored
  const sum = s.summarize({ start: new Date(T0 - 864e5), end: new Date(T0 + 864e5) });
  assert.equal(sum.total.calls, 1);
});

test('summarize respects the date range and model filter', () => {
  const s = storeInTmp();
  const msg = (time, prov, model) => ({
    type: 'assistant/message', seq: 1, time,
    data: { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model', provider: prov, model } }, usage: { inputTokens: 1, outputTokens: 1 } },
  });
  s.ingestEvent(msg(T0, 'provA', 'alpha'), { key: 'a', hiSeq: 0 });
  s.ingestEvent(msg(T1, 'provB', 'beta'), { key: 'b', hiSeq: 0 });
  // Full range
  let sum = s.summarize({ start: new Date(T0 - 864e5), end: new Date(T1 + 864e5) });
  assert.equal(sum.total.calls, 2);
  assert.equal(sum.byDate.size, 2);
  // Only day 2
  sum = s.summarize({ start: new Date(T1 - 3600e3), end: new Date(T1 + 3600e3) });
  assert.equal(sum.total.calls, 1);
  assert.ok(sum.byModel.has('provB|beta'));
  // Filter
  sum = s.summarize({ start: new Date(T0 - 864e5), end: new Date(T1 + 864e5), modelFilter: 'alpha' });
  assert.equal(sum.total.calls, 1);
  assert.ok(sum.byModel.has('provA|alpha'));
});

test('pending rows are scoped per session', () => {
  const s = storeInTmp();
  s.ingestEvent({ type: 'assistant/chunk', seq: 1, time: T0, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 5, outputTokens: 1 } } } }, { key: 'sidX', hiSeq: 0 });
  s.ingestEvent({ type: 'assistant/chunk', seq: 2, time: T0, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 9, outputTokens: 1 } } } }, { key: 'sidY', hiSeq: 1 });
  // sidX commits its own message; sidY's pending row must stay untouched.
  s.ingestEvent({ type: 'assistant/message', seq: 3, time: T0, data: { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' } } } }, { key: 'sidX', hiSeq: 2 });
  assert.equal(s.pendingChunks.size, 1);
  assert.ok(s.pendingChunks.has('sidY:1:1'));
});

test('state persists and restores buckets + progress', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tu-test-'));
  const filePath = join(dir, 'state.json');
  const s = new TokenUsageStore({ filePath, flushDelayMs: 60_000 });
  s.ingestEvent(
    { type: 'assistant/message', seq: 5, time: T0, data: { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' } }, usage: { inputTokens: 12, outputTokens: 3 } } },
    { key: 'sid1', hiSeq: 4 },
  );
  s.progress['/some/file.zstd'] = { hiSeq: 42, framesIngested: 7 };
  s.flushNow();

  // "Restart": a new store over the SAME state file.
  const s2 = new TokenUsageStore({ filePath, flushDelayMs: 60_000 });
  const n = s2.load();
  assert.equal(n, 1);
  assert.equal(s2.progress['/some/file.zstd'].hiSeq, 42);
  assert.equal(s2.progress['/some/file.zstd'].framesIngested, 7);
  const sum = s2.summarize({ start: new Date(T0 - 864e5), end: new Date(T0 + 864e5) });
  assert.equal(sum.total.calls, 1);
  assert.equal(sum.total.input, 12);
});

test('localDateKey uses the local calendar', () => {
  assert.equal(localDateKey(new Date(Date.UTC(2026, 7, 1, 23, 30))), new Date(Date.UTC(2026, 7, 1, 23, 30)).toLocaleDateString('en-CA'));
});

test('a session route persists across failed turns (single header, many turns)', () => {
  const s = storeInTmp();
  const req = (seq) => ({ type: 'request/header', seq, time: T0, data: { header: { config: { provider: 'provA', model: 'mA' } } } });
  const chunk = (seq, turn) => ({ type: 'assistant/chunk', seq, time: T0, data: { turn, step: 1, chunk: { type: 'usage', usage: { inputTokens: 50, outputTokens: 5 } } } });
  const turnEnd = (seq, turn) => ({ type: 'turn/end', seq, time: T0, data: { turn } });
  s.ingestEvent(req(0), { key: 'S', hiSeq: -1 });
  s.ingestEvent(chunk(1, 1), { key: 'S', hiSeq: 0 });
  s.ingestEvent(turnEnd(2, 1), { key: 'S', hiSeq: 1 });
  s.ingestEvent(chunk(3, 2), { key: 'S', hiSeq: 2 });
  s.ingestEvent(turnEnd(4, 2), { key: 'S', hiSeq: 3 });
  const sum = s.summarize({ start: new Date(T0 - 864e5), end: new Date(T0 + 864e5) });
  assert.equal(sum.total.calls, 2);
  assert.ok(sum.byModel.has('provA|mA'));
  assert.ok(!sum.byModel.has('unknown|unknown'));
  assert.equal(sum.byModel.get('provA|mA').stats.calls, 2);
});

test('the route is NOT dropped while another session still has pending chunks', () => {
  const s = storeInTmp();
  s.ingestEvent({ type: 'request/header', seq: 0, time: T0, data: { header: { config: { provider: 'pA', model: 'mA' } } } }, { key: 'A', hiSeq: -1 });
  s.ingestEvent({ type: 'assistant/chunk', seq: 1, time: T0, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 1 } } } }, { key: 'A', hiSeq: 0 });
  s.ingestEvent({ type: 'request/header', seq: 0, time: T0, data: { header: { config: { provider: 'pB', model: 'mB' } } } }, { key: 'B', hiSeq: -1 });
  s.ingestEvent({ type: 'assistant/chunk', seq: 1, time: T0, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 20, outputTokens: 2 } } } }, { key: 'B', hiSeq: 0 });
  s.ingestEvent({ type: 'turn/end', seq: 2, time: T0, data: { turn: 1 } }, { key: 'A', hiSeq: 1 });
  assert.ok(s.lastRoute.has('A'));
  s.ingestEvent({ type: 'assistant/chunk', seq: 3, time: T0, data: { turn: 2, step: 1, chunk: { type: 'usage', usage: { inputTokens: 30, outputTokens: 3 } } } }, { key: 'A', hiSeq: 2 });
  s.ingestEvent({ type: 'turn/end', seq: 4, time: T0, data: { turn: 2 } }, { key: 'A', hiSeq: 3 });
  const sum = s.summarize({ start: new Date(T0 - 864e5), end: new Date(T0 + 864e5) });
  assert.ok(sum.byModel.has('pA|mA'));
  assert.ok(!sum.byModel.has('unknown|unknown'));
  assert.equal(sum.byModel.get('pA|mA').stats.calls, 2);
});

test('the session route is persisted and restored across a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tu-test-'));
  const filePath = join(dir, 'state.json');
  const s = new TokenUsageStore({ filePath, flushDelayMs: 60_000 });
  s.ingestEvent({ type: 'request/header', seq: 0, time: T0, data: { header: { config: { provider: 'provA', model: 'mA' } } } }, { key: 'S', hiSeq: -1 });
  s.flushNow();
  const s2 = new TokenUsageStore({ filePath, flushDelayMs: 60_000 });
  s2.load();
  assert.ok(s2.lastRoute.has('S'));
  assert.deepEqual(s2.lastRoute.get('S'), { provider: 'provA', model: 'mA' });
  s2.ingestEvent({ type: 'assistant/chunk', seq: 1, time: T0, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 40, outputTokens: 4 } } } }, { key: 'S', hiSeq: 0 });
  s2.ingestEvent({ type: 'turn/end', seq: 2, time: T0, data: { turn: 1 } }, { key: 'S', hiSeq: 1 });
  const sum = s2.summarize({ start: new Date(T0 - 864e5), end: new Date(T0 + 864e5) });
  assert.equal(sum.total.calls, 1);
  assert.ok(sum.byModel.has('provA|mA'));
  assert.ok(!sum.byModel.has('unknown|unknown'));
});

test('session/disposed clears the route and leftover pending rows', () => {
  const s = storeInTmp();
  s.ingestEvent({ type: 'request/header', seq: 0, time: T0, data: { header: { config: { provider: 'p', model: 'm' } } } }, { key: 'D', hiSeq: -1 });
  s.ingestEvent({ type: 'assistant/chunk', seq: 1, time: T0, data: { turn: 1, step: 1, chunk: { type: 'usage', usage: { inputTokens: 5, outputTokens: 1 } } } }, { key: 'D', hiSeq: 0 });
  assert.ok(s.lastRoute.has('D'));
  assert.equal(s.pendingChunks.size, 1);
  s.ingestEvent({ type: 'session/disposed', seq: 2, time: T0, data: {} }, { key: 'D', hiSeq: 1 });
  assert.ok(!s.lastRoute.has('D'));
  assert.equal(s.pendingChunks.size, 0);
});
