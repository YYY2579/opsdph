/**
 * Opt-in end-to-end acceptance against a real managed server. Skipped unless
 * `OPS_E2E_HOST` is set, so the suite stays green without a VPS. Run with:
 *
 * ```powershell
 * $env:OPS_E2E_HOST='156.224.28.147'
 * pnpm exec vitest run packages/ops/server/tests/e2e-vps.spec.ts
 * ```
 *
 * Optional overrides: `OPS_E2E_USER` (default `root`), `OPS_E2E_KEY` (default
 * `~/.ssh/id_ed25519`), `OPS_E2E_ENV` (default `lab`). The machine is a
 * dedicated test host; the only mutation performed is an approved
 * `systemctl restart nginx`.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import UserApproval from '@deepseek-ai/dsh-user-approval'
import { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import * as OpsServer from '@deepseek-ai/dsh-ops-server'

const host = process.env.OPS_E2E_HOST

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const USER = process.env.OPS_E2E_USER ?? 'root'
const KEY_REF = process.env.OPS_E2E_KEY ?? join(homedir(), '.ssh', 'id_ed25519')
const ENVIRONMENT = process.env.OPS_E2E_ENV ?? 'lab'

/** The acceptance server entry for the real host. */
const SERVER = [
  '      - id: vps-01',
  `        name: Acceptance VPS (${host})`,
  `        host: ${host}`,
  '        port: 22',
  `        username: ${USER}`,
  `        keyRef: ${KEY_REF}`,
  `        environment: ${ENVIRONMENT}`,
  '        tags: [acceptance]',
]

/**
 * Boot a cordis.yml carrying the ops-server plugin for the acceptance host,
 * optionally with the approval service.
 * @param withApproval - whether `@deepseek-ai/dsh-user-approval` is mounted.
 * @param commandTimeoutMs - per-command hard timeout.
 * @returns the booted context.
 */
async function boot(withApproval: boolean, commandTimeoutMs = 30_000): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-ops-e2e-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    ...withApproval ? ["- name: '@deepseek-ai/dsh-user-approval'"] : [],
    "- name: '@deepseek-ai/dsh-ops-server'",
    '  config:',
    `    commandTimeoutMs: ${commandTimeoutMs}`,
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

/** A fake agent whose session sits mid-turn for the approval audit pair. */
function testAgent(): object {
  const id = SessionId('sess-ops-e2e')
  const events: Array<{ type: string; seq: ReturnType<typeof SessionSeq>; time: number; data: Record<string, unknown> }> = [
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

/** Narrow a successful tool result to the bounded command-outcome fields. */
function commandValue(result: ToolExecutionResult): {
  exitCode: number | null
  timedOut?: boolean
  cancelled?: boolean
} {
  if (result.isError) throw new Error('expected a successful tool result')
  return result.value as { exitCode: number | null; timedOut?: boolean; cancelled?: boolean }
}

function execCall(toolName: string, callLabel: string, args: Record<string, unknown>, signal: AbortSignal, agent?: object) {
  return {
    callId: ToolCallId(`e2e-${callLabel}`),
    name: toolName,
    arguments: args,
    ...agent !== undefined ? { agent: agent as never } : {},
    signal,
  }
}

describe.skipIf(host === undefined)('ops-server end-to-end acceptance on a real VPS', () => {
  it('scenario A: server_list and server_facts report the real host without exposing the key reference', async () => {
    const ctx = await boot(false)
    const listed = await ctx.tools.execute(execCall('server_list', 'list', {}, new AbortController().signal))
    expect(listed.isError).toBe(false)
    expect(textOf(listed)).toContain('vps-01')

    const facts = await ctx.tools.execute(execCall('server_facts', 'facts', { serverId: 'vps-01' }, new AbortController().signal))
    expect(facts.isError).toBe(false)
    const factsText = textOf(facts)
    expect(factsText).toMatch(/Mem:|Filesystem|load average/)
    expect(factsText).not.toContain(KEY_REF)
    expect(commandValue(facts).exitCode).toBe(0)
  }, 60_000)

  it('scenario A: read-only server_exec runs without any approval and changes nothing', async () => {
    const ctx = await boot(false)
    const result = await ctx.tools.execute(execCall(
      'server_exec',
      'exec-read',
      { serverId: 'vps-01', command: 'nginx -t' },
      new AbortController().signal,
    ))
    expect(result.isError).toBe(false)
    expect(commandValue(result).exitCode).toBe(0)
    expect(textOf(result)).not.toContain(KEY_REF)
  }, 60_000)

  it('scenario B: an approved restart executes and the health check passes', async () => {
    const ctx = await boot(true)
    let consulted = false
    ctx.on('approval/request', () => {
      consulted = true
      return Promise.resolve('allowed-once' as const)
    })
    const restarted = await ctx.tools.execute(execCall(
      'server_exec',
      'exec-restart',
      { serverId: 'vps-01', command: 'systemctl restart nginx' },
      new AbortController().signal,
      testAgent(),
    ))
    expect(consulted).toBe(true)
    expect(restarted.isError).toBe(false)
    expect(commandValue(restarted).exitCode).toBe(0)

    const health = await ctx.tools.execute(execCall(
      'server_exec',
      'exec-health',
      { serverId: 'vps-01', command: 'systemctl is-active nginx' },
      new AbortController().signal,
    ))
    expect(health.isError).toBe(false)
    expect(textOf(health).trim()).toBe('active')
  }, 60_000)

  it('scenario B: a rejected restart never executes and the service timestamp is unchanged', async () => {
    const ctx = await boot(true)
    ctx.on('approval/request', () => Promise.resolve('rejected' as const))
    const before = await ctx.tools.execute(execCall(
      'server_exec',
      'exec-timestamp-before',
      { serverId: 'vps-01', command: 'systemctl show nginx -p ActiveEnterTimestamp --value' },
      new AbortController().signal,
    ))
    expect(before.isError).toBe(false)

    const denied = await ctx.tools.execute(execCall(
      'server_exec',
      'exec-restart-denied',
      { serverId: 'vps-01', command: 'systemctl restart nginx' },
      new AbortController().signal,
      testAgent(),
    ))
    expect(denied.isError).toBe(true)
    expect(textOf(denied)).toMatch(/rejected/)

    const after = await ctx.tools.execute(execCall(
      'server_exec',
      'exec-timestamp-after',
      { serverId: 'vps-01', command: 'systemctl show nginx -p ActiveEnterTimestamp --value' },
      new AbortController().signal,
    ))
    expect(after.isError).toBe(false)
    expect(textOf(after)).toBe(textOf(before))
  }, 60_000)

  it('cancels a long-running command on the real host', async () => {
    const ctx = await boot(false)
    const controller = new AbortController()
    const run = ctx.tools.execute(execCall(
      'server_exec',
      'exec-sleep-cancel',
      { serverId: 'vps-01', command: 'sleep 30' },
      controller.signal,
    ))
    setTimeout(() => controller.abort(), 300)
    const result = await run
    // The registry owns caller cancellation: the aborted call settles as an
    // AbortError result while the transport has already killed the ssh client.
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/aborted/)
    // The remote command actually terminated: no `sleep 30` process survives.
    const orphans = await ctx.tools.execute(execCall(
      'server_exec',
      'exec-sleep-check',
      { serverId: 'vps-01', command: "ps -eo pid,comm,args | grep -F 'sleep 30' | grep -v grep" },
      new AbortController().signal,
    ))
    expect(orphans.isError).toBe(false)
    expect(textOf(orphans)).not.toContain('sleep 30')
  }, 60_000)

  it('times out a long-running command on the real host', async () => {
    const ctx = await boot(false, 1500)
    const result = await ctx.tools.execute(execCall(
      'server_exec',
      'exec-sleep-timeout',
      { serverId: 'vps-01', command: 'sleep 10' },
      new AbortController().signal,
    ))
    expect(result.isError).toBe(false)
    expect(commandValue(result).timedOut).toBe(true)
    expect(commandValue(result).exitCode).toBeNull()
  }, 60_000)
})
