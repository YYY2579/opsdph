import type { Branded } from '@deepseek-ai/dsh-brand'

/** Environment class of one managed target. */
export type Environment = 'dev' | 'staging' | 'prod' | 'lab'

/** Risk classification of one ops operation, from read-only to destructive. */
export type RiskLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4'

/** Opaque identity of one managed server. */
export type ServerId = Branded<'OpsServerId'>

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
