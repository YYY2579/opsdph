/**
 * Proves the ops server results flow through the generic spill policy: with
 * `spill-policy` and a `spill-local` backend composed, an oversized
 * `server_list` result is saved whole to the spill store and the model sees a
 * bounded preview plus the locator; a within-cap result stays inline. No ops
 * code is added for this — the post-execute waterfall of the composed
 * composition is the integration point.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
import LocalSpillStore from '@deepseek-ai/dsh-spill-local'
import * as SpillPolicy from '@deepseek-ai/dsh-spill-policy'
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

/** Ten long-named servers: enough rendered text to exceed a 256-byte inline cap. */
const INVENTORY = Array.from({ length: 10 }, (_, index) => [
  `      - id: edge-${index.toString().padStart(2, '0')}`,
  `        name: Edge node number ${index} for the production fleet`,
  `        host: 203.0.113.${index + 10}`,
  `        username: deploy-${index}`,
  `        keyRef: /home/deploy/.ssh/id_ed25519_${index}`,
  `        environment: ${index % 2 === 0 ? 'prod' : 'lab'}`,
  `        tags: [nginx, edge, fleet-${index}]`,
].join('\n')).flat()

/**
 * Boot a cordis.yml carrying spill-local, spill-policy, and the ops-server
 * plugin.
 * @param maxInlineBytes - the spill-policy inline cap for plain-text results.
 * @returns the booted context and the configured spill root.
 */
async function boot(maxInlineBytes: number): Promise<{ ctx: Context; spillRoot: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-ops-spill-'))
  const spillRoot = join(root, 'spills')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-spill-local'",
    '  config:',
    `    root: ${JSON.stringify(spillRoot.replace(/\\/g, '/'))}`,
    '    cleanupPeriodDays: 0',
    "- name: '@deepseek-ai/dsh-spill-policy'",
    '  config:',
    `    maxInlineBytes: ${maxInlineBytes}`,
    "- name: '@deepseek-ai/dsh-ops-server'",
    '  config:',
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
    ['@deepseek-ai/dsh-spill-local', LocalSpillStore],
    ['@deepseek-ai/dsh-spill-policy', SpillPolicy],
    ['@deepseek-ai/dsh-ops-server', OpsServer],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return { ctx, spillRoot }
}

/** A fake agent whose session carries the id the spill owner needs. */
function spillAgent(): object {
  const id = SessionId('sess-ops-spill')
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

/** The spill file locator a spill notice points at, or undefined. */
function spillLocator(text: string): string | undefined {
  const marker = 'stored at: '
  const at = text.indexOf(marker)
  if (at < 0) return undefined
  const after = text.slice(at + marker.length)
  return after.split('. Use read with')[0]
}

describe('ops-server results through the composed spill policy', () => {
  it('spills an oversized server_list result and stores the full text', async () => {
    const { ctx, spillRoot } = await boot(256)
    const result = await ctx.tools.execute({
      callId: ToolCallId('list-spill'),
      name: 'server_list',
      arguments: {},
      agent: spillAgent() as never,
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(false)
    const text = textOf(result)
    const locator = spillLocator(text)
    expect(locator).toBeDefined()
    if (locator === undefined) throw new Error('spill notice without a locator')
    expect(locator.startsWith(spillRoot)).toBe(true)
    expect(text).not.toContain('Managed servers:')
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(256)
    expect(await readFile(locator, 'utf8')).toContain('Managed servers:')
  }, 30_000)

  it('keeps a within-cap server_list result inline', async () => {
    const { ctx } = await boot(100_000)
    const result = await ctx.tools.execute({
      callId: ToolCallId('list-inline'),
      name: 'server_list',
      arguments: {},
      agent: spillAgent() as never,
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(false)
    const text = textOf(result)
    expect(text).toContain('Managed servers:')
    expect(text).not.toContain('Full formatted result stored at:')
  }, 30_000)
})
