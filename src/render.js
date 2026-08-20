/**
 * QwenPaw-style text rendering for token usage summaries.
 *
 * `fmtTokens` formats in M/B units (1.2M for >= 1e6, 1.5B for >= 1e9,
 * plain integer below).
 * Layout:
 *   - total row (calls, input, output, cache read/write)
 *   - per-model table, sorted by total tokens desc
 *   - per-date sparkline rows (last N days)
 *
 * @module dsh-plugin-token-usage/render
 */

/**
 * Format a token count in M/B units: `1.2M` for >= 1e6 (million), `1.5B` for
 * >= 1e9 (billion), plain integer below.
 * @param {number} n
 * @returns {string}
 */
export function fmtTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '0';
  if (n >= 1e9) return trimZero(n / 1e9) + 'B';
  if (n >= 1e6) return trimZero(n / 1e6) + 'M';
  return String(Math.round(n));
}

/** One decimal with a trailing ".0" dropped (1.0 -> "1", 1.2 -> "1.2"). */
function trimZero(x) {
  return x.toFixed(1).replace(/\.0$/, '');
}

/**
 * @param {object} opts
 * @param {object} opts.summary - TokenUsageStore.summarize() result
 * @param {number} [opts.days] - how many per-date rows to show (default 14)
 * @returns {string} plain-text report
 */
export function renderUsageReport({ summary, days = 14 }) {
  const lines = [];
  lines.push(`📊 Token Usage  ${summary.startKey} → ${summary.endKey}`);
  lines.push('');

  if (summary.total.calls === 0) {
    lines.push('No token usage recorded in this range.');
    lines.push('(Usage is counted from completed model calls.)');
    return lines.join('\n');
  }

  const t = summary.total;
  const totalTokens = t.input + t.cacheRead + t.cacheWrite + t.output;
  lines.push(
    `Total: ${fmtTokens(totalTokens)} tokens · ${t.calls} call${t.calls === 1 ? '' : 's'}`,
  );
  lines.push(
    `  input ${fmtTokens(t.input)} · output ${fmtTokens(t.output)} · cache read ${fmtTokens(t.cacheRead)}`,
  );
  if (t.cacheWrite > 0) lines.push(`  cache write ${fmtTokens(t.cacheWrite)}`);
  lines.push('');

  // Per-model table.
  lines.push('By model:');
  const models = [...summary.byModel.values()].sort(
    (a, b) => totalOf(b.stats) - totalOf(a.stats),
  );
  for (const m of models) {
    const tot = totalOf(m.stats);
    lines.push(
      `  ${m.provider}/${m.model}  —  ${fmtTokens(tot)} tokens · ${m.stats.calls} calls`,
    );
    lines.push(
      `      in ${fmtTokens(m.stats.input)} · out ${fmtTokens(m.stats.output)} · cacheR ${fmtTokens(m.stats.cacheRead)}`,
    );
  }
  lines.push('');

  // Per-date sparkline (last `days` days that have data, newest last).
  const dateRows = [...summary.byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-days);
  if (dateRows.length > 1) {
    lines.push('By day:');
    for (const [dateKey, stats] of dateRows) {
      lines.push(`  ${dateKey}  ${fmtTokens(totalOf(stats))} tokens · ${stats.calls} calls`);
    }
  }
  return lines.join('\n');
}

function totalOf(s) {
  return s.input + s.cacheRead + s.cacheWrite + s.output;
}

/**
 * Parse a `/usage` raw input.
 *
 * Grammar: `/usage [Nd] [model-filter]`
 *   - `Nd`       — look back N days (default 30)
 *   - `model-filter` — case-insensitive substring on "provider/model"
 *
 * @param {string} rawInput
 * @returns {{days?: number, modelFilter?: string, error?: string}}
 */
export function parseUsageArgs(rawInput) {
  const s = (rawInput ?? '').trim();
  if (!s) return {};
  const out = {};
  const m = s.match(/^(\d+)[dD](?:\s+([\s\S]*))?$/);
  if (m) {
    const days = parseInt(m[1], 10);
    if (days < 1 || days > 3650) {
      return { error: 'Day range must be 1..3650, e.g. /usage 7d' };
    }
    out.days = days;
    const rest = (m[2] ?? '').trim();
    if (rest) out.modelFilter = rest.toLowerCase();
    return out;
  }
  if (/^\d/.test(s)) {
    return { error: 'Usage: /usage [Nd] [model-filter]  (default: last 30 days)' };
  }
  out.modelFilter = s.toLowerCase();
  return out;
}
