/**
 * Proves the managed-server inventory is real configuration rather than a
 * constant: the plugin boots as a function plugin through the real Loader from
 * a cordis.yml, `server_list` reports exactly the configured servers, the
 * model-facing projection omits the credential reference, and a composition
 * that omits `servers` fails to load.
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
import * as OpsServer from '@deepseek-ai/dsh-ops-server'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const INVENTORY = [
  '      - id: prod-web-01',
  '        name: Production web 01',
  '        host: 203.0.113.10',
  '        username: deploy',
  '        keyRef: prod-web-01-key',
  '        environment: prod',
  '        tags: [nginx, edge]',
  '      - id: lab-db-01',
  '        name: Lab database 01',
  '        host: 203.0.113.20',
  '        port: 2222',
  '        username: ops',
  '        keyRef: lab-db-01-key',
  '        environment: lab',
]

/**
 * Boot a cordis.yml carrying the given ops-server configuration.
 * @param configLines - YAML lines nested under the plugin's `config:` key.
 * @returns the booted context.
 */
async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-ops-server-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-ops-server'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
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

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('ops-server real Loader composition through cordis.yml', () => {
  it('lists the configured servers without exposing credential references', async () => {
    const ctx = await boot(['    servers:', ...INVENTORY])
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('list-all'),
      name: 'server_list',
      arguments: {},
    })
    expect(result.isError).toBe(false)
    if (result.isError !== false) throw new Error('server_list failed')
    expect(result.value).toEqual({
      servers: [
        {
          id: 'prod-web-01',
          name: 'Production web 01',
          host: '203.0.113.10',
          port: 22,
          username: 'deploy',
          environment: 'prod',
          tags: ['nginx', 'edge'],
        },
        {
          id: 'lab-db-01',
          name: 'Lab database 01',
          host: '203.0.113.20',
          port: 2222,
          username: 'ops',
          environment: 'lab',
          tags: [],
        },
      ],
    })
    expect(textOf(result)).toContain('prod-web-01')
    expect(textOf(result)).not.toContain('prod-web-01-key')
  }, 30_000)

  it('narrows the listing to one environment', async () => {
    const ctx = await boot(['    servers:', ...INVENTORY])
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('list-lab'),
      name: 'server_list',
      arguments: { environment: 'lab' },
    })
    expect(result.isError).toBe(false)
    if (result.isError !== false) throw new Error('server_list failed')
    expect(result.value).toEqual({
      servers: [{
        id: 'lab-db-01',
        name: 'Lab database 01',
        host: '203.0.113.20',
        port: 2222,
        username: 'ops',
        environment: 'lab',
        tags: [],
      }],
    })
  }, 30_000)

  it('fails loading when the inventory is omitted', async () => {
    let failure: unknown
    try {
      await boot([])
    } catch (error) {
      failure = error
    }
    expect(failure).toBeDefined()
    expect(String(failure)).toMatch(/servers/)
  }, 30_000)
})
