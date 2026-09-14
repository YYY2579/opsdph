import type { Branded } from '@deepseek-ai/dsh-brand'

/** Environment class of one managed target. */
export type Environment = 'dev' | 'staging' | 'prod' | 'lab'

/** Risk classification of one ops operation, from read-only to destructive. */
export type RiskLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4'

/** Opaque identity of one managed server. */
export type ServerId = Branded<'OpsServerId'>

/** Opaque identity of one managed database target. */
export type DbId = Branded<'OpsDbId'>

/** Database engine of one managed database target. */
export type DbKind = 'mysql' | 'redis' | 'postgres'

/** One managed server as the ops capability holds it internally. */
export interface OpsServer {
  /** Stable identity every model-facing server operation addresses. */
  readonly id: ServerId
  /** Human-readable name, unique within one inventory. */
  readonly name: string
  readonly host: string
  readonly port: number
  readonly username: string
  /** Credential reference resolved at connect time; never a secret value. */
  readonly keyRef: string
  readonly environment: Environment
  readonly tags: readonly string[]
}

/** One managed database target as the ops capability holds it internally. */
export interface OpsDbTarget {
  /** Stable identity every model-facing database operation addresses. */
  readonly id: DbId
  /** User-chosen name; natural-language handle for the agent and the settings UI. */
  readonly nickname: string
  readonly kind: DbKind
  readonly host: string
  readonly port: number
  /** Database name on the engine (unused for Redis). */
  readonly database: string
  /** Login user (unused for Redis). */
  readonly username: string
  /** Credential reference resolved at connect time; never a secret value. */
  readonly credRef: string
  readonly environment: Environment
  readonly tags: readonly string[]
}

/** Stable failure categories one ops operation reports to its caller. */
export type OpsErrorCode =
  | 'invalid-target'
  | 'unreachable'
  | 'auth'
  | 'timeout'
  | 'cancelled'
  | 'denied'
  | 'command-failed'

/** Failure of one ops operation. */
export interface OpsError {
  readonly code: OpsErrorCode
  readonly message: string
}

/** Successful outcome of one ops operation. */
export interface OpsSuccess<T> {
  readonly ok: true
  readonly value: T
  readonly durationMs: number
}

/** Failed outcome of one ops operation. */
export interface OpsFailure {
  readonly ok: false
  readonly error: OpsError
  readonly durationMs: number
}

/** Outcome of one ops operation, discriminated by `ok`. */
export type OpsResult<T> = OpsSuccess<T> | OpsFailure

/** Authentication of one server as the settings surface or the Remote layer passes it. */
export type ServerAuthWire =
  | { readonly kind: 'key'; readonly keyPath: string }
  | { readonly kind: 'password'; readonly password: string }

/** One server add request from the settings surface; the password, when chosen, crosses the wire once. */
export interface ServerInputWire {
  /** User-chosen name; natural-language handle for the agent and the settings UI. */
  readonly nickname: string
  readonly host: string
  readonly port: number
  readonly username: string
  readonly auth: ServerAuthWire
  readonly environment: Environment
  readonly tags: readonly string[]
}

/** One database add request from the settings surface; the password crosses the wire once. */
export interface DbInputWire {
  readonly nickname: string
  readonly kind: DbKind
  readonly host: string
  readonly port: number
  readonly database: string
  readonly username: string
  readonly password: string
  readonly environment: Environment
  readonly tags: readonly string[]
}

/** One managed server as the settings surface lists it; never carries a credential value. */
export interface OpsServerView {
  readonly id: string
  readonly nickname: string
  readonly host: string
  readonly port: number
  readonly username: string
  /** Authentication kind of the stored record; a key record keeps its path, a password record no value. */
  readonly auth: { readonly kind: 'key'; readonly keyPath: string } | { readonly kind: 'password' }
  readonly environment: Environment
  readonly tags: readonly string[]
}

/** One managed database target as the settings surface lists it; never carries a credential value. */
export interface OpsDbView {
  readonly id: string
  readonly nickname: string
  readonly kind: DbKind
  readonly host: string
  readonly port: number
  readonly database: string
  readonly username: string
  readonly environment: Environment
  readonly tags: readonly string[]
}

/** Outcome of one connection probe from the settings surface. */
export interface OpsProbeResult {
  readonly ok: boolean
  readonly detail: string
}
