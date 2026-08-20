/**
 * Token 用量 panel: totals + per-day bar chart + per-model table, served by
 * the host's GET /api/token-usage data endpoint. Plain CSS bars — no chart
 * dependency. Data is fetched on mount and on explicit refresh; the panel is
 * a read-only projection of the host's aggregate store.
 */
import { useCallback, useEffect, useState } from 'react'
import type { TokenUsageKey } from './locales.ts'
import './panel.css'

/** Token formatting: 1.2M for >= 1e6, 1.5B for >= 1e9, integer below. */
export function fmtTokens(n: number): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '0'
  const trim = (x: number) => x.toFixed(1).replace(/\.0$/, '')
  if (n >= 1e9) return trim(n / 1e9) + 'B'
  if (n >= 1e6) return trim(n / 1e6) + 'M'
  return String(Math.round(n))
}

/** 2026-08-19 -> 08-19 (bar axis label). */
function shortDate(date: string): string {
  return date.length === 10 ? date.slice(5) : date
}

interface Stats {
  input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; calls: number
}
interface DayRow { date: string; total: number; calls: number }
interface ModelRow {
  key: string; label: string
  input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number
  calls: number; total: number
}
interface UsageWindow {
  startKey: string; endKey: string; total: Stats; totalTokens: number
  models: ModelRow[]; days: DayRow[]
}
interface Payload {
  now: string
  all: { total: Stats; totalTokens: number; models: Array<{ key: string; label: string; total: number }>; days: DayRow[] }
  windows: Record<'7d' | '30d' | '90d', UsageWindow>
}

export interface TokenUsagePanelInjected {
  t: (key: TokenUsageKey) => string
}
export type TokenUsagePanelProps = Partial<TokenUsagePanelInjected>

type WinKey = '7d' | '30d' | '90d'
const WINDOW_LABEL_KEY: Record<WinKey, TokenUsageKey> = { '7d': 'window7', '30d': 'window30', '90d': 'window90' }

/** One stat card (label + value). */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="tu-stat">
      <div className="tu-stat__value">{value}</div>
      <div className="tu-stat__label">{label}</div>
    </div>
  )
}

/** Per-day bar chart: flex row of CSS bars, tallest day = 100%. */
function DayBars({ days, t }: { days: DayRow[]; t: TokenUsagePanelInjected['t'] }) {
  const max = days.reduce((m, d) => Math.max(m, d.total), 0)
  if (max === 0 || days.length === 0) {
    return <div className="tu-empty">{t('noDays')}</div>
  }
  // Show every Nth axis label so labels never collide (roughly 8 max).
  const step = Math.max(1, Math.ceil(days.length / 8))
  return (
    <div>
      <div className="tu-bars">
        {days.map((d, i) => (
          <div key={d.date} className="tu-bar" title={`${d.date} · ${fmtTokens(d.total)} · ${d.calls} ${t('calls')}`}>
            <div
              className="tu-bar__fill"
              style={{ height: `${Math.max(2, (d.total / max) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="tu-axis">
        {days.map((d, i) => (
          <span key={d.date} className="tu-axis__label">
            {i % step === 0 ? shortDate(d.date) : ''}
          </span>
        ))}
      </div>
    </div>
  )
}

/** One row of the per-model table. */
function ModelRowView({ row, total, t }: { row: ModelRow; total: number; t: TokenUsagePanelInjected['t'] }) {
  const share = total > 0 ? row.total / total : 0
  return (
    <tr className="tu-row">
      <td className="tu-cell tu-cell--model">
        <div className="tu-model">
          <span className="tu-model__name" title={row.label}>{row.label}</span>
          <span className="tu-model__share">{Math.round(share * 100)}% {t('share')}</span>
        </div>
        <div className="tu-model__bar"><div className="tu-model__bar-fill" style={{ width: `${share * 100}%` }} /></div>
      </td>
      <td className="tu-cell tu-cell--num">{fmtTokens(row.input)}</td>
      <td className="tu-cell tu-cell--num">{fmtTokens(row.output)}</td>
      <td className="tu-cell tu-cell--num">{fmtTokens(row.cacheRead)}</td>
      <td className="tu-cell tu-cell--num">{row.cacheWrite > 0 ? fmtTokens(row.cacheWrite) : '—'}</td>
      <td className="tu-cell tu-cell--num">{fmtTokens(row.total)}</td>
      <td className="tu-cell tu-cell--num">{row.calls}</td>
    </tr>
  )
}

/**
 * The Token 用量 settings section body.
 * @param props - the slot inject face (t).
 */
export function TokenUsagePanel({ t }: TokenUsagePanelProps) {
  const tr = t ?? (k => k as unknown as string)
  const [payload, setPayload] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [win, setWin] = useState<WinKey>('7d')

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await fetch('/api/token-usage', { headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setPayload((await res.json()) as Payload)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  if (error) {
    return (
      <div className="tu-panel">
        <div className="tu-error">{tr('loadFailed')} ({error})</div>
        <button type="button" className="tu-refresh" onClick={() => void load()}>{tr('refresh')}</button>
      </div>
    )
  }
  if (!payload) {
    return (
      <div className="tu-panel">
        <div className="tu-loading">{tr('loading')}</div>
      </div>
    )
  }
  if (payload.all.total.calls === 0 && payload.all.totalTokens === 0) {
    return (
      <div className="tu-panel">
        <div className="tu-empty">{tr('noData')}</div>
        <div className="tu-endpoint">{tr('endpoint')}</div>
      </div>
    )
  }

  const w = payload.windows[win]

  return (
    <div className="tu-panel">
      <div className="tu-head">
        <div className="tu-tabs" role="tablist">
          {(['7d', '30d', '90d'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={win === k}
              className={win === k ? 'tu-tab tu-tab--active' : 'tu-tab'}
              onClick={() => setWin(k)}
            >
              {tr(WINDOW_LABEL_KEY[k])}
            </button>
          ))}
        </div>
        <button type="button" className="tu-refresh" onClick={() => void load()}>{tr('refresh')}</button>
      </div>

      <div className="tu-cards">
        <Stat label={tr('totalTokens')} value={fmtTokens(w.totalTokens)} />
        <Stat label={tr('calls')} value={String(w.total.calls)} />
        <Stat label={tr('input')} value={fmtTokens(w.total.input)} />
        <Stat label={tr('output')} value={fmtTokens(w.total.output)} />
        <Stat label={tr('cacheRead')} value={fmtTokens(w.total.cacheRead)} />
        {w.total.cacheWrite > 0 && <Stat label={tr('cacheWrite')} value={fmtTokens(w.total.cacheWrite)} />}
      </div>

      <section className="tu-section">
        <h3 className="tu-section__title">{tr('byDay')}</h3>
        <DayBars days={w.days} t={tr} />
      </section>

      <section className="tu-section">
        <h3 className="tu-section__title">{tr('byModel')}</h3>
        <div className="tu-table-wrap">
          <table className="tu-table">
            <thead>
              <tr>
                <th className="tu-cell">{tr('modelLabel')}</th>
                <th className="tu-cell tu-cell--num">{tr('input')}</th>
                <th className="tu-cell tu-cell--num">{tr('output')}</th>
                <th className="tu-cell tu-cell--num">{tr('cacheRead')}</th>
                <th className="tu-cell tu-cell--num">{tr('cacheWrite')}</th>
                <th className="tu-cell tu-cell--num">{tr('totalTokens')}</th>
                <th className="tu-cell tu-cell--num">{tr('calls')}</th>
              </tr>
            </thead>
            <tbody>
              {w.models.map((m) => (
                <ModelRowView key={m.key} row={m} total={w.totalTokens} t={tr} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="tu-endpoint">
        {tr('endpoint')} · {w.startKey} → {w.endKey}
      </div>
    </div>
  )
}
