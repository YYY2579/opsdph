import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import OpsController from '../src/ops.ts'
import type {
  DbInputWire, OpsDbView, OpsProbeResult, OpsServerView, ServerInputWire,
} from '../src/types.ts'

/** A minimal opsServer surface the controller delegates to. */
function surface(): {
  readonly record: {
    servers: OpsServerView[]
    dbs: OpsDbView[]
    probes: OpsProbeResult[]
    removed: string[]
  }
  readonly install: (ctx: Context) => void
} {
  const record: {
    servers: OpsServerView[]
    dbs: OpsDbView[]
    probes: OpsProbeResult[]
    removed: string[]
  } = { servers: [], dbs: [], probes: [], removed: [] }
  const ops = {
    listServers: () => record.servers,
    listDbs: () => record.dbs,
    testServer: async (input: ServerInputWire) => {
      const probe: OpsProbeResult = { ok: true, detail: `ok ${input.host}` }
      record.probes.push(probe)
      return probe
    },
    testDb: async (input: DbInputWire) => {
      const probe: OpsProbeResult = { ok: true, detail: `ok ${input.host}` }
      record.probes.push(probe)
      return probe
    },
    addServer: async (input: ServerInputWire) => {
      const id = `server-${record.servers.length}`
      record.servers.push({
        id,
        nickname: input.nickname,
        host: input.host,
        port: input.port,
        username: input.username,
        auth: input.auth.kind === 'key' ? { kind: 'key', keyPath: input.auth.keyPath } : { kind: 'password' },
        environment: input.environment,
        tags: [...input.tags],
      })
      return { id }
    },
    addDb: async (input: DbInputWire) => {
      const id = `db-${record.dbs.length}`
      record.dbs.push({
        id,
        nickname: input.nickname,
        kind: input.kind,
        host: input.host,
        port: input.port,
        database: input.database,
        username: input.username,
        environment: input.environment,
        tags: [...input.tags],
      })
      return { id }
    },
    removeServer: async (id: string) => {
      const index = record.servers.findIndex(server => server.id === id)
      if (index === -1) return false
      record.servers.splice(index, 1)
      record.removed.push(id)
      return true
    },
    removeDb: async (id: string) => {
      const index = record.dbs.findIndex(db => db.id === id)
      if (index === -1) return false
      record.dbs.splice(index, 1)
      record.removed.push(id)
      return true
    },
  }
  return { record, install: (ctx) => { ctx.provide('opsServer', ops as never) } }
}

async function boot(): Promise<{ ctx: Context; controller: OpsController }> {
  const ctx = new Context()
  await ctx.plugin(OpsController)
  return { ctx, controller: ctx.opsController }
}

describe('the ops Remote namespace a configuration surface calls', () => {
  it('publishes the ops namespace from its own service key', async () => {
    const { controller } = await boot()
    const binding = controller.typertRemote
    expect(binding.serviceKey).toBe('opsController')
    expect(binding.namespace).toBe('ops')
    expect(remoteMethods(controller).map(marker => marker.method)).toEqual([
      'listServers', 'listDbs', 'testServer', 'testDb',
      'addServer', 'addDb', 'removeServer', 'removeDb',
    ])
  })

  it('reports the actionable configuration error while the ops-server plugin is absent', async () => {
    const { controller } = await boot()
    const thrown = (call: () => unknown): unknown => {
      try {
        call()
        return undefined
      } catch (error) {
        return error
      }
    }
    expect(remoteErrorOf(thrown(() => controller.listServers()))).toMatchObject({ code: 'ops/absent' })
    expect(remoteErrorOf(thrown(() => controller.listDbs()))).toMatchObject({ code: 'ops/absent' })
    expect(remoteErrorOf(thrown(() => controller.testServer({
      nickname: 'n', host: 'h', port: 22, username: 'u', auth: { kind: 'key', keyPath: 'k' }, environment: 'lab', tags: [],
    })))).toMatchObject({ code: 'ops/absent' })
    expect(remoteErrorOf(thrown(() => controller.testDb({
      nickname: 'n', kind: 'mysql', host: 'h', port: 3306, database: '', username: 'u', password: 'p', environment: 'lab', tags: [],
    })))).toMatchObject({ code: 'ops/absent' })
  })

  it('delegates list, probe, add, and remove to the opsServer service', async () => {
    const { ctx, controller } = await boot()
    const { record, install } = surface()
    install(ctx)

    const added = await controller.addServer({
      nickname: 'lab box', host: '203.0.113.20', port: 22, username: 'ops',
      auth: { kind: 'password', password: 'pw' }, environment: 'lab', tags: [],
    })
    expect(record.servers).toHaveLength(1)
    expect(record.servers[0]?.auth).toEqual({ kind: 'password' })
    expect(await controller.listServers()).toEqual(record.servers)

    const probe = await controller.testDb({
      nickname: 'orders', kind: 'redis', host: '203.0.113.30', port: 6379,
      database: '', username: '', password: 'dbpw', environment: 'prod', tags: [],
    })
    expect(probe.ok).toBe(true)

    const dbId = (await controller.addDb({
      nickname: 'orders', kind: 'postgres', host: '203.0.113.40', port: 5432,
      database: 'orders', username: 'app', password: 'dbpw', environment: 'prod', tags: [],
    })).id
    expect(await controller.listDbs()).toHaveLength(1)
    expect(await controller.removeDb(dbId)).toBe(true)
    expect(await controller.removeServer(added.id)).toBe(true)
    expect(record.removed).toEqual([dbId, added.id])
  })
})
