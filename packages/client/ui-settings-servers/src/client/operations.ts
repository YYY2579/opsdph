/**
 * The Host ops reads and writes the Servers & Databases section performs, as
 * callbacks built in the plugin body. The section receives these instead of a
 * context; every outcome names what a card renders (a stored list, a probe
 * verdict, a refusal message), so the Remote codes stay in the apply world.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {
  DbInputWire, OpsDbView, OpsProbeResult, OpsServerView, ServerInputWire,
} from '@deepseek-ai/dsh-api-remotes/client'

/** One Remote refusal projected to a user-facing message. */
function messageOf(response: { readonly error: { readonly message: string } }): string {
  return response.error.message
}

/** What one managed-target listing answered. */
export type OpsListOutcome<T> =
  /** The targets the ops plugin currently manages. */
  | { readonly kind: 'loaded'; readonly value: T[] }
  /** The ops-server plugin is not composed; the section shows the corrective hint. */
  | { readonly kind: 'absent' }
  /** The listing was refused, with the Host's own diagnostic. */
  | { readonly kind: 'refused'; readonly message: string }

/** The Host operations the section invokes. */
export interface OpsOperations {
  /** Every managed server, projected without credential content. */
  listServers(): Promise<OpsListOutcome<OpsServerView>>
  /** Every managed database target, projected without credential content. */
  listDbs(): Promise<OpsListOutcome<OpsDbView>>
  /** Probe one not-yet-saved server. */
  testServer(input: ServerInputWire): Promise<OpsProbeResult>
  /** Probe one not-yet-saved database target. */
  testDb(input: DbInputWire): Promise<OpsProbeResult>
  /** Save one server (the plugin refuses a target whose probe failed). */
  addServer(input: ServerInputWire): Promise<string | undefined>
  /** Save one database target (the plugin refuses a target whose probe failed). */
  addDb(input: DbInputWire): Promise<string | undefined>
  /** Remove one managed server. */
  removeServer(id: string): Promise<string | undefined>
  /** Remove one managed database target. */
  removeDb(id: string): Promise<string | undefined>
}

/**
 * Bind the section's Host operations to the `ops` Remote namespace.
 * @param ctx - the page plugin's context, which declares `remote.ops`.
 * @returns the callbacks the section is injected with.
 */
export function createOpsOperations(ctx: ClientContext): OpsOperations {
  const listOutcome = <T>(
    response:
      | { readonly ok: true; readonly value: T[] }
      | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } },
  ): OpsListOutcome<T> => {
    if (response.ok) return { kind: 'loaded', value: response.value }
    return response.error.code === 'ops/absent'
      ? { kind: 'absent' }
      : { kind: 'refused', message: response.error.message }
  }
  return {
    listServers: async () => {
      const response = await ctx.remote.ops.listServers()
      return listOutcome(response)
    },
    listDbs: async () => {
      const response = await ctx.remote.ops.listDbs()
      return listOutcome(response)
    },
    testServer: async (input) => {
      const response = await ctx.remote.ops.testServer(input)
      return response.ok ? response.value : { ok: false, detail: messageOf(response) }
    },
    testDb: async (input) => {
      const response = await ctx.remote.ops.testDb(input)
      return response.ok ? response.value : { ok: false, detail: messageOf(response) }
    },
    addServer: async (input) => {
      const response = await ctx.remote.ops.addServer(input)
      return response.ok ? undefined : messageOf(response)
    },
    addDb: async (input) => {
      const response = await ctx.remote.ops.addDb(input)
      return response.ok ? undefined : messageOf(response)
    },
    removeServer: async (id) => {
      const response = await ctx.remote.ops.removeServer(id)
      return response.ok ? undefined : messageOf(response)
    },
    removeDb: async (id) => {
      const response = await ctx.remote.ops.removeDb(id)
      return response.ok ? undefined : messageOf(response)
    },
  }
}
