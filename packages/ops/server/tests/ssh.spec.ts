/**
 * Pins the remote-command transport contract without a real SSH server: the
 * argument list carries the resolved target and never invents interactive
 * prompts, retained output stops at the configured ceiling, and both the
 * timeout and an abort kill the client and report which one ended it.
 */

import { describe, expect, it } from 'vitest'
import { buildSshArgs, buildSshInvocation, runRemoteCommand } from '../src/ssh.ts'
import type { SshChild } from '../src/ssh.ts'

interface FakeChild {
  readonly child: SshChild
  readonly killed: () => boolean
  readonly data: (text: string) => void
  readonly close: (code: number | null) => void
}

function createFakeChild(): FakeChild {
  const dataListeners: ((chunk: Buffer) => void)[] = []
  const closeListeners: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = []
  const state = { killed: false }
  const child = {
    stdout: {
      on: (_event: 'data', listener: (chunk: Buffer) => void): unknown => {
        dataListeners.push(listener)
        return undefined
      },
    },
    stderr: { on: (): unknown => undefined },
    on: (
      event: 'error' | 'close',
      listener: ((error: Error) => void) | ((code: number | null, signal: NodeJS.Signals | null) => void),
    ): unknown => {
      if (event === 'error') return undefined
      closeListeners.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void)
      return undefined
    },
    kill: (): boolean => {
      state.killed = true
      return true
    },
  }
  return {
    child: child as unknown as SshChild,
    killed: () => state.killed,
    data: (text) => {
      for (const listener of dataListeners) listener(Buffer.from(text, 'utf8'))
    },
    close: (code) => {
      for (const listener of closeListeners) listener(code, null)
    },
  }
}

const REQUEST = {
  host: '203.0.113.10',
  port: 22,
  username: 'deploy',
  command: 'uptime',
  timeoutMs: 30_000,
  maxOutputBytes: 1024,
} as const

describe('ssh argument construction', () => {
  it('targets the resolved server and disables interactive prompts', () => {
    expect(buildSshArgs(REQUEST)).toEqual([
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ConnectTimeout=30',
      '-p', '22',
      'deploy@203.0.113.10',
      'uptime',
    ])
  })

  it('adds the identity file only when the inventory declares one', () => {
    const args = buildSshArgs({ ...REQUEST, keyRef: 'C:\\keys\\ops' })
    expect(args).toContain('-i')
    expect(args[args.indexOf('-i') + 1]).toBe('C:\\keys\\ops')
    expect(buildSshArgs({ ...REQUEST, keyRef: '' })).not.toContain('-i')
  })

  it('never derives a connect timeout below one second', () => {
    expect(buildSshArgs({ ...REQUEST, timeoutMs: 250 })).toContain('ConnectTimeout=1')
  })

  it('routes a password through sshpass and a key through ssh directly', () => {
    const withPassword = buildSshInvocation({ ...REQUEST, password: 'pw' })
    expect(withPassword.executable).toBe('sshpass')
    expect(withPassword.args[0]).toBe('-p')
    expect(withPassword.args[1]).toBe('pw')
    expect(withPassword.args[2]).toBe('ssh')
    expect(buildSshInvocation(REQUEST).executable).toBe('ssh')
  })
})

describe('remote command outcome', () => {
  it('returns the exit status and retained output', async () => {
    const fake = createFakeChild()
    const pending = runRemoteCommand({ ...REQUEST }, () => fake.child)
    fake.data('hello')
    fake.close(0)
    const result = await pending
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('hello')
    expect(result.truncated).toBe(false)
    expect(result.timedOut).toBe(false)
  })

  it('stops retained output at the ceiling and reports truncation', async () => {
    const fake = createFakeChild()
    const pending = runRemoteCommand({ ...REQUEST, maxOutputBytes: 10 }, () => fake.child)
    fake.data('0123456789abcdef')
    fake.close(0)
    const result = await pending
    expect(result.stdout).toBe('0123456789')
    expect(result.truncated).toBe(true)
  })

  it('kills the client at the timeout and marks the result', async () => {
    const fake = createFakeChild()
    const pending = runRemoteCommand({ ...REQUEST, timeoutMs: 5 }, () => fake.child)
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(fake.killed()).toBe(true)
    fake.close(null)
    const result = await pending
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBeNull()
  })

  it('kills the client when the caller aborts', async () => {
    const fake = createFakeChild()
    const controller = new AbortController()
    const pending = runRemoteCommand({ ...REQUEST, signal: controller.signal }, () => fake.child)
    controller.abort()
    expect(fake.killed()).toBe(true)
    fake.close(null)
    const result = await pending
    expect(result.cancelled).toBe(true)
  })
})
