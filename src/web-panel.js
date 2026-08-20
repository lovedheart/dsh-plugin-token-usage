/**
 * Data builder for the token-usage Web GUI panel (`GET /api/token-usage`).
 *
 * Pure functions over a `TokenUsageStore` — no cordis, no http — so the
 * shape can be unit-tested without a plugin context. The wire shape is the
 * contract with the client bundle (src/client): keep it additive.
 *
 * Wire shape (all token counts are raw numbers; the client formats):
 * ```
 * {
 *   now: "2026-08-19",            // local date key, for the client's labels
 *   all: { startKey, endKey, models: [{key,label,total}],
 *         total: BucketStats, totalTokens: number,
 *         days: [{date, total, calls, input, output, cacheRead, cacheWrite}] },
 *   windows: { "7d": Window, "30d": Window, "90d": Window }
 * }
 * Window = { startKey, endKey, total: BucketStats, totalTokens: number,
 *            models: [{key,label,input,output,cacheRead,cacheWrite,reasoning,calls,total}],
 *            days: [{date,total,calls}] }
 * ```
 *
 * @module dsh-plugin-token-usage/web-panel
 */

/**
 * @param {{input:number,output:number,cacheRead:number,cacheWrite:number,reasoning:number,calls:number}} s
 * @returns {number} input + cache read + cache write + output (QwenPaw parity)
 */
function totalTokens(s) {
  return s.input + s.cacheRead + s.cacheWrite + s.output;
}

/** Local YYYY-MM-DD key for a Date (client/server label alignment). */
function localDateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Project one window (lookback `days` ending today) from a store.
 * @param {import('./store.js').TokenUsageStore} store
 * @param {number} days
 * @returns {object} the Window shape above
 */
function buildWindow(store, days) {
  const end = new Date();
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  const summary = store.summarize({ start, end });
  const models = [...summary.byModel.values()]
    .map((m) => ({
      key: `${m.provider}|${m.model}`,
      label: `${m.provider}/${m.model}`,
      input: m.stats.input,
      output: m.stats.output,
      cacheRead: m.stats.cacheRead,
      cacheWrite: m.stats.cacheWrite,
      reasoning: m.stats.reasoning,
      calls: m.stats.calls,
      total: totalTokens(m.stats),
    }))
    .sort((a, b) => b.total - a.total);
  const daysRows = [...summary.byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, s]) => ({
      date,
      total: totalTokens(s),
      calls: s.calls,
      input: s.input,
      output: s.output,
      cacheRead: s.cacheRead,
      cacheWrite: s.cacheWrite,
    }));
  return {
    startKey: summary.startKey,
    endKey: summary.endKey,
    total: summary.total,
    totalTokens: totalTokens(summary.total),
    models,
    days: daysRows,
  };
}

/**
 * Build the full payload for the Web panel.
 * @param {import('./store.js').TokenUsageStore} store
 * @returns {object} the wire shape documented at module top
 */
export function buildPanelPayload(store) {
  const all = store.summarize({ start: new Date(0), end: new Date() });
  return {
    now: localDateKey(new Date()),
    all: {
      startKey: all.startKey,
      endKey: all.endKey,
      total: all.total,
      totalTokens: totalTokens(all.total),
      models: [...all.byModel.values()]
        .map((m) => ({ key: `${m.provider}|${m.model}`, label: `${m.provider}/${m.model}`, total: totalTokens(m.stats) }))
        .sort((a, b) => b.total - a.total),
      days: [...all.byDate.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([date, s]) => ({ date, total: totalTokens(s), calls: s.calls })),
    },
    windows: {
      '7d': buildWindow(store, 7),
      '30d': buildWindow(store, 30),
      '90d': buildWindow(store, 90),
    },
  };
}

/** JSON body + response headers for the endpoint. */
export function panelResponse(payload) {
  return {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Loopback-only data plane: the webServer serves 127.0.0.1 by config.
      'cache-control': 'no-store',
    },
    body: JSON.stringify(payload),
  };
}
