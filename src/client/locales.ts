/** Token 用量 panel copy (zh/en parity). */

export const NS = 'settings.tokenUsage' as const

export const en = {
  nav: 'Token Usage',
  loading: 'Loading usage data…',
  loadFailed: 'Failed to load token usage.',
  noData: 'No token usage recorded yet. Completed model calls are counted by the host plugin.',
  endpoint: 'Source: /api/token-usage',
  refresh: 'Refresh',
  totalTokens: 'Total tokens',
  calls: 'Calls',
  input: 'Input',
  output: 'Output',
  cacheRead: 'Cache read',
  cacheWrite: 'Cache write',
  byDay: 'By day',
  byModel: 'By model',
  noDays: 'No per-day data in this window.',
  window7: '7 days',
  window30: '30 days',
  window90: '90 days',
  modelLabel: 'Model',
  share: 'Share',
} as const

export const zh = {
  nav: 'Token 用量',
  loading: '正在加载用量数据…',
  loadFailed: '加载 Token 用量失败。',
  noData: '暂无 Token 用量记录。已完成的模型调用由宿主插件统计。',
  endpoint: '数据源：/api/token-usage',
  refresh: '刷新',
  totalTokens: '总 tokens',
  calls: '调用次数',
  input: '输入',
  output: '输出',
  cacheRead: '缓存读',
  cacheWrite: '缓存写',
  byDay: '按天',
  byModel: '按模型',
  noDays: '该窗口内无按天数据。',
  window7: '近 7 天',
  window30: '近 30 天',
  window90: '近 90 天',
  modelLabel: '模型',
  share: '占比',
} as const

export type TokenUsageKey = keyof typeof en
