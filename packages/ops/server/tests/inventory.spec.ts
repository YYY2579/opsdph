/**
 * Unit tests for the ops target inventory: the memory fallback merges with the
 * configured preset layer, adds and removes persist credential references (never
 * values), and nickname-based listing stays free of any credential content.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { OpsInventory } from '../src/inventory.ts'
import type { ServerEntryConfig } from '../src/inventory.ts'

const PRESET: readonly ServerEntryConfig[] = [{
  id: 'web-01',
  name: 'Preset web 01',
  host: '203.0.113.10',
  port: 22,
  username: 'deploy',
  keyRef: '/keys/web-01',
  environment: 'prod',
  tags: ['edge'],
}]

/** A context whose credentials seam is mocked and storage-domain is absent. */
function fakeContext(): {
  ctx: Context
  set: ReturnType<typeof vi.fn>
  unset: ReturnType<typeof vi.fn>
  resolve: ReturnType<typeof vi.fn>
} {
  const set = vi.fn()
  const unset = vi.fn()
  const resolve = vi.fn()
  const ctx = {
    credentials: { set, unset, resolve },
    get: () => undefined,
  } as unknown as Context
  return { ctx, set, unset, resolve }
}

describe('OpsInventory memory fallback', () => {
  it('merges preset servers with user records, user ids winning', async () => {
    const { ctx } = fakeContext()
    const inventory = new OpsInventory(ctx, PRESET)
    await inventory.start()
    await inventory.addServer({
      nickname: 'My lab box',
      host: '203.0.113.20',
      port: 2222,
      username: 'ops',
      environment: 'lab',
      tags: [],
    }, 'secret')
    const servers = inventory.listServers()
    expect(servers).toHaveLength(2)
    expect(servers[0]?.name).toBe('Preset web 01')
    expect(servers[1]?.name).toBe('My lab box')
    expect(servers[1]?.keyRef.startsWith('OPS_TARGET_')).toBe(true)
    // The model-facing projection never carries the credential value.
    expect(JSON.stringify(servers)).not.toContain('secret')
  })

  it('stores the password only as a credential reference and resolves it on demand', async () => {
    const { ctx, set, resolve } = fakeContext()
    resolve.mockResolvedValue({ value: 'secret', source: 'test' })
    const inventory = new OpsInventory(ctx, PRESET)
    await inventory.start()
    await inventory.addServer({ nickname: 'n', host: 'h', port: 22, username: 'u', environment: 'lab', tags: [] }, 'secret')
    expect(set).toHaveBeenCalledTimes(1)
    const ref = String(set.mock.calls[0]?.[0])
    expect(ref.startsWith('OPS_TARGET_')).toBe(true)
    const resolved = await inventory.resolveCredential(ref)
    expect(resolved?.value).toBe('secret')
  })

  it('removes a server record and its credential together', async () => {
    const { ctx, unset } = fakeContext()
    const inventory = new OpsInventory(ctx, PRESET)
    await inventory.start()
    const id = await inventory.addServer({ nickname: 'n', host: 'h', port: 22, username: 'u', environment: 'lab', tags: [] }, 'pw')
    expect(inventory.listServers()).toHaveLength(2)
    const removed = await inventory.removeServer(id)
    expect(removed).toBe(true)
    expect(inventory.listServers()).toHaveLength(1)
    expect(unset).toHaveBeenCalledTimes(1)
  })

  it('adds and removes database targets with their credentials', async () => {
    const { ctx, set, unset } = fakeContext()
    const inventory = new OpsInventory(ctx, PRESET)
    await inventory.start()
    const id = await inventory.addDb({
      nickname: 'orders',
      kind: 'mysql',
      host: '203.0.113.30',
      port: 3306,
      database: 'orders',
      username: 'app',
      environment: 'prod',
      tags: [],
    }, 'dbpw')
    const dbs = inventory.listDbs()
    expect(dbs).toHaveLength(1)
    expect(dbs[0]?.nickname).toBe('orders')
    expect(dbs[0]?.kind).toBe('mysql')
    expect(set).toHaveBeenCalledTimes(1)
    await inventory.removeDb(id)
    expect(inventory.listDbs()).toHaveLength(0)
    expect(unset).toHaveBeenCalledTimes(1)
  })

  it('resolves an unknown server id with a clear error', () => {
    const { ctx } = fakeContext()
    const inventory = new OpsInventory(ctx, PRESET)
    expect(() => inventory.serverById('missing')).toThrow(/Unknown server id/)
  })
})
