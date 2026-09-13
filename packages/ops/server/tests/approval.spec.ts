/**
 * Proves the ops risk gate through the real Loader: a mutating `server_exec`
 * asks through the approval seam and only runs on `allowed-once`, a rejection
 * or a missing approval channel never executes it, and a read-only call runs
 * without any approval infrastructure. The SSH transport is not mocked; the
 * tests address an unroutable TEST-NET host with a one-second connect budget,
 * so the assertions target the decision, not the connection.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import UserApproval from '@deepseek-ai/dsh-user-approval'
import { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import * as OpsServer from '@deepseek-ai/dsh-ops-server'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const SERVER = [
  '      - id: lab-db-01',
  '        name: Lab database 01',
  '        host: 203.0.113.20',
  '        username: ops',
  '        keyRef: lab-db-01-key',
  '        environment: lab',
  '        tags: [database]',
]

/**
 * Boot a cordis.yml carrying the ops-server plugin, optionally with the
 * approval service. The command budget is one second so an unroutable TEST-NET
 * host settles quickly without ever being reachable.
 * @param withApproval - whether `@deepseek-ai/dsh-user-approval` is mounted.
 * @returns the booted context.
 */
async function boot(withApproval: boolean): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-ops-approval-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    ...withApproval ? ["- name: '@deepseek-ai/dsh-user-approval'"] : [],
    "- name: '@deepseek-ai/dsh-ops-server'",
    '  config:',
    '    commandTimeoutMs: 1000',
    '    servers:',
    ...SERVER,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-ops-server', OpsServer],
  ])
  if (withApproval) modules.set('@deepseek-ai/dsh-user-approval', UserApproval)
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

/**
 * A fake agent whose session sits mid-turn, so the approval audit pair can
 * append. Mirrors the pattern the sandboxed tool-fs tests use for `ask`.
 * @returns an agent-shaped value for the tool execution input.
 */
function testAgent(): object {
  const id = SessionId('sess-ops-approval')
  const events: Array<{
    type: string
    seq: ReturnType<typeof SessionSeq>
    time: number
    data: Record<string, unknown>
  }> = [
    { type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } },
  ]
  return {
    id,
    session: {
      id,
      header: { version: 0, id, createdAt: 0, cwd: '/', isSeeded: false },
      inheritedEventCount: SessionLogOffset(0),
      firstLiveSeq: SessionLogOffset(0),
      get seq() { return SessionLogOffset(events.length) },
      eventAt: (seq: ReturnType<typeof SessionSeq>) => events[seq],
      snapshotEvents: (
        fromSeq = SessionLogOffset(0),
        toSeqExclusive = SessionLogOffset(events.length),
      ) => events.slice(fromSeq, toSeqExclusive),
      append: (type: string, data: Record<string, unknown>) => {
        const event = { type, seq: SessionSeq(events.length), time: events.length, data }
        events.push(event)
        return event
      },
    },
  }
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** Denial vocabulary of the registry's ask resolution, absent only when a call ran. */
const DENIAL = /requires approval|rejected|no approval channel|no agent to route/

describe('ops-server approval gate through a real Loader composition', () => {
  it('runs a provably read-only server_exec without any approval service', async () => {
    const ctx = await boot(false)
    const result = await ctx.tools.execute({
      callId: ToolCallId('exec-read'),
      name: 'server_exec',
      arguments: { serverId: 'lab-db-01', command: 'cat /etc/hostname' },
      agent: testAgent() as never,
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(false)
    expect(textOf(result)).not.toMatch(DENIAL)
  }, 30_000)

  it('asks and runs a mutating server_exec after approval', async () => {
    const ctx = await boot(true)
    let consulted = false
    ctx.on('approval/request', () => {
      consulted = true
      return Promise.resolve('allowed-once' as const)
    })
    const result = await ctx.tools.execute({
      callId: ToolCallId('exec-mutate'),
      name: 'server_exec',
      arguments: { serverId: 'lab-db-01', command: 'touch /tmp/ops-approval-marker' },
      agent: testAgent() as never,
      signal: new AbortController().signal,
    })
    expect(consulted).toBe(true)
    expect(result.isError).toBe(false)
    expect(textOf(result)).not.toMatch(DENIAL)
  }, 30_000)

  it('rejects a mutating server_exec and never runs it', async () => {
    const ctx = await boot(true)
    let consulted = false
    ctx.on('approval/request', () => {
      consulted = true
      return Promise.resolve('rejected' as const)
    })
    const result = await ctx.tools.execute({
      callId: ToolCallId('exec-rejected'),
      name: 'server_exec',
      arguments: { serverId: 'lab-db-01', command: 'touch /tmp/ops-approval-marker' },
      agent: testAgent() as never,
      signal: new AbortController().signal,
    })
    expect(consulted).toBe(true)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/rejected/)
  }, 30_000)

  it('fails closed when the approval service is composed but no answerer is', async () => {
    const ctx = await boot(true)
    const result = await ctx.tools.execute({
      callId: ToolCallId('exec-no-answerer'),
      name: 'server_exec',
      arguments: { serverId: 'lab-db-01', command: 'touch /tmp/ops-approval-marker' },
      agent: testAgent() as never,
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/no approval channel is available/)
  }, 30_000)

  it('fails closed when no approval service is composed', async () => {
    const ctx = await boot(false)
    const result = await ctx.tools.execute({
      callId: ToolCallId('exec-no-approval'),
      name: 'server_exec',
      arguments: { serverId: 'lab-db-01', command: 'touch /tmp/ops-approval-marker' },
      agent: testAgent() as never,
      signal: new AbortController().signal,
    })
    // Without an approval service the ask becomes a denial carrying the ask's
    // reason; the call never reaches the transport.
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/classified L1/)
    expect(textOf(result)).not.toMatch(/Connection timed out/)
  }, 30_000)

  it('fails closed when a mutating call has no agent to route the ask', async () => {
    const ctx = await boot(true)
    let consulted = false
    ctx.on('approval/request', () => {
      consulted = true
      return Promise.resolve('allowed-once' as const)
    })
    const result = await ctx.tools.execute({
      callId: ToolCallId('exec-no-agent'),
      name: 'server_exec',
      arguments: { serverId: 'lab-db-01', command: 'touch /tmp/ops-approval-marker' },
      signal: new AbortController().signal,
    })
    expect(consulted).toBe(false)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/no agent to route/)
  }, 30_000)

  it('denies an unresolvable target before asking anyone', async () => {
    const ctx = await boot(true)
    let consulted = false
    ctx.on('approval/request', () => {
      consulted = true
      return Promise.resolve('allowed-once' as const)
    })
    const result = await ctx.tools.execute({
      callId: ToolCallId('exec-unknown'),
      name: 'server_exec',
      arguments: { serverId: 'missing-01', command: 'touch /tmp/x' },
      agent: testAgent() as never,
      signal: new AbortController().signal,
    })
    expect(consulted).toBe(false)
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/Unknown server id/)
  }, 30_000)
})
