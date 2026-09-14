/**
 * Database connectivity of the ops capability: direct connections to MySQL,
 * Redis, and PostgreSQL for connection tests and bounded read-only queries.
 * Credentials are resolved by the caller and passed per operation; nothing is
 * cached or logged. Output is bounded by the same ceiling the SSH transport
 * applies, and truncation is reported explicitly.
 * @module @deepseek-ai/dsh-ops-server/db
 */

import mysql from 'mysql2/promise'
import { Client as PgClient } from 'pg'
import { Redis } from 'ioredis'
import type { DbKind } from '@deepseek-ai/dsh-ops-common'

/** One resolved connection request; the caller owns credential resolution. */
export interface DbConnectionRequest {
  readonly kind: DbKind
  readonly host: string
  readonly port: number
  /** Database name; empty for Redis. */
  readonly database: string
  /** Login user; empty for Redis. */
  readonly username: string
  readonly password: string
  readonly timeoutMs: number
  /** Retained-output ceiling in characters for query results. */
  readonly maxOutputChars: number
}

/** Outcome of a connection test. */
export type DbTestResult =
  | { readonly ok: true; readonly detail: string }
  | { readonly ok: false; readonly error: string }

/** Bounded outcome of one read-only query. */
export interface DbQueryResult {
  readonly stdout: string
  readonly truncated: boolean
  readonly durationMs: number
}

/** Bound one string to the retained ceiling, reporting truncation. */
function bound(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  return { text: text.slice(0, max), truncated: true }
}

/**
 * Test one database connection with a single round-trip probe.
 * @param request - the resolved connection request.
 * @returns success with a server detail line, or failure with the cause.
 */
export async function testDbConnection(request: DbConnectionRequest): Promise<DbTestResult> {
  try {
    const detail = await withTimeout(request.timeoutMs, async () => {
      switch (request.kind) {
        case 'mysql': {
          const conn = await mysql.createConnection({
            host: request.host,
            port: request.port,
            user: request.username,
            password: request.password,
            connectTimeout: request.timeoutMs,
            ...(request.database !== '' ? { database: request.database } : {}),
          })
          try {
            const [rows] = await conn.query('SELECT 1 AS ok')
            return `MySQL connected; SELECT 1 -> ${JSON.stringify(rows)}`
          } finally {
            await conn.end()
          }
        }
        case 'postgres': {
          const client = new PgClient({
            host: request.host,
            port: request.port,
            password: request.password,
            connectionTimeoutMillis: request.timeoutMs,
            ...(request.database !== '' ? { database: request.database } : {}),
            ...(request.username !== '' ? { user: request.username } : {}),
          })
          try {
            await client.connect()
            const result = await client.query('SELECT 1 AS ok')
            return `PostgreSQL connected; SELECT 1 -> ${JSON.stringify(result.rows)}`
          } finally {
            await client.end()
          }
        }
        case 'redis': {
          const redis = new Redis({
            host: request.host,
            port: request.port,
            connectTimeout: request.timeoutMs,
            lazyConnect: true,
            maxRetriesPerRequest: 1,
            ...(request.password !== '' ? { password: request.password } : {}),
          })
          try {
            await redis.connect()
            const pong = await redis.ping()
            return `Redis connected; PING -> ${pong}`
          } finally {
            redis.disconnect()
          }
        }
      }
    })
    return { ok: true, detail }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Run one bounded read-only database command.
 * @param request - the resolved connection request.
 * @param command - read-only command text (SQL for MySQL/PostgreSQL, a Redis
 *   command line for Redis).
 * @returns the bounded command output.
 */
export async function runDbQuery(request: DbConnectionRequest, command: string): Promise<DbQueryResult> {
  const startedAt = Date.now()
  try {
    const raw = await withTimeout(request.timeoutMs, async () => {
      switch (request.kind) {
        case 'mysql': {
          const conn = await mysql.createConnection({
            host: request.host,
            port: request.port,
            user: request.username,
            password: request.password,
            connectTimeout: request.timeoutMs,
            ...(request.database !== '' ? { database: request.database } : {}),
          })
          try {
            const [rows] = await conn.query({ sql: command, rowsAsArray: false })
            return JSON.stringify(rows, null, 2)
          } finally {
            await conn.end()
          }
        }
        case 'postgres': {
          const client = new PgClient({
            host: request.host,
            port: request.port,
            password: request.password,
            connectionTimeoutMillis: request.timeoutMs,
            ...(request.database !== '' ? { database: request.database } : {}),
            ...(request.username !== '' ? { user: request.username } : {}),
          })
          try {
            await client.connect()
            const result = await client.query(command)
            return JSON.stringify(result.rows, null, 2)
          } finally {
            await client.end()
          }
        }
        case 'redis': {
          const redis = new Redis({
            host: request.host,
            port: request.port,
            connectTimeout: request.timeoutMs,
            lazyConnect: true,
            maxRetriesPerRequest: 1,
            ...(request.password !== '' ? { password: request.password } : {}),
          })
          try {
            await redis.connect()
            const tokens = command.trim().split(/\s+/)
            const verb = tokens[0]
            if (verb === undefined || verb === '') throw new Error('redis command is empty')
            const args = tokens.slice(1)
            const reply = await redis.call(verb, ...args)
            return JSON.stringify(reply, null, 2)
          } finally {
            redis.disconnect()
          }
        }
      }
    })
    const { text, truncated } = bound(raw, request.maxOutputChars)
    return { stdout: text, truncated, durationMs: Date.now() - startedAt }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { stdout: `Error: ${message}`, truncated: false, durationMs: Date.now() - startedAt }
  }
}

/** Race one async operation against a timeout and reject when it expires. */
async function withTimeout<T>(timeoutMs: number, operation: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`database operation timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
