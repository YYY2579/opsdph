/**
 * Pins the settings-surface service: probe-before-persist is enforced (a
 * failed probe persists nothing), list views never carry credential content,
 * and key-vs-password records keep their authentication kind apart.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { OpsInventory } from '../src/inventory.ts'
import type { ServerEntryConfig } from '../src/inventory.ts'
import { OpsServerService } from '../src/service.ts'
import type { DbInputWire, ServerInputWire } from '@deepseek-ai/dsh-ops-common'

const PRESET: readonly ServerEntryConfig[] = []

/** A real Cordis context whose credentials seam is mocked and storage-domain is absent. */
function fakeContext(): { ctx: Context; set: ReturnType<typeof vi.fn>; unset: ReturnType<typeof vi.fn> } {
  const set = vi.fn()
  const unset = vi.fn()
  const resolve = vi.fn()
  const ctx = new Context()
  ctx.provide('credentials', { set, unset, resolve } as never)
  return { ctx, set, unset }
}

vi.mock('../src/ssh.ts', () => ({
  runRemoteCommand: vi.fn(),
}))

vi.mock('../src/db.ts', () => ({
  testDbConnection: vi.fn(),
}))

import { runRemoteCommand } from '../src/ssh.ts'
import { testDbConnection } from '../src/db.ts'

const mockedRun = vi.mocked(runRemoteCommand)
const mockedTestDb = vi.mocked(testDbConnection)

function serverInput(overrides: Partial<ServerInputWire> = {}): ServerInputWire {
  return {
    nickname: 'lab box',
    host: '203.0.113.20',
    port: 22,
    username: 'ops',
    auth: { kind: 'key', keyPath: 'C:\\keys\\ops' },
    environment: 'lab',
    tags: [],
    ...overrides,
  }
}

function dbInput(overrides: Partial<DbInputWire> = {}): DbInputWire {
  return {
    nickname: 'orders',
    kind: 'mysql',
    host: '203.0.113.30',
    port: 3306,
    database: 'orders',
    username: 'app',
    password: 'dbpw',
    environment: 'prod',
    tags: [],
    ...overrides,
  }
}

beforeEach(() => {
  mockedRun.mockReset()
  mockedTestDb.mockReset()
})

describe('OpsServerService server surface', () => {
  it('persists a server only after a successful key probe and keeps the key path', async () => {
    const { ctx } = fakeContext()
    const inventory = new OpsInventory(ctx, PRESET)
    await inventory.start()
    const service = new OpsServerService(ctx, inventory, { commandTimeoutMs: 1000, maxOutputBytes: 1024 })
    mockedRun.mockResolvedValue({
      exitCode: 0, stdout: 'ok', stderr: '', durationMs: 5, truncated: false, timedOut: false, cancelled: false,
    })

    const { id } = await service.addServer(serverInput())

    expect(mockedRun).toHaveBeenCalledWith(expect.objectContaining({ keyRef: 'C:\\keys\\ops', password: '' }))
    const view = service.listServers().find(candidate => candidate.id === id)
    expect(view?.auth).toEqual({ kind: 'key', keyPath: 'C:\\keys\\ops' })
    expect(JSON.stringify(service.listServers())).not.toContain('dbpw')
  })

  it('stores a password under a credential reference and projects only its kind', async () => {
    const { ctx } = fakeContext()
    const inventory = new OpsInventory(ctx, PRESET)
    await inventory.start()
    const service = new OpsServerService(ctx, inventory, { commandTimeoutMs: 1000, maxOutputBytes: 1024 })
    mockedRun.mockResolvedValue({
      exitCode: 0, stdout: 'ok', stderr: '', durationMs: 5, truncated: false, timedOut: false, cancelled: false,
    })

    const { id } = await service.addServer(serverInput({ auth: { kind: 'password', password: 'pw' } }))

    expect(mockedRun).toHaveBeenCalledWith(expect.objectContaining({ password: 'pw', keyRef: '' }))
    const view = service.listServers().find(candidate => candidate.id === id)
    expect(view?.auth).toEqual({ kind: 'password' })
    expect(JSON.stringify(service.listServers())).not.toContain('pw')
  })

  it('refuses to persist a server whose probe failed', async () => {
    const { ctx, set } = fakeContext()
    const inventory = new OpsInventory(ctx, PRESET)
    await inventory.start()
    const service = new OpsServerService(ctx, inventory, { commandTimeoutMs: 1000, maxOutputBytes: 1024 })
    mockedRun.mockResolvedValue({
      exitCode: 255, stdout: '', stderr: 'Permission denied', durationMs: 5, truncated: false, timedOut: false, cancelled: false,
    })

    await expect(service.addServer(serverInput({ auth: { kind: 'password', password: 'bad' } })))
      .rejects.toThrow(/connection test failed/)

    expect(service.listServers()).toHaveLength(0)
    expect(set).not.toHaveBeenCalled()
  })
})

describe('OpsServerService database surface', () => {
  it('persists a database only after a successful probe', async () => {
    const { ctx } = fakeContext()
    const inventory = new OpsInventory(ctx, PRESET)
    await inventory.start()
    const service = new OpsServerService(ctx, inventory, { commandTimeoutMs: 1000, maxOutputBytes: 1024 })
    mockedTestDb.mockResolvedValue({ ok: true, detail: 'MySQL connected; SELECT 1 -> [{"ok":1}]' })

    const { id } = await service.addDb(dbInput())

    const view = service.listDbs().find(candidate => candidate.id === id)
    expect(view?.nickname).toBe('orders')
    expect(view?.kind).toBe('mysql')
    expect(JSON.stringify(service.listDbs())).not.toContain('dbpw')
  })

  it('refuses to persist a database whose probe failed', async () => {
    const { ctx } = fakeContext()
    const inventory = new OpsInventory(ctx, PRESET)
    await inventory.start()
    const service = new OpsServerService(ctx, inventory, { commandTimeoutMs: 1000, maxOutputBytes: 1024 })
    mockedTestDb.mockResolvedValue({ ok: false, error: 'connect ECONNREFUSED' })

    await expect(service.addDb(dbInput())).rejects.toThrow(/connection test failed/)
    expect(service.listDbs()).toHaveLength(0)
  })

  it('removes a managed server and database by id', async () => {
    const { ctx } = fakeContext()
    const inventory = new OpsInventory(ctx, PRESET)
    await inventory.start()
    const service = new OpsServerService(ctx, inventory, { commandTimeoutMs: 1000, maxOutputBytes: 1024 })
    mockedRun.mockResolvedValue({
      exitCode: 0, stdout: 'ok', stderr: '', durationMs: 5, truncated: false, timedOut: false, cancelled: false,
    })
    mockedTestDb.mockResolvedValue({ ok: true, detail: 'connected' })

    const server = await service.addServer(serverInput())
    const db = await service.addDb(dbInput())
    expect(await service.removeServer(server.id)).toBe(true)
    expect(await service.removeServer(server.id)).toBe(false)
    expect(await service.removeDb(db.id)).toBe(true)
    expect(await service.removeDb(db.id)).toBe(false)
  })
})
