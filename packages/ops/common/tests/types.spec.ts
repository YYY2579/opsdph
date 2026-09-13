/**
 * Pins the ops vocabulary that capability packages and configuration parsing
 * both rely on: the environment and risk sets stay in the order the schemas
 * declare, and branding a server id preserves the underlying string.
 */

import { describe, expect, it } from 'vitest'
import { ENVIRONMENTS, RISK_LEVELS, brandServerId } from '@deepseek-ai/dsh-ops-common'

describe('ops common vocabulary', () => {
  it('pins the environment set', () => {
    expect([...ENVIRONMENTS]).toEqual(['dev', 'staging', 'prod', 'lab'])
  })

  it('pins the risk levels, ascending from read-only to destructive', () => {
    expect([...RISK_LEVELS]).toEqual(['L0', 'L1', 'L2', 'L3', 'L4'])
  })

  it('brands a server id without changing the value', () => {
    expect(brandServerId('prod-web-01')).toBe('prod-web-01')
  })
})
