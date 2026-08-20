/**
 * Rendering + argument parsing tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtTokens, renderUsageReport, parseUsageArgs } from '../src/render.js';

test('fmtTokens formats in M/B (1e6 = M, 1e9 = B)', () => {
  assert.equal(fmtTokens(999), '999');
  assert.equal(fmtTokens(1000), '1000');
  assert.equal(fmtTokens(12345), '12345');
  assert.equal(fmtTokens(0), '0');
  assert.equal(fmtTokens(1_000_000), '1M');
  assert.equal(fmtTokens(1_234_567), '1.2M');
  assert.equal(fmtTokens(950_000_000), '950M');
  assert.equal(fmtTokens(1_500_000_000), '1.5B');
});

test('empty range renders a no-usage message', () => {
  const text = renderUsageReport({
    summary: { startKey: '2026-08-01', endKey: '2026-08-16', total: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0 }, byModel: new Map(), byDate: new Map() },
  });
  assert.match(text, /No token usage recorded/);
  assert.match(text, /2026-08-01 → 2026-08-16/);
});

test('populated summary renders totals, per-model, per-day', () => {
  const stats = (input, output, calls) => ({ input, output, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls });
  const summary = {
    startKey: '2026-08-01',
    endKey: '2026-08-02',
    total: stats(1000, 500, 2),
    byModel: new Map([
      ['provA|alpha', { provider: 'provA', model: 'alpha', stats: stats(700, 300, 1) }],
      ['provB|beta', { provider: 'provB', model: 'beta', stats: stats(300, 200, 1) }],
    ]),
    byDate: new Map([
      ['2026-08-01', stats(700, 300, 1)],
      ['2026-08-02', stats(300, 200, 1)],
    ]),
  };
  const text = renderUsageReport({ summary });
  assert.match(text, /Total: 1500 tokens · 2 calls/);
  assert.match(text, /provA\/alpha/);
  assert.match(text, /provB\/beta/);
  assert.match(text, /2026-08-01  1000 tokens/);
  assert.match(text, /2026-08-02  500 tokens/);
  // Sorted by total desc: alpha (1000) before beta (500).
  assert.ok(text.indexOf('provA/alpha') < text.indexOf('provB/beta'));
});

test('parseUsageArgs: bare, days, model, combined, and errors', () => {
  assert.deepEqual(parseUsageArgs(''), {});
  assert.deepEqual(parseUsageArgs('   '), {});
  assert.deepEqual(parseUsageArgs('7d'), { days: 7 });
  assert.deepEqual(parseUsageArgs('30d'), { days: 30 });
  assert.deepEqual(parseUsageArgs('7d alpha'), { days: 7, modelFilter: 'alpha' });
  assert.deepEqual(parseUsageArgs('ALPHA'), { modelFilter: 'alpha' });
  assert.match(parseUsageArgs('7').error, /Usage:/);
  assert.match(parseUsageArgs('0d').error, /1\.\.3650/);
  assert.match(parseUsageArgs('99999d').error, /1\.\.3650/);
});
