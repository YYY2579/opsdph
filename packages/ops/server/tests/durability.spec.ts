/**
 * Durability of the ops model-facing surface. The first block proves replay
 * consistency: the same call reproduces byte-identical model-visible results,
 * the result value is lossless JSON, and an approval ask logs the paired
 * `approval/asked` + `approval/decided` events on the session so a replay can
 * rebuild the decision. The second block proves credentials stay references:
 * neither the model-visible projection nor any appended session event carries
 * the configured key reference.
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

const KEY_REFS = ['/home/deploy/.ssh/id_ed25519', '/home/ops/.ssh/id_lab'] as const

const INVENTORY = [
  '      - id: prod-web-01',
  '        name: Production web 01',
  '        host: 203.0.113.10',
  '        username: deploy',
  `        keyRef: ${KEY_REFS[0]}`,
  '        environment: prod',
  '        tags: [nginx, edge]',
  '      - id: lab-db-01',
  '        name: Lab database 01',
  '        host: 203.0.113.20',
  '        username: ops',
  `        keyRef: ${KEY_REFS[1]}`,
  '        environment: lab',
  '        tags: [database]',
]

/**
 * Boot a cordis.yml carrying the ops-server plugin, optionally with the
 * approval service.
 * @param withApproval - whether `@deepseek-ai/dsh-user-approval` is mounted.
 * @returns the booted context.
 */
async function boot(withApproval: boolean): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-ops-durable-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    ...withApproval ? ["- name: '@deepseek-ai/dsh-user-approval'"] : [],
    "- name: '@deepseek-ai/dsh-ops-server'",
    '  config:',
    '    commandTimeoutMs: 1000',
    '    servers:',
    ...INVENTORY,
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

/** A fake agent whose session sits mid-turn, with its events exposed for assertions. */
function durableAgent(): { agent: object; events: Array<{ type: string; data: Record<string, unknown> }> } {
  const id = SessionId('sess-ops-durable')
  const events: Array<{
    type: string
    seq: ReturnType<typeof SessionSeq>
    time: number
    data: Record<string, unknown>
  }> = [
    { type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 } },
  ]
  const agent = {
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
  return { agent, events }
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

function executeServerList(ctx: Context, agent: object, callId: string) {
  return ctx.tools.execute({
    callId: ToolCallId(callId),
    name: 'server_list',
    arguments: {},
    agent: agent as never,
    signal: new AbortController().signal,
  })
}

describe('ops-server session replay consistency', () => {
  it('reproduces byte-identical model-visible results and lossless JSON values', async () => {
    const ctx = await boot(false)
    const first = await executeServerList(ctx, durableAgent().agent, 'replay-1')
    const second = await executeServerList(ctx, durableAgent().agent, 'replay-2')
    expect(first.isError).toBe(false)
    expect(textOf(first)).toBe(textOf(second))
    expect(first.value).toEqual(second.value)
    expect(JSON.parse(JSON.stringify(first.value))).toEqual(first.value)
  }, 30_000)

  it('logs the approval ask and decision pair so replay can rebuild the ask', async () => {
    const ctx = await boot(true)
    ctx.on('approval/request', () => Promise.resolve('rejected' as const))
    const { agent, events } = durableAgent()
    await ctx.tools.execute({
      callId: ToolCallId('replay-ask'),
      name: 'server_exec',
      arguments: { serverId: 'lab-db-01', command: 'touch /tmp/durable-marker' },
      agent: agent as never,
      signal: new AbortController().signal,
    })
    const asked = events.find(event => event.type === 'approval/asked')
    const decided = events.find(event => event.type === 'approval/decided')
    expect(asked).toBeDefined()
    expect(decided).toBeDefined()
    if (asked === undefined || decided === undefined) throw new Error('approval pair not logged')
    expect(asked.data.toolName).toBe('server_exec')
    expect(String(asked.data.reason)).toMatch(/classified L1/)
    expect(decided.data.outcome).toBe('rejected')
    expect(decided.data.id).toBe(asked.data.id)
  }, 30_000)
})

describe('ops-server credential references stay out of model-visible output', () => {
  it('omits every key reference from the server_list projection and its events', async () => {
    const ctx = await boot(false)
    const { agent, events } = durableAgent()
    const result = await executeServerList(ctx, agent, 'secret-list')
    const visible = textOf(result) + JSON.stringify(events)
    for (const keyRef of KEY_REFS) {
      expect(visible).not.toContain(keyRef)
    }
  }, 30_000)

  it('omits every key reference from the denied-exec projection and its approval events', async () => {
    const ctx = await boot(true)
    ctx.on('approval/request', () => Promise.resolve('rejected' as const))
    const { agent, events } = durableAgent()
    const result = await ctx.tools.execute({
      callId: ToolCallId('secret-exec'),
      name: 'server_exec',
      arguments: { serverId: 'prod-web-01', command: 'touch /tmp/secret-marker' },
      agent: agent as never,
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(true)
    const visible = textOf(result) + JSON.stringify(events)
    for (const keyRef of KEY_REFS) {
      expect(visible).not.toContain(keyRef)
    }
  }, 30_000)
})
