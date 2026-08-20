/**
 * dsh-plugin-token-usage — client half entry (Web GUI panel, phase 2).
 *
 * Registers a "Token 用量" section into the Settings page through the
 * already-declared `settings.section` slot (declared by ui-settings-general's
 * SettingsRoot, always in the web roster). The section component fetches
 * aggregated usage from the host's data endpoint (GET /api/token-usage,
 * registered by the node half) and renders totals, a per-day bar chart and a
 * per-model table for 7/30/90-day windows. No third-party chart dependency:
 * the charts are plain CSS bars.
 *
 * Type-only imports pull the slot-key and locale declarations into the
 * program (erased at build — they never reach the bundle).
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ui-settings SlotMap merge (settings.section declaration).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

import { TokenUsagePanel } from './TokenUsagePanel.tsx'
import type { TokenUsagePanelInjected } from './TokenUsagePanel.tsx'
import { en, NS, zh, type TokenUsageKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Token usage panel copy. */
    'settings.tokenUsage': TokenUsageKey
  }
}

/** Services required by the panel (slots + locale). */
export const inject = ['slots', 'locale']

/**
 * Register the Token 用量 settings section.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'token-usage: copy dictionaries')
  const t = ctx.locale.bind(NS)
  const injected = (): TokenUsagePanelInjected => ({ t: t as TokenUsagePanelInjected['t'] })
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      { name: 'settings.section', id: 'token-usage', order: 30, label: () => t('nav'), locale: NS, inject: injected },
      TokenUsagePanel,
    ),
  )
}
