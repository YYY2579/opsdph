/**
 * Cordis service of the ops capability: the surface the settings UI and its
 * Remote controller call. It owns the "probe before persist" rule — a server or
 * database is saved only after its connection probe succeeds — and projects
 * every list view without credential content. Secret values enter only as a
 * probe/save input and leave only as a credential reference in the inventory.
 * @module @deepseek-ai/dsh-ops-server/service
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type {
  DbInputWire, OpsDbView, OpsProbeResult, OpsServerView,
  ServerAuthWire, ServerInputWire,
} from '@deepseek-ai/dsh-ops-common'
import { testDbConnection } from './db.ts'
import { OpsInventory } from './inventory.ts'
import { runRemoteCommand } from './ssh.ts'

/** Resolved credentials of one server auth choice; one of the two is always empty. */
interface ResolvedAuth {
  readonly keyRef: string
  readonly password: string
}

/** Split one wire auth into the transport's resolved fields. */
function authOf(auth: ServerAuthWire): ResolvedAuth {
  return auth.kind === 'key'
    ? { keyRef: auth.keyPath, password: '' }
    : { keyRef: '', password: auth.password }
}

/** The credential-reference prefix the inventory mints for password records. */
const CREDENTIAL_PREFIX = 'OPS_TARGET_'

/** Runtime options the service needs beyond the inventory. */
export interface OpsServiceOptions {
  readonly commandTimeoutMs: number
  readonly maxOutputBytes: number
}

/**
 * Named service `opsServer`, registered on the owning Cordis scope. Absent
 * when the ops-server plugin is not composed; the Remote controller that
 * fronts it reports that absence explicitly.
 */
export class OpsServerService extends Service<OpsServiceOptions> {
  /**
   * @param ctx - owning Cordis context; the service registers as `opsServer`.
   * @param inventory - the durable managed-target inventory.
   * @param options - transport ceilings from the validated plugin configuration.
   */
  constructor(
    ctx: Context,
    private readonly inventory: OpsInventory,
    private readonly options: OpsServiceOptions,
  ) {
    super(ctx, 'opsServer')
  }

  /** Every managed server, projected without credential content. */
  listServers(): OpsServerView[] {
    return this.inventory.listServers().map(server => ({
      id: server.id,
      nickname: server.name,
      host: server.host,
      port: server.port,
      username: server.username,
      auth: server.keyRef.startsWith(CREDENTIAL_PREFIX)
        ? { kind: 'password' }
        : { kind: 'key', keyPath: server.keyRef },
      environment: server.environment,
      tags: [...server.tags],
    }))
  }

  /** Every managed database target, projected without credential content. */
  listDbs(): OpsDbView[] {
    return this.inventory.listDbs().map(db => ({
      id: db.id,
      nickname: db.nickname,
      kind: db.kind,
      host: db.host,
      port: db.port,
      database: db.database,
      username: db.username,
      environment: db.environment,
      tags: [...db.tags],
    }))
  }

  /**
   * Probe one not-yet-saved server: an SSH round trip returning `ok`.
   * @param input - the prospective server, exactly as the settings form holds it.
   * @returns success with a detail line, or failure with the cause.
   */
  async testServer(input: ServerInputWire): Promise<OpsProbeResult> {
    const { keyRef, password } = authOf(input.auth)
    try {
      const result = await runRemoteCommand({
        host: input.host,
        port: input.port,
        username: input.username,
        keyRef,
        password,
        command: 'printf ok',
        timeoutMs: this.options.commandTimeoutMs,
        maxOutputBytes: this.options.maxOutputBytes,
      })
      const ok = result.exitCode === 0 && result.stdout.trim() === 'ok'
      return ok
        ? { ok: true, detail: `SSH connected to ${input.username}@${input.host}:${input.port}` }
        : { ok: false, detail: result.stderr.trim() || `exit ${String(result.exitCode)}` }
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Probe one not-yet-saved database with a single round-trip.
   * @param input - the prospective target, exactly as the settings form holds it.
   * @returns success with the engine reply, or failure with the cause.
   */
  async testDb(input: DbInputWire): Promise<OpsProbeResult> {
    const result = await testDbConnection({
      kind: input.kind,
      host: input.host,
      port: input.port,
      database: input.database,
      username: input.username,
      password: input.password,
      timeoutMs: this.options.commandTimeoutMs,
      maxOutputChars: this.options.maxOutputBytes,
    })
    return result.ok ? { ok: true, detail: result.detail } : { ok: false, detail: result.error }
  }

  /**
   * Save one server only after its connection probe succeeds; the password,
   * when chosen, is stored under a credential reference.
   * @param input - the prospective server.
   * @returns the new server id.
   * @throws Error when the probe fails — nothing is persisted on failure.
   */
  async addServer(input: ServerInputWire): Promise<{ readonly id: string }> {
    const probe = await this.testServer(input)
    if (!probe.ok) throw new Error(`server not saved: connection test failed — ${probe.detail}`)
    const id = await this.inventory.addServer({
      nickname: input.nickname,
      host: input.host,
      port: input.port,
      username: input.username,
      ...(input.auth.kind === 'key' ? { keyPath: input.auth.keyPath } : {}),
      environment: input.environment,
      tags: [...input.tags],
    }, input.auth.kind === 'password' ? input.auth.password : undefined)
    return { id }
  }

  /**
   * Save one database target only after its connection probe succeeds.
   * @param input - the prospective target.
   * @returns the new database id.
   * @throws Error when the probe fails — nothing is persisted on failure.
   */
  async addDb(input: DbInputWire): Promise<{ readonly id: string }> {
    const probe = await this.testDb(input)
    if (!probe.ok) throw new Error(`database not saved: connection test failed — ${probe.detail}`)
    const id = await this.inventory.addDb({
      nickname: input.nickname,
      kind: input.kind,
      host: input.host,
      port: input.port,
      database: input.database,
      username: input.username,
      environment: input.environment,
      tags: [...input.tags],
    }, input.password)
    return { id }
  }

  /**
   * Remove one user-managed server and its stored credential.
   * @param id - the stable server id.
   * @returns whether a record was removed.
   */
  removeServer(id: string): Promise<boolean> {
    return this.inventory.removeServer(id)
  }

  /**
   * Remove one user-managed database target and its stored credential.
   * @param id - the stable database id.
   * @returns whether a record was removed.
   */
  removeDb(id: string): Promise<boolean> {
    return this.inventory.removeDb(id)
  }
}
