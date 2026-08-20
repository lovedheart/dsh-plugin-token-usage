/**
 * Plugin harness test: mount dsh-plugin-token-usage in a real Cordis Context
 * with a stub `commands` service, feed it a tiny session log, and dispatch
 * `/usage` end to end. Uses the same plugin-module shape the Cordis loader
 * consumes (name/inject/Config/apply exports).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context, Service } from '@deepseek-ai/cordis';

/** Minimal commands service stub with the same registration seam the plugin uses. */
class CommandsStub extends Service {
  constructor(ctx) {
    super(ctx, 'commands');
    this.definitions = [];
  }
  register(def) {
    this.definitions.push(def);
    return () => {
      const i = this.definitions.indexOf(def);
      if (i >= 0) this.definitions.splice(i, 1);
    };
  }
}
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';

const plugin = await import('../lib/index.js');

// Relative to now so the fixed data always lands inside the 7-day /usage
// window regardless of when the suite runs (a hardcoded date drifted out of
// the window as the wall clock advanced, breaking the assertion).
const T0 = Date.now() - 2 * 86_400_000;

function buildSessions(root) {
  const dir = join(root, '--proj--', 'sess1');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'session.jsonl.zstd');
  const lines = [
    JSON.stringify({ type: 'session', version: 0, id: 'sess1', delegationDepth: 0, createdAt: T0 }),
    JSON.stringify({ type: 'assistant/message', seq: 1, time: T0, data: { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model', provider: 'provA', model: 'alpha-model' } }, usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 900 } } }),
  ];
  writeFileSync(file, zstdCompressSync(lines.join('\n') + '\n'));
  return file;
}

test('plugin boots in a cordis Context and /usage reports the session log', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tu-plugin-'));
  const sessionsRoot = join(tmp, 'sessions');
  const stateFile = join(tmp, 'state.json');
  buildSessions(sessionsRoot);

  const ctx = new Context();
  await ctx.plugin(CommandsStub);

  await ctx.plugin(plugin, {
    sessionsRoot,
    stateFile,
    defaultDays: 7,
    backfillIntervalSec: 5,
    verbose: false,
  });

  try {
    assert.equal(ctx.commands.definitions.length, 1, 'one command registered');
    assert.equal(ctx.commands.definitions[0].name, 'usage');

    // Give the 500ms first-pass backfill a chance, then dispatch /usage.
    await new Promise((r) => setTimeout(r, 800));
    const result = await ctx.commands.definitions[0].handler({
      rawInput: 'alpha',
      commandId: 'cmd-1',
      agent: {},
      signal: new AbortController().signal,
    });
    assert.equal(result.kind, 'success');
    assert.match(result.text, /provA\/alpha-model/);
    // total = input 1200 + cacheRead 900 + output 300 = 2400 → "2400"
    assert.match(result.text, /Total: 2400 tokens · 1 call/);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('plugin boots without a commands service (optional dependency)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'tu-plugin-'));
  const sessionsRoot = join(tmp, 'sessions');
  mkdirSync(sessionsRoot, { recursive: true });
  const ctx = new Context();
  // No commands service at all — the optional child fiber must not throw.
  await ctx.plugin(plugin, { sessionsRoot, stateFile: join(tmp, 'state.json'), defaultDays: 7 });
  await new Promise((r) => setTimeout(r, 600));
  await ctx.fiber.dispose();
});
