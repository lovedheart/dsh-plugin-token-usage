/**
 * Unit tests for the Web GUI panel data builder (web-panel.js): wire shape,
 * QwenPaw total formula, window filtering, model sorting, date sorting, and
 * the response envelope. No cordis/http — pure functions over the store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TokenUsageStore } from '../src/store.js';
import { buildPanelPayload, panelResponse } from '../src/web-panel.js';

const NOW = new Date();
const daysAgo = (n) => new Date(NOW.getTime() - n * 86_400_000);

function storeInTmp() {
  const dir = mkdtempSync(join(tmpdir(), 'tu-web-'));
  return new TokenUsageStore({ filePath: join(dir, 'state.json'), flushDelayMs: 60_000, log: () => {} });
}

test('payload top-level shape: now / all / windows(7d,30d,90d)', () => {
  const p = buildPanelPayload(storeInTmp());
  assert.equal(typeof p.now, 'string');
  assert.match(p.now, /^\d{4}-\d{2}-\d{2}$/);
  for (const k of ['all', 'windows']) assert.ok(k in p);
  for (const w of ['7d', '30d', '90d']) {
    assert.ok(p.windows[w], `window ${w} missing`);
    assert.ok(p.windows[w].models);
    assert.ok(p.windows[w].days);
  }
});

test('QwenPaw total formula = input+cacheRead+cacheWrite+output (excludes reasoning)', () => {
  const s = storeInTmp();
  s.add(NOW.getTime(), 'provA', 'm1', { inputTokens: 100, outputTokens: 40, cacheReadTokens: 30, cacheWriteTokens: 5, reasoningTokens: 999 });
  s.add(NOW.getTime(), 'provB', 'm2', { inputTokens: 200, outputTokens: 60, cacheReadTokens: 20 });
  const p = buildPanelPayload(s);
  // 100+40+30+5 + 200+60+20 = 455
  assert.equal(p.all.totalTokens, 455);
  assert.equal(p.all.total.reasoning, 999); // reasoning carried but NOT in totalTokens
  assert.equal(p.windows['7d'].totalTokens, 455);
});

test('7d window excludes data older than 7 days', () => {
  const s = storeInTmp();
  s.add(daysAgo(2).getTime(), 'provA', 'recent', { inputTokens: 10, outputTokens: 5 });
  s.add(daysAgo(20).getTime(), 'provA', 'old', { inputTokens: 500, outputTokens: 500 });
  const p = buildPanelPayload(s);
  const w7 = p.windows['7d'].models.map((m) => m.label);
  assert.ok(w7.includes('provA/recent'));
  assert.ok(!w7.includes('provA/old'), '20-day-old model must not appear in 7d window');
  assert.ok(p.windows['90d'].models.some((m) => m.label === 'provA/old'));
});

test('models sorted by total desc; days sorted asc; per-model breakdown fields present', () => {
  const s = storeInTmp();
  s.add(daysAgo(1).getTime(), 'provA', 'big', { inputTokens: 1000, outputTokens: 100 });
  s.add(daysAgo(1).getTime(), 'provB', 'small', { inputTokens: 10, outputTokens: 5 });
  const w = buildPanelPayload(s).windows['30d'];
  assert.deepEqual(w.models.map((m) => m.label), ['provA/big', 'provB/small']);
  const m0 = w.models[0];
  for (const f of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'calls', 'total']) assert.ok(f in m0);
  assert.equal(m0.total, 1100);
  // days ascending (oldest first)
  for (let i = 1; i < w.days.length; i++) assert.ok(w.days[i - 1].date <= w.days[i].date);
});

test('panelResponse: 200 + content-type + no-store + parseable JSON', () => {
  const r = panelResponse(buildPanelPayload(storeInTmp()));
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(typeof JSON.parse(r.body), 'object');
});

test('empty store → zero totals, empty model/day lists (panel shows no-data state)', () => {
  const p = buildPanelPayload(storeInTmp());
  assert.equal(p.all.total.calls, 0);
  assert.equal(p.all.totalTokens, 0);
  assert.equal(p.all.models.length, 0);
  assert.equal(p.all.days.length, 0);
});
