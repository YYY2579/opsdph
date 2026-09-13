/**
 * Shared ops domain types plus the runtime sets and branding helpers that keep
 * the type-level unions and the parsed configuration in agreement.
 * @module @deepseek-ai/dsh-ops-common
 */

import { brandString } from '@deepseek-ai/dsh-brand'
import type { ServerId } from './types.ts'

export type * from './types.ts'

/** The environment classes an inventory entry may declare, as a runtime set for config narrowing. */
export const ENVIRONMENTS = ['dev', 'staging', 'prod', 'lab'] as const

/** The risk levels an ops operation may carry, ascending from read-only to destructive. */
export const RISK_LEVELS = ['L0', 'L1', 'L2', 'L3', 'L4'] as const

/**
 * Brand one inventory-declared server id.
 * @param value - id declared by the owning inventory.
 * @returns the same string carrying the ops server brand.
 */
export function brandServerId(value: string): ServerId {
  return brandString<ServerId>(value)
}
