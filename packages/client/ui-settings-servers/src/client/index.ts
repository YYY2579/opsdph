/**
 * Servers & Databases settings plugin, browser half. It registers the section
 * that lists, probes, and persists the managed servers and databases through
 * the `ops` Remote namespace; every write keeps the Host's probe-before-save
 * rule. Export discipline: packages/client/AGENTS.md.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the slots Context merge (ctx.slots) and the SlotMap merge.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the renderer's Context merge (ctx.slots registration).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ctx.remote merge (the ops namespace) into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { ServersSection } from './ServersSection.tsx'
import type { ServersSectionInjected } from './ServersSection.tsx'
import { createOpsOperations } from './operations.ts'
import { en, zh, type ServersLocaleKey } from './locales.ts'

export type { ServersSectionInjected, ServersSectionProps } from './ServersSection.tsx'
export type { OpsOperations, OpsListOutcome } from './operations.ts'
export type { ServersLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Servers & Databases settings section copy. */
    'settings.servers': ServersLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.servers'

/** Required services (cordis fiber inject). */
export const inject = [
  'slots', 'locale', 'remote', 'remote.ops',
]

/**
 * Register the Servers & Databases section once the `settings.section`
 * declaration is on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-servers: copy dictionaries')

  const operations = createOpsOperations(ctx)
  const t = ctx.locale.bind(NS) as ServersSectionInjected['t']
  const injected = (): ServersSectionInjected => ({ operations, t })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'servers',
    order: 20,
    label: () => t('nav'),
    inject: injected,
  }, ServersSection))
}
