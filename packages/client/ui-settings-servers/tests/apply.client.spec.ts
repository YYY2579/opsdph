/** Servers & Databases section registration: slot declaration injection, the locale-following label thunk. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-settings-servers/client'
import { apply as hostApply } from '../src/index.ts'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const remote = new TestRemote(ctx, {
    ops: {
      listServers: vi.fn(() => Promise.resolve({ ok: true, value: [] })),
      listDbs: vi.fn(() => Promise.resolve({ ok: true, value: [] })),
      testServer: vi.fn(() => Promise.resolve({ ok: true, value: { ok: true, detail: 'ok' } })),
      testDb: vi.fn(() => Promise.resolve({ ok: true, value: { ok: true, detail: 'ok' } })),
      addServer: vi.fn(() => Promise.resolve({ ok: true, value: { id: 's1' } })),
      addDb: vi.fn(() => Promise.resolve({ ok: true, value: { id: 'd1' } })),
      removeServer: vi.fn(() => Promise.resolve({ ok: true, value: true })),
      removeDb: vi.fn(() => Promise.resolve({ ok: true, value: true })),
    },
    settings: {
      describe: vi.fn(() => Promise.resolve({ ok: true, value: { writable: true, hasDocument: false, namespaces: [] } })),
    },
  })
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, remote }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register(
    {
      name: 'root',
      children: {
        'settings.section': { kind: 'list', scope: 'root' },
      },
    } as never,
    () => null,
  )
}

describe('ui-settings-servers apply', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.ops'])
  })

  it('registers the servers nav entry with a locale-following label', async () => {
    const benchState = await bench()
    onTestFinished(() => { void benchState.ctx.fiber.dispose() })
    declare(benchState.slots)
    await benchState.ctx.plugin({ inject: [...inject], apply }).await()
    const entries = benchState.slots.entries('settings.section')
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    expect(entry.options).toMatchObject({ id: 'servers', order: 20 })
    // The nav label is a locale-following thunk; owners resolve at read time.
    expect(resolveSlotLabel(entry.options.label)).toBe('服务器与数据库')
    benchState.locale.setLocale('en')
    expect(resolveSlotLabel(entry.options.label)).toBe('Servers & Databases')
    const injected = (entry.inject as unknown as () => import('../src/client/ServersSection.tsx').ServersSectionInjected)()
    expect(injected.t('nav')).toBe('Servers & Databases')
    expect(typeof injected.operations.testServer).toBe('function')
    expect(typeof injected.operations.removeDb).toBe('function')
  })
})
