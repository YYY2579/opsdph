/**
 * Managed-server inventory and the model-facing read-only server tools of the
 * ops capability. The inventory is deployment configuration; every advertised
 * server carries a stable branded id that later ops operations address, and the
 * model-facing projection omits every credential reference.
 * @module @deepseek-ai/dsh-ops-server
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ENVIRONMENTS, brandServerId } from '@deepseek-ai/dsh-ops-common'
import type { Environment, OpsServer } from '@deepseek-ai/dsh-ops-common'
import { DEFAULT_MAX_OUTPUT_BYTES, runRemoteCommand } from './ssh.ts'
import type { RemoteCommandResult } from './ssh.ts'
import { classifyCommandRisk } from './risk.ts'

export const name = 'ops-server'
export const inject = ['tools']

/** One managed server exactly as deployment configuration declares it. */
export interface ServerEntryConfig {
  id: string
  name: string
  host: string
  port: number
  username: string
  keyRef: string
  environment: Environment
  tags: string[]
}

/** Deployment configuration of the ops server capability. */
export interface Config {
  servers: ServerEntryConfig[]
  commandTimeoutMs: number
  maxOutputBytes: number
  /** Default ceiling on the lines `server_file_read` returns when the model passes none. */
  maxReadLines: number
}

/** Schemastery configuration for the managed-server inventory. */
export const Config: z<Config> = z.object({
  servers: z.array(z.object({
    id: z.string().required(),
    name: z.string().required(),
    host: z.string().required(),
    port: z.number().step(1).min(1).max(65535).default(22),
    username: z.string().required(),
    keyRef: z.string().required(),
    environment: z.union([...ENVIRONMENTS]).required(),
    tags: z.array(z.string()).default([]),
  })).required(),
  commandTimeoutMs: z.number().step(1).min(1000).default(30_000),
  maxOutputBytes: z.number().step(1).min(1024).default(DEFAULT_MAX_OUTPUT_BYTES),
  maxReadLines: z.number().step(1).min(1).default(1000),
})

const LIST_DESCRIPTION =
  'List the servers this deployment manages. Each entry reports the stable id, name, '
  + 'address, login user, environment, and tags. Use the returned id — never the name — '
  + 'to address the server in later operations. Pass environment to narrow the listing.'

const FACTS_DESCRIPTION =
  'Read operating-system identity, uptime, memory, disk usage, and load average from one '
  + 'managed server. Read-only: the command list is fixed by this deployment and takes no '
  + 'model-supplied shell text. Pass the server id from server_list.'

/**
 * The fixed read-only command behind `server_facts`. Commands are separated so
 * one missing tool cannot suppress the rest of the report.
 */
const FACTS_COMMAND = [
  'printf "== os ==\\n"',
  'head -n 2 /etc/os-release 2>/dev/null',
  'printf "== uptime ==\\n"',
  'uptime',
  'printf "== memory ==\\n"',
  'free -m',
  'printf "== disk ==\\n"',
  'df -hP',
  'printf "== load ==\\n"',
  'cat /proc/loadavg',
].join('; ')

const FILE_READ_DESCRIPTION =
  'Read the first lines of one file on a managed server. Read-only and automatic: '
  + 'the command is fixed to `cat` and takes no model-supplied shell text. '
  + 'Pass the server id from server_list and the absolute path to read.'

const EXEC_DESCRIPTION =
  'Run one shell command on a managed server and return its bounded output. '
  + 'Provably read-only commands run automatically; any other command requires '
  + 'approval, and a denied or unavailable approval never runs it. Use for '
  + 'diagnosis; do not attempt destructive work.'

/** Ops tool names whose whole operation is fixed and read-only. */
const FIXED_READ_ONLY_TOOLS = new Set(['server_list', 'server_facts', 'server_file_read'])

/**
 * Build the fixed read-only command behind `server_file_read`: `cat` of the
 * single-quoted path, limited to the first lines.
 * @param path - the absolute path to read.
 * @param maxLines - the line ceiling already clamped to the deployment default.
 * @returns the remote command line.
 */
function buildReadCommand(path: string, maxLines: number): string {
  const quoted = `'${path.replace(/'/g, '\'\\\'\'')}'`
  return `cat -- ${quoted} | head -n ${maxLines}`
}

/**
 * Build the internal inventory record of one configured server.
 * @param entry - one server entry from deployment configuration.
 * @returns the same server carrying a branded id.
 */
function toOpsServer(entry: ServerEntryConfig): OpsServer {
  return {
    id: brandServerId(entry.id),
    name: entry.name,
    host: entry.host,
    port: entry.port,
    username: entry.username,
    keyRef: entry.keyRef,
    environment: entry.environment,
    tags: entry.tags,
  }
}

/**
 * Resolve one inventory entry by the id the model passed.
 * @param inventory - every configured server.
 * @param id - model-supplied server id.
 * @returns the matching server.
 * @throws Error when no configured server carries the id.
 */
function requireServer(inventory: readonly OpsServer[], id: string): OpsServer {
  const found = inventory.find(server => server.id === id)
  if (found === undefined) {
    throw new Error(`Unknown server id: ${id}. Call server_list for the configured ids.`)
  }
  return found
}

/**
 * Project one transport outcome onto the fields the model receives.
 * @param server - the addressed server.
 * @param result - bounded transport outcome.
 * @returns the model-facing result value.
 */
function toFactsValue(server: OpsServer, result: RemoteCommandResult): {
  serverId: string
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  cancelled: boolean
  truncated: boolean
} {
  return {
    serverId: server.id,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    truncated: result.truncated,
  }
}

/**
 * Register the ops server tools on the calling context.
 * @param ctx - context whose tool registry receives the contribution.
 * @param config - validated deployment configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const inventory = config.servers.map(toOpsServer)

  // The single enforcement point of the ops risk policy: fixed read-only tools
  // run; a mutating `server_exec` asks through the tool runtime's approval seam,
  // which fails closed when no approval service, answerer, or agent is composed;
  // unknown ops tools and unresolvable calls are denied. Schema omission or
  // prompt text is never the enforcement — this listener decides.
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!exec.name.startsWith('server_')) return next()
    if (FIXED_READ_ONLY_TOOLS.has(exec.name)) return next()
    if (exec.name !== 'server_exec') {
      return { kind: 'deny', reason: `Unknown ops tool "${exec.name}": refused to run.` }
    }
    const args = exec.arguments as { serverId?: unknown; command?: unknown } | null
    const serverId = args !== null && typeof args === 'object' ? args.serverId : undefined
    const command = args !== null && typeof args === 'object' ? args.command : undefined
    if (typeof serverId !== 'string') {
      return { kind: 'deny', reason: 'server_exec requires a serverId string.' }
    }
    if (typeof command !== 'string') {
      return { kind: 'deny', reason: 'server_exec requires a command string.' }
    }
    let server: OpsServer
    try {
      server = requireServer(inventory, serverId)
    } catch (error) {
      return { kind: 'deny', reason: error instanceof Error ? error.message : String(error) }
    }
    const level = classifyCommandRisk(command, server.environment)
    if (level === 'L0') return next()
    return {
      kind: 'ask',
      reason: `server_exec on ${server.name} (${server.environment}) is classified ${level}: ${command}`,
    }
  })

  ctx.tools.register(defineTool({
    name: 'server_list',
    description: LIST_DESCRIPTION,
    parameters: {
      environment: {
        type: 'string',
        enum: [...ENVIRONMENTS],
        description: 'Restrict the listing to one environment.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          servers: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                host: { type: 'string', required: true },
                port: { type: 'integer', required: true },
                username: { type: 'string', required: true },
                environment: { type: 'string', required: true, enum: [...ENVIRONMENTS] },
                tags: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.servers.length === 0
          ? 'No managed servers are configured.'
          : `Managed servers: ${value.servers
            .map(server => `${server.id} (${server.name}, ${server.host}:${server.port}, ${server.environment})`)
            .join('; ')}`,
      }],
    },
    execute(args) {
      const selected = args.environment === undefined
        ? inventory
        : inventory.filter(server => server.environment === args.environment)
      return Promise.resolve({
        servers: selected.map(server => ({
          id: server.id,
          name: server.name,
          host: server.host,
          port: server.port,
          username: server.username,
          environment: server.environment,
          tags: [...server.tags],
        })),
      })
    },
    presentCall: () => ({ card: 'generic', title: 'List managed servers', kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'server_facts',
    description: FACTS_DESCRIPTION,
    parameters: {
      serverId: {
        type: 'string',
        required: true,
        description: 'The id of the managed server, taken from server_list.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          serverId: { type: 'string', required: true },
          exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          timedOut: { type: 'boolean', required: true },
          cancelled: { type: 'boolean', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.stdout === ''
          ? `${value.serverId}: no output (exit ${value.exitCode ?? 'none'})${value.timedOut ? ', timed out' : ''}`
          : value.stdout,
      }],
    },
    async execute(args, exec) {
      const server = requireServer(inventory, args.serverId)
      const result = await runRemoteCommand({
        host: server.host,
        port: server.port,
        username: server.username,
        keyRef: server.keyRef,
        command: FACTS_COMMAND,
        timeoutMs: config.commandTimeoutMs,
        maxOutputBytes: config.maxOutputBytes,
        signal: exec.signal,
      })
      return toFactsValue(server, result)
    },
    presentCall: args => ({ card: 'generic', title: `Read facts from ${args.serverId}`, kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'server_file_read',
    description: FILE_READ_DESCRIPTION,
    parameters: {
      serverId: {
        type: 'string',
        required: true,
        description: 'The id of the managed server, taken from server_list.',
      },
      path: {
        type: 'string',
        required: true,
        description: 'The absolute path of the file to read.',
      },
      maxLines: {
        type: 'integer',
        description: 'Cap the returned lines below the deployment default.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          serverId: { type: 'string', required: true },
          path: { type: 'string', required: true },
          exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          timedOut: { type: 'boolean', required: true },
          cancelled: { type: 'boolean', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.stdout === ''
          ? `${value.serverId}:${value.path}: no output (exit ${value.exitCode ?? 'none'})${value.timedOut ? ', timed out' : ''}`
          : value.stdout,
      }],
    },
    async execute(args, exec) {
      const server = requireServer(inventory, args.serverId)
      const maxLines = args.maxLines === undefined
        ? config.maxReadLines
        : Math.min(args.maxLines, config.maxReadLines)
      const result = await runRemoteCommand({
        host: server.host,
        port: server.port,
        username: server.username,
        keyRef: server.keyRef,
        command: buildReadCommand(args.path, maxLines),
        timeoutMs: config.commandTimeoutMs,
        maxOutputBytes: config.maxOutputBytes,
        signal: exec.signal,
      })
      return { ...toFactsValue(server, result), path: args.path }
    },
    presentCall: args => ({ card: 'generic', title: `Read ${args.path} on ${args.serverId}`, kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'server_exec',
    description: EXEC_DESCRIPTION,
    parameters: {
      serverId: {
        type: 'string',
        required: true,
        description: 'The id of the managed server, taken from server_list.',
      },
      command: {
        type: 'string',
        required: true,
        description: 'One shell command line, run by the remote login shell.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          serverId: { type: 'string', required: true },
          exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
          stdout: { type: 'string', required: true },
          stderr: { type: 'string', required: true },
          timedOut: { type: 'boolean', required: true },
          cancelled: { type: 'boolean', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.stdout === ''
          ? `${value.serverId}: no output (exit ${value.exitCode ?? 'none'})${value.timedOut ? ', timed out' : ''}`
          : value.stdout,
      }],
    },
    async execute(args, exec) {
      const server = requireServer(inventory, args.serverId)
      const result = await runRemoteCommand({
        host: server.host,
        port: server.port,
        username: server.username,
        keyRef: server.keyRef,
        command: args.command,
        timeoutMs: config.commandTimeoutMs,
        maxOutputBytes: config.maxOutputBytes,
        signal: exec.signal,
      })
      return toFactsValue(server, result)
    },
    presentCall: args => ({ card: 'generic', title: `Run a command on ${args.serverId}`, kind: 'other' }),
  }))
}
