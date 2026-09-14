/**
 * Host owner of the `ops` Remote namespace: the settings-surface controller of
 * the ops capability. Every method delegates to the `opsServer` Cordis service
 * that the ops-server plugin registers, so the namespace is present whenever the
 * plugin is composed and reports `ops/absent` with a corrective message when it
 * is not. Wire inputs may carry a secret toward the host; no method here ever
 * returns one.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/src/ops.ts
 */

import { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  DbInputWire, OpsDbView, OpsProbeResult, OpsServerView, ServerInputWire,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `ops` Remote namespace. */
    opsController: OpsController
  }
}

/**
 * The `opsServer` service surface this controller delegates to. Structural, so
 * the controller never imports the ops-server plugin's runtime — the plugin is
 * composed externally and its absence is a first-class Remote failure.
 */
interface OpsServerSurface {
  listServers(): OpsServerView[]
  listDbs(): OpsDbView[]
  testServer(input: ServerInputWire): Promise<OpsProbeResult>
  testDb(input: DbInputWire): Promise<OpsProbeResult>
  addServer(input: ServerInputWire): Promise<{ readonly id: string }>
  addDb(input: DbInputWire): Promise<{ readonly id: string }>
  removeServer(id: string): Promise<boolean>
  removeDb(id: string): Promise<boolean>
}

/**
 * Host service backing the generated `ctx.remote.ops` namespace. The probe and
 * persist operations run on the host, exactly where the ops plugin lives; the
 * persist methods keep the plugin's "probe before persist" rule.
 */
export class OpsController extends TypertRemoteService {
  /** @param ctx - Host context where the ops-server plugin may be composed. */
  constructor(ctx: Context) {
    super(ctx, 'opsController', { namespace: 'ops' })
  }

  /** Every managed server, projected without credential content. */
  @Remote
  listServers(): OpsServerView[] {
    return this.ops().listServers()
  }

  /** Every managed database target, projected without credential content. */
  @Remote
  listDbs(): OpsDbView[] {
    return this.ops().listDbs()
  }

  /**
   * Probe one prospective server before it is saved.
   * @param input - the server exactly as the settings form holds it.
   * @returns success with a detail line, or failure with the cause.
   */
  @Remote
  testServer(input: ServerInputWire): Promise<OpsProbeResult> {
    return this.ops().testServer(input)
  }

  /**
   * Probe one prospective database target before it is saved.
   * @param input - the target exactly as the settings form holds it.
   * @returns success with the engine reply, or failure with the cause.
   */
  @Remote
  testDb(input: DbInputWire): Promise<OpsProbeResult> {
    return this.ops().testDb(input)
  }

  /**
   * Save one server; the plugin refuses to persist a target whose probe failed.
   * @param input - the server, normally the one the settings form just probed.
   * @returns the new server id.
   */
  @Remote
  addServer(input: ServerInputWire): Promise<{ readonly id: string }> {
    return this.ops().addServer(input)
  }

  /**
   * Save one database target; the plugin refuses to persist a target whose
   * probe failed.
   * @param input - the target, normally the one the settings form just probed.
   * @returns the new database id.
   */
  @Remote
  addDb(input: DbInputWire): Promise<{ readonly id: string }> {
    return this.ops().addDb(input)
  }

  /**
   * Remove one managed server and its stored credential.
   * @param id - the stable server id from {@link listServers}.
   * @returns whether a record was removed.
   */
  @Remote
  removeServer(id: string): Promise<boolean> {
    return this.ops().removeServer(id)
  }

  /**
   * Remove one managed database target and its stored credential.
   * @param id - the stable database id from {@link listDbs}.
   * @returns whether a record was removed.
   */
  @Remote
  removeDb(id: string): Promise<boolean> {
    return this.ops().removeDb(id)
  }

  /** Resolve the ops-server plugin service or report how to supply it. */
  private ops(): OpsServerSurface {
    const service = this.ctx.get('opsServer') as OpsServerSurface | undefined
    if (service === undefined) {
      throw new RemoteError(
        'ops/absent',
        'ops-server plugin is not installed or disabled: add @deepseek-ai/dsh-ops-server in the plugin settings and restart before managing servers or databases',
        {},
      )
    }
    return service
  }
}

export default OpsController
