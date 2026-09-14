/**
 * Managed-target inventory of the ops capability. The inventory merges the
 * read-only deployment configuration (the servers declared in the plugin
 * Config) with durable user records persisted through `ctx.storage`
 * (storage-domain); database targets live only in the durable store. No
 * secret value is stored here: every record carries a credential reference
 * whose value resolves through `ctx.credentials` at connect time.
 * @module @deepseek-ai/dsh-ops-server/inventory
 */

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, KvTable, TableKeyOf, TableValueOf } from '@deepseek-ai/dsh-storage-domain'
import type { DbKind, Environment, OpsDbTarget, OpsServer } from '@deepseek-ai/dsh-ops-common'
import { brandDbId, brandServerId } from '@deepseek-ai/dsh-ops-common'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { ResolvedCredential } from '@deepseek-ai/dsh-credentials'

/** One managed server exactly as deployment configuration declares it. */
export interface ServerEntryConfig {
  id: string
  name: string
  host: string
  port: number
  username: string
  keyRef: string
  environment: Environment
  tags: string[]
}

/** Durable record of one user-managed server. */
export interface StoredServerRecord {
  readonly id: string
  readonly nickname: string
  readonly host: string
  readonly port: number
  readonly username: string
  /** Path of the OpenSSH private key when the record authenticates by key; '' otherwise. */
  readonly keyRef: string
  /** Credential reference for the password, or '' when key-based auth is used. */
  readonly credRef: string
  readonly environment: Environment
  readonly tags: readonly string[]
}

/** Durable record of one user-managed database target. */
export interface StoredDbRecord {
  readonly id: string
  readonly nickname: string
  readonly kind: DbKind
  readonly host: string
  readonly port: number
  readonly database: string
  readonly username: string
  readonly credRef: string
  readonly environment: Environment
  readonly tags: readonly string[]
}

/** Input for adding a server through the settings surface or a tool. */
export interface ServerInput {
  readonly nickname: string
  readonly host: string
  readonly port: number
  readonly username: string
  /** Path of the OpenSSH private key; a password-record leaves it absent. */
  readonly keyPath?: string
  readonly environment: Environment
  readonly tags: readonly string[]
}

/** Input for adding a database target through the settings surface or a tool. */
export interface DbInput {
  readonly nickname: string
  readonly kind: DbKind
  readonly host: string
  readonly port: number
  readonly database: string
  readonly username: string
  readonly environment: Environment
  readonly tags: readonly string[]
}

/** One stored record shape, discriminated by kind. */
export type StoredRecord = StoredServerRecord | StoredDbRecord

const serverSchema = z.object({
  id: z.string().min(1),
  nickname: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().positive(),
  username: z.string().min(1),
  keyRef: z.string(),
  credRef: z.string(),
  environment: z.enum(['dev', 'staging', 'prod', 'lab']),
  tags: z.array(z.string()),
})

const dbSchema = z.object({
  id: z.string().min(1),
  nickname: z.string().min(1),
  kind: z.enum(['mysql', 'redis', 'postgres']),
  host: z.string().min(1),
  port: z.number().int().positive(),
  database: z.string(),
  username: z.string(),
  credRef: z.string(),
  environment: z.enum(['dev', 'staging', 'prod', 'lab']),
  tags: z.array(z.string()),
})

/** The ops inventory domain: one durable table per target kind. */
export const OPS_INVENTORY_DOMAIN = defineDomain({
  name: 'ops_inventory',
  version: 1,
  tables: {
    servers: domainTable<string, StoredServerRecord>(serverSchema),
    dbs: domainTable<string, StoredDbRecord>(dbSchema),
  },
})

type ServersTable = KvTable<TableKeyOf<typeof OPS_INVENTORY_DOMAIN, 'servers'>, TableValueOf<typeof OPS_INVENTORY_DOMAIN, 'servers'>>
type DbsTable = KvTable<TableKeyOf<typeof OPS_INVENTORY_DOMAIN, 'dbs'>, TableValueOf<typeof OPS_INVENTORY_DOMAIN, 'dbs'>>

/** Credential-reference prefix for ops-managed targets; the id keeps it unique. */
const CRED_PREFIX = 'OPS_TARGET'

/**
 * Credential reference for one target id. The reference must satisfy the
 * credentials namespace grammar, so hyphens in the uuid become underscores.
 * @param id - the target's stable id.
 * @returns the branded credential reference under which its secret is stored.
 */
function credRefOf(id: string): string {
  return credentialRef(`${CRED_PREFIX}_${id.replace(/-/gu, '_')}`)
}

/**
 * The ops target inventory. Durable when `storage-domain` is mounted; a
 * session-scoped memory fallback keeps the capability usable without it.
 */
export class OpsInventory {
  private domain: Domain<typeof OPS_INVENTORY_DOMAIN> | undefined
  private serversTable: ServersTable | undefined
  private dbsTable: DbsTable | undefined
  private readonly memoryServers = new Map<string, StoredServerRecord>()
  private readonly memoryDbs = new Map<string, StoredDbRecord>()

  /**
   * @param ctx - context whose storage and credentials seams the inventory uses.
   * @param preset - servers declared by deployment configuration (read-only base layer).
   */
  constructor(
    private readonly ctx: Context,
    private readonly preset: readonly ServerEntryConfig[],
  ) {}

  /** Open the durable inventory domain when `storage-domain` is mounted. */
  async start(): Promise<void> {
    const facility = this.ctx.get('storageDomain')
    if (facility === undefined) return
    this.domain = await facility.open(OPS_INVENTORY_DOMAIN)
    this.serversTable = this.domain.table('servers')
    this.dbsTable = this.domain.table('dbs')
  }

  private storedServers(): Map<string, StoredServerRecord> {
    if (this.serversTable !== undefined) {
      const map = new Map<string, StoredServerRecord>()
      for (const [key, record] of this.serversTable.entries()) map.set(key, record)
      return map
    }
    return this.memoryServers
  }

  private storedDbs(): Map<string, StoredDbRecord> {
    if (this.dbsTable !== undefined) {
      const map = new Map<string, StoredDbRecord>()
      for (const [key, record] of this.dbsTable.entries()) map.set(key, record)
      return map
    }
    return this.memoryDbs
  }

  /**
   * Every managed server: configured preset entries first, then durable user
   * records (user ids win on collision). The model-facing projection omits the
   * credential reference.
   * @returns the merged server list.
   */
  listServers(): OpsServer[] {
    const presets = this.preset.map(entry => ({
      id: brandServerId(entry.id),
      name: entry.name,
      host: entry.host,
      port: entry.port,
      username: entry.username,
      keyRef: entry.keyRef,
      environment: entry.environment,
      tags: [...entry.tags],
    }))
    const ids = new Set<string>(presets.map(server => server.id))
    const stored = [...this.storedServers().values()]
      .filter(record => !ids.has(record.id))
      .map(record => ({
        id: brandServerId(record.id),
        name: record.nickname,
        host: record.host,
        port: record.port,
        username: record.username,
        keyRef: record.keyRef !== '' ? record.keyRef : record.credRef,
        environment: record.environment,
        tags: [...record.tags],
      }))
    return [...presets, ...stored]
  }

  /**
   * Every managed database target.
   * @returns the durable database list.
   */
  listDbs(): OpsDbTarget[] {
    return [...this.storedDbs().values()].map(record => ({
      id: brandDbId(record.id),
      nickname: record.nickname,
      kind: record.kind,
      host: record.host,
      port: record.port,
      database: record.database,
      username: record.username,
      credRef: record.credRef,
      environment: record.environment,
      tags: [...record.tags],
    }))
  }

  /**
   * Resolve one server by the id the model passed.
   * @param id - model-supplied server id.
   * @returns the matching server.
   * @throws Error when no managed server carries the id.
   */
  serverById(id: string): OpsServer {
    const found = this.listServers().find(server => server.id === id)
    if (found === undefined) throw new Error(`Unknown server id: ${id}. Call server_list for the configured ids.`)
    return found
  }

  /**
   * Resolve one database target by the id the model passed.
   * @param id - model-supplied database id.
   * @returns the matching target.
   * @throws Error when no managed database carries the id.
   */
  dbById(id: string): OpsDbTarget {
    const found = this.listDbs().find(db => db.id === id)
    if (found === undefined) throw new Error(`Unknown database id: ${id}. Call db_list for the configured ids.`)
    return found
  }

  private async persistServers(map: Map<string, StoredServerRecord>, key: string, record: StoredServerRecord): Promise<void> {
    if (this.serversTable !== undefined) await this.serversTable.put(key, record)
    else map.set(key, record)
  }

  private async persistDbs(map: Map<string, StoredDbRecord>, key: string, record: StoredDbRecord): Promise<void> {
    if (this.dbsTable !== undefined) await this.dbsTable.put(key, record)
    else map.set(key, record)
  }

  /**
   * Add one server: mint a stable id, store the password (when given) under a
   * credential reference, persist the record, and keep the private-key path
   * when the record authenticates by key.
   * @param input - server fields from the settings surface or a tool.
   * @param password - optional password; key-based auth resolves when absent.
   * @returns the new server id.
   */
  async addServer(input: ServerInput, password?: string): Promise<string> {
    const id = randomUUID()
    const keyPath = input.keyPath ?? ''
    const usesPassword = password !== undefined && password !== ''
    if (usesPassword) {
      await this.ctx.credentials.set(credentialRef(credRefOf(id)), password)
    }
    const record: StoredServerRecord = {
      id,
      nickname: input.nickname,
      host: input.host,
      port: input.port,
      username: input.username,
      keyRef: keyPath,
      credRef: usesPassword ? credRefOf(id) : '',
      environment: input.environment,
      tags: [...input.tags],
    }
    await this.persistServers(this.memoryServers, id, record)
    return id
  }

  /**
   * Remove one user-managed server and its credential.
   * @param id - the stable server id.
   * @returns whether a user-managed record was removed.
   */
  async removeServer(id: string): Promise<boolean> {
    const map = this.storedServers()
    const record = map.get(id)
    if (record === undefined) return false
    if (record.credRef !== '') await this.ctx.credentials.unset(credentialRef(record.credRef))
    if (this.serversTable !== undefined) await this.serversTable.delete(id)
    else map.delete(id)
    return true
  }

  /**
   * Add one database target: mint a stable id, store the password under a
   * credential reference, and persist the record.
   * @param input - database fields from the settings surface or a tool.
   * @param password - the database password.
   * @returns the new database id.
   */
  async addDb(input: DbInput, password: string): Promise<string> {
    const id = randomUUID()
    const credRef = credRefOf(id)
    await this.ctx.credentials.set(credentialRef(credRef), password)
    const record: StoredDbRecord = { id, ...input, credRef, tags: [...input.tags] }
    await this.persistDbs(this.memoryDbs, id, record)
    return id
  }

  /**
   * Remove one database target and its credential.
   * @param id - the stable database id.
   * @returns whether a record was removed.
   */
  async removeDb(id: string): Promise<boolean> {
    const map = this.storedDbs()
    const record = map.get(id)
    if (record === undefined) return false
    await this.ctx.credentials.unset(credentialRef(record.credRef))
    if (this.dbsTable !== undefined) await this.dbsTable.delete(id)
    else map.delete(id)
    return true
  }

  /**
   * Resolve one target's stored credential value.
   * @param credRef - the credential reference a record carries.
   * @returns the resolved secret, or `undefined` when unconfigured.
   */
  resolveCredential(credRef: string): Promise<ResolvedCredential | undefined> {
    if (credRef === '') return Promise.resolve(undefined)
    return this.ctx.credentials.resolve(credentialRef(credRef))
  }
}
