/**
 * Backfill tests: incremental frame walk, watermark idempotency, crash
 * recovery re-encode, and raw .jsonl files.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { TokenUsageStore } from '../src/store.js';
import { backfillOnce, listSessionFiles } from '../src/backfill.js';
import { splitZstdFrames } from '../src/frames.js';

const T0 = Date.parse('2026-08-03T12:00:00Z');

function sessionLines(header, events) {
  return [
    JSON.stringify({ type: 'session', version: 0, id: header, delegationDepth: 0, createdAt: T0 }),
    ...events.map((e) => JSON.stringify(e)),
  ];
}

function writeZstdSession(root, project, sessionId, events) {
  const dir = join(root, project, sessionId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'session.jsonl.zstd');
  const header = sessionLines(sessionId, []).join('\n');
  // One frame per "batch": header, then the events in two batches.
  const half = Math.ceil(events.length / 2);
  const frames = [
    zstdCompressSync(header + '\n'),
    zstdCompressSync(events.slice(0, half).map((e) => JSON.stringify(e)).join('\n') + '\n'),
    zstdCompressSync(events.slice(half).map((e) => JSON.stringify(e)).join('\n') + '\n'),
  ];
  writeFileSync(file, Buffer.concat(frames));
  return file;
}

function msgEvents(sessionId, n) {
  // n assistant/message steps, each with usage; plus a matching chunk so the
  // fallback path is exercised for none of them.
  const events = [];
  for (let i = 1; i <= n; i++) {
    events.push({ type: 'step/start', seq: events.length, time: T0 + i, data: { turn: i, step: 1 } });
    events.push({
      type: 'assistant/chunk', seq: events.length, time: T0 + i,
      data: { turn: i, step: 1, chunk: { type: 'usage', usage: { inputTokens: 10 * i, outputTokens: i } } },
    });
    events.push({
      type: 'assistant/message', seq: events.length, time: T0 + i,
      data: {
        turn: i, step: 1,
        message: { role: 'assistant', source: { kind: 'model', provider: 'provA', model: 'model-x' } },
        usage: { inputTokens: 10 * i, outputTokens: i },
      },
    });
    events.push({ type: 'step/end', seq: events.length, time: T0 + i, data: { turn: i, step: 1 } });
    events.push({ type: 'turn/end', seq: events.length, time: T0 + i, data: { turn: i, reason: { kind: 'idle' } } });
  }
  return events;
}

test('backfill counts every usage event in a zstd session exactly once', () => {
  const root = mkdtempSync(join(tmpdir(), 'tu-root-'));
  const events = msgEvents('s1', 4);
  writeZstdSession(root, '--proj--', 's1', events);

  const store = new TokenUsageStore({ filePath: join(root, 'state.json'), flushDelayMs: 60_000 });
  const r1 = backfillOnce({ store, root });
  assert.equal(r1.ingested, events.length, 'first pass ingests every event');
  // chunk + message pair per step: committed usage wins, no double count.
  let sum = store.summarize({ start: new Date(T0 - 864e5), end: new Date(T0 + 864e5) });
  assert.equal(sum.total.calls, 4);
  assert.equal(sum.total.input, 10 * (1 + 2 + 3 + 4));

  // Second pass: nothing new (only the tiny header frame is re-decoded;
  // watermarked frames are never touched).
  const r2 = backfillOnce({ store, root });
  assert.equal(r2.ingested, 0, 'second pass ingests nothing');
  sum = store.summarize({ start: new Date(T0 - 864e5), end: new Date(T0 + 864e5) });
  assert.equal(sum.total.calls, 4, 'no double count after second pass');
  rmSync(root, { recursive: true, force: true });
});

test('a new append batch is picked up incrementally', () => {
  const root = mkdtempSync(join(tmpdir(), 'tu-root-'));
  const dir = join(root, '--proj--', 's1');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'session.jsonl.zstd');
  const header = sessionLines('s1', []).join('\n');
  const ev1 = { type: 'assistant/message', seq: 1, time: T0, data: { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' } }, usage: { inputTokens: 5, outputTokens: 1 } } };
  writeFileSync(file, Buffer.concat([zstdCompressSync(header + '\n'), zstdCompressSync(JSON.stringify(ev1) + '\n')]));

  const store = new TokenUsageStore({ filePath: join(root, 'state.json'), flushDelayMs: 60_000 });
  let r = backfillOnce({ store, root });
  assert.equal(r.ingested, 1);
  assert.equal(store.summarize({ start: new Date(T0 - 864e5), end: new Date(T0 + 864e5) }).total.calls, 1);

  // Append one more batch frame.
  const buf = readFileSync(file);
  const ev2 = { type: 'assistant/message', seq: 2, time: T0 + 1000, data: { turn: 2, step: 1, message: { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' } }, usage: { inputTokens: 7, outputTokens: 2 } } };
  writeFileSync(file, Buffer.concat([buf, zstdCompressSync(JSON.stringify(ev2) + '\n')]));

  r = backfillOnce({ store, root });
  assert.equal(r.ingested, 1, 'only the new frame is decoded');
  const sum = store.summarize({ start: new Date(T0 - 864e5), end: new Date(T0 + 864e5) });
  assert.equal(sum.total.calls, 2);
  assert.equal(sum.total.input, 12);
  rmSync(root, { recursive: true, force: true });
});

test('restarting the store (fresh watermark) does not double count', () => {
  const root = mkdtempSync(join(tmpdir(), 'tu-root-'));
  const events = msgEvents('s1', 3);
  writeZstdSession(root, '--proj--', 's1', events);
  const stateFile = join(root, 'state.json');

  const store = new TokenUsageStore({ filePath: stateFile, flushDelayMs: 60_000 });
  backfillOnce({ store, root });
  store.flushNow();

  // "Restart": a new store over the same state file + same logs.
  const store2 = new TokenUsageStore({ filePath: stateFile, flushDelayMs: 60_000 });
  store2.load();
  const r = backfillOnce({ store, root: root }); // (store kept for watermark)
  const r2 = backfillOnce({ store: store2, root });
  assert.equal(r2.ingested, 0, 'restarted store ingests nothing new');
  const sum = store2.summarize({ start: new Date(T0 - 864e5), end: new Date(T0 + 864e5) });
  assert.equal(sum.total.calls, 3, 'aggregate unchanged after restart');
  rmSync(root, { recursive: true, force: true });
});

test('crash-recovery re-encode (frame shrink) re-walks without double count', () => {
  const root = mkdtempSync(join(tmpdir(), 'tu-root-'));
  const dir = join(root, '--proj--', 's1');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'session.jsonl.zstd');
  const header = sessionLines('s1', []).join('\n');
  const ev = { type: 'assistant/message', seq: 1, time: T0, data: { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' } }, usage: { inputTokens: 4, outputTokens: 1 } } };
  const body = JSON.stringify(ev) + '\n';
  // First layout: two frames (header + batch).
  writeFileSync(file, Buffer.concat([zstdCompressSync(header + '\n'), zstdCompressSync(body)]));
  const store = new TokenUsageStore({ filePath: join(root, 'state.json'), flushDelayMs: 60_000 });
  backfillOnce({ store, root });
  assert.equal(store.summarize({ start: new Date(T0 - 864e5), end: new Date(T0 + 864e5) }).total.calls, 1);

  // Recovery re-encodes as ONE frame containing header+body (frame count 2 -> 1).
  writeFileSync(file, zstdCompressSync(header + '\n' + body));
  const r = backfillOnce({ store, root });
  const sum = store.summarize({ start: new Date(T0 - 864e5), end: new Date(T0 + 864e5) });
  assert.equal(sum.total.calls, 1, 're-encoded prefix not double counted');
  assert.equal(r.ingested, 0, 'all rows below the watermark are skipped');
  rmSync(root, { recursive: true, force: true });
});

test('raw .jsonl session files are backfilled by hiSeq only', () => {
  const root = mkdtempSync(join(tmpdir(), 'tu-root-'));
  const dir = join(root, '--proj--', 's2');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'session.jsonl');
  const ev = { type: 'assistant/message', seq: 1, time: T0, data: { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' } }, usage: { inputTokens: 6, outputTokens: 2 } } };
  writeFileSync(file, sessionLines('s2', []).join('\n') + '\n' + JSON.stringify(ev) + '\n');

  const store = new TokenUsageStore({ filePath: join(root, 'state.json'), flushDelayMs: 60_000 });
  let r = backfillOnce({ store, root });
  assert.equal(r.ingested, 1);
  r = backfillOnce({ store, root });
  assert.equal(r.ingested, 0);
  assert.equal(store.summarize({ start: new Date(T0 - 864e5), end: new Date(T0 + 864e5) }).total.input, 6);
  rmSync(root, { recursive: true, force: true });
});

test('torn trailing frame is ignored, complete frames still count', () => {
  const buf = zstdCompressSync('{"type":"assistant/message","seq":1,"time":1,"data":{}}\n');
  const torn = Buffer.concat([buf, buf.subarray(0, 3)]); // 3 magic bytes, no frame
  const frames = splitZstdFrames(torn);
  assert.equal(frames.length, 1, 'torn tail yields no extra frame');
});

test('listSessionFiles finds zstd and raw transcripts', () => {
  const root = mkdtempSync(join(tmpdir(), 'tu-root-'));
  writeZstdSession(root, 'projA', 'sess1', []);
  const rawDir = join(root, 'projB', 'sess2');
  mkdirSync(rawDir, { recursive: true });
  writeFileSync(join(rawDir, 'session.jsonl'), 'x\n');
  const files = listSessionFiles(root).sort();
  assert.equal(files.length, 2);
  assert.ok(files.some((f) => f.endsWith('projA/sess1/session.jsonl.zstd')));
  assert.ok(files.some((f) => f.endsWith('projB/sess2/session.jsonl')));
  rmSync(root, { recursive: true, force: true });
});
