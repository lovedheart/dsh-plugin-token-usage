/**
 * E2E: mount the REAL dsh-host-webserver + dsh-plugin-token-usage in one
 * cordis Context, boot on an OS-assigned port, feed a session log, then
 * GET /api/token-usage over real HTTP and assert the JSON the Web panel
 * consumes. This proves the host→client data channel end to end.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { Context } from '@deepseek-ai/cordis';
// The real host webserver lives in the global dsh install (ES module).
const webserverMod = await import(
  '/home/lovedheart/.nvm/versions/node/v22.22.3/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js'
);
const WebServer = webserverMod.default;

const plugin = await import('../lib/index.js');

const T0 = Date.now() - 2 * 86_400_000; // 2 days ago → inside the 7d window

function buildSessions(root) {
  const dir = join(root, '--proj--', 'sess1');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'session.jsonl.zstd');
  const lines = [
    JSON.stringify({ type: 'session', version: 0, id: 'sess1', delegationDepth: 0, createdAt: T0 }),
    JSON.stringify({ type: 'assistant/message', seq: 1, time: T0, data: { turn: 1, step: 1, message: { role: 'assistant', source: { kind: 'model', provider: 'provA', model: 'alpha-model' } }, usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 900 } } }),
  ];
  writeFileSync(file, zstdCompressSync(lines.join('\n') + '\n'));
}

test('GET /api/token-usage returns panel JSON over real HTTP', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'tu-e2e-'));
  const sessionsRoot = join(tmp, 'sessions');
  buildSessions(sessionsRoot);

  const ctx = new Context();
  // OS-assigned free port.
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  await ctx.plugin(plugin, {
    sessionsRoot,
    stateFile: join(tmp, 'state.json'),
    defaultDays: 7,
    backfillIntervalSec: 5,
    enableCommand: false, // command not needed for the HTTP path
    verbose: false,
  });

  const port = ctx.webServer.port;
  t.after(async () => { await ctx.fiber.dispose(); });

  // Let the 500ms first-pass backfill ingest the session log.
  await new Promise((r) => setTimeout(r, 900));

  const res = await fetch(`http://127.0.0.1:${port}/api/token-usage`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal(res.headers.get('cache-control'), 'no-store');

  const data = await res.json();
  // Top-level wire shape.
  assert.ok(typeof data.now === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.now));
  assert.ok(data.all && data.windows);
  for (const w of ['7d', '30d', '90d']) assert.ok(data.windows[w]);

  // The ingested model is in the 7d window with the QwenPaw total (1200+900+300=2400).
  const w7 = data.windows['7d'];
  const model = w7.models.find((m) => m.label === 'provA/alpha-model');
  assert.ok(model, 'provA/alpha-model present in 7d window');
  assert.equal(model.total, 2400);
  assert.equal(model.input, 1200);
  assert.equal(model.output, 300);
  assert.equal(model.cacheRead, 900);
  assert.equal(w7.totalTokens, 2400);
});
