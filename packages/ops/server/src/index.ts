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
import { DB_KINDS, ENVIRONMENTS } from '@deepseek-ai/dsh-ops-common'
import type { OpsServer } from '@deepseek-ai/dsh-ops-common'
import { DEFAULT_MAX_OUTPUT_BYTES, runRemoteCommand } from './ssh.ts'
import type { RemoteCommandResult } from './ssh.ts'
import { classifyCommandRisk, classifyDbQueryRisk } from './risk.ts'
import { OpsInventory } from './inventory.ts'
import type { ServerEntryConfig } from './inventory.ts'
import { OpsServerService } from './service.ts'
import { runDbQuery, testDbConnection } from './db.ts'

export const name = 'ops-server'
export const inject = ['tools']

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
const FIXED_READ_ONLY_TOOLS = new Set([
  'server_list', 'server_facts', 'server_file_read', 'server_test', 'db_list', 'db_test',
])

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
export async function apply(ctx: Context, config: Config): Promise<void> {
  const inventory = new OpsInventory(ctx, config.servers)
  await inventory.start()
  // The named `opsServer` service backs the settings-surface Remote controller:
  // it is present exactly when this plugin is composed, and its absence is what
  // that controller reports to the settings UI.
  new OpsServerService(ctx, inventory, {
    commandTimeoutMs: config.commandTimeoutMs,
    maxOutputBytes: config.maxOutputBytes,
  })

  // The single enforcement point of the ops risk policy: fixed read-only tools
  // run; a mutating `server_exec` asks through the tool runtime's approval seam,
  // which fails closed when no approval service, answerer, or agent is composed;
  // unknown ops tools and unresolvable calls are denied. Schema omission or
  // prompt text is never the enforcement — this listener decides.
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!exec.name.startsWith('server_') && !exec.name.startsWith('db_')) return next()
    if (FIXED_READ_ONLY_TOOLS.has(exec.name)) return next()
    const args = exec.arguments as Record<string, unknown> | null
    const read = (field: string): unknown => (args !== null && typeof args === 'object' ? args[field] : undefined)

    if (exec.name === 'server_exec') {
      const serverId = read('serverId')
      const command = read('command')
      if (typeof serverId !== 'string') {
        return { kind: 'deny', reason: 'server_exec requires a serverId string.' }
      }
      if (typeof command !== 'string') {
        return { kind: 'deny', reason: 'server_exec requires a command string.' }
      }
      let server: OpsServer
      try {
        server = inventory.serverById(serverId)
      } catch (error) {
        return { kind: 'deny', reason: error instanceof Error ? error.message : String(error) }
      }
      const level = classifyCommandRisk(command, server.environment)
      if (level === 'L0') return next()
      return {
        kind: 'ask',
        reason: `server_exec on ${server.name} (${server.environment}) is classified ${level}: ${command}`,
      }
    }

    if (exec.name === 'db_query') {
      const dbId = read('dbId')
      const command = read('command')
      if (typeof dbId !== 'string') {
        return { kind: 'deny', reason: 'db_query requires a dbId string.' }
      }
      if (typeof command !== 'string') {
        return { kind: 'deny', reason: 'db_query requires a command string.' }
      }
      let db
      try {
        db = inventory.dbById(dbId)
      } catch (error) {
        return { kind: 'deny', reason: error instanceof Error ? error.message : String(error) }
      }
      const level = classifyDbQueryRisk(command, db.kind)
      if (level === 'L0') return next()
      return {
        kind: 'ask',
        reason: `db_query on ${db.nickname} (${db.kind}) is classified ${level}: ${command}`,
      }
    }

    // Inventory mutations (adding/removing servers or databases) are changes:
    // they always ask through the approval seam.
    if (exec.name === 'server_add' || exec.name === 'server_remove'
      || exec.name === 'db_add' || exec.name === 'db_remove') {
      return { kind: 'ask', reason: `${exec.name} changes the managed inventory and requires approval.` }
    }

    return { kind: 'deny', reason: `Unknown ops tool "${exec.name}": refused to run.` }
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
      const servers = inventory.listServers()
      const selected = args.environment === undefined
        ? servers
        : servers.filter(server => server.environment === args.environment)
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
      const server = inventory.serverById(args.serverId)
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
      const server = inventory.serverById(args.serverId)
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
      const server = inventory.serverById(args.serverId)
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

  ctx.tools.register(defineTool({
    name: 'db_list',
    description: 'List the managed database targets (MySQL, Redis, PostgreSQL). Each entry reports '
      + 'the stable id, nickname, engine, address, and database. Use the returned id — never the '
      + 'nickname — to address the target in later operations.',
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
          dbs: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                nickname: { type: 'string', required: true },
                kind: { type: 'string', required: true, enum: [...DB_KINDS] },
                host: { type: 'string', required: true },
                port: { type: 'integer', required: true },
                database: { type: 'string', required: true },
                environment: { type: 'string', required: true, enum: [...ENVIRONMENTS] },
                tags: { type: 'array', required: true, items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.dbs.length === 0
          ? 'No managed databases are configured.'
          : `Managed databases: ${value.dbs
            .map(db => `${db.id} (${db.nickname}, ${db.kind}, ${db.host}:${db.port})`)
            .join('; ')}`,
      }],
    },
    execute(args) {
      const dbs = inventory.listDbs()
      const selected = args.environment === undefined
        ? dbs
        : dbs.filter(db => db.environment === args.environment)
      return Promise.resolve({
        dbs: selected.map(db => ({
          id: db.id,
          nickname: db.nickname,
          kind: db.kind,
          host: db.host,
          port: db.port,
          database: db.database,
          environment: db.environment,
          tags: [...db.tags],
        })),
      })
    },
    presentCall: () => ({ card: 'generic', title: 'List managed databases', kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'db_test',
    description: 'Test the connection to one managed database target and report the server reply. '
      + 'Read-only and automatic. Pass the database id from db_list.',
    parameters: {
      dbId: {
        type: 'string',
        required: true,
        description: 'The id of the managed database, taken from db_list.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dbId: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
          detail: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok ? `${value.dbId}: ${value.detail}` : `${value.dbId}: connection failed — ${value.detail}`,
      }],
    },
    async execute(args, _exec) {
      const db = inventory.dbById(args.dbId)
      const password = (await inventory.resolveCredential(db.credRef))?.value ?? ''
      const result = await testDbConnection({
        kind: db.kind,
        host: db.host,
        port: db.port,
        database: db.database,
        username: db.username,
        password,
        timeoutMs: config.commandTimeoutMs,
        maxOutputChars: config.maxOutputBytes,
      })
      return {
        dbId: db.id,
        ok: result.ok,
        detail: result.ok ? result.detail : result.error,
      }
    },
    presentCall: args => ({ card: 'generic', title: `Test database ${args.dbId}`, kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'db_query',
    description: 'Run one bounded read-only command on a managed database: SQL for MySQL/PostgreSQL '
      + '(SELECT, SHOW, EXPLAIN, DESCRIBE) or a Redis command (INFO, GET, KEYS, ...). Anything not '
      + 'provably read-only requires approval and never runs without it.',
    parameters: {
      dbId: {
        type: 'string',
        required: true,
        description: 'The id of the managed database, taken from db_list.',
      },
      command: {
        type: 'string',
        required: true,
        description: 'The read-only SQL or Redis command to run.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dbId: { type: 'string', required: true },
          stdout: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.stdout === ''
          ? `${value.dbId}: no output`
          : `${value.stdout}${value.truncated ? '\n[output truncated]' : ''}`,
      }],
    },
    async execute(args, _exec) {
      const db = inventory.dbById(args.dbId)
      const password = (await inventory.resolveCredential(db.credRef))?.value ?? ''
      const result = await runDbQuery({
        kind: db.kind,
        host: db.host,
        port: db.port,
        database: db.database,
        username: db.username,
        password,
        timeoutMs: config.commandTimeoutMs,
        maxOutputChars: config.maxOutputBytes,
      }, args.command)
      return {
        dbId: db.id,
        stdout: result.stdout,
        truncated: result.truncated,
      }
    },
    presentCall: args => ({ card: 'generic', title: `Query database ${args.dbId}`, kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'server_test',
    description: 'Test the SSH connection to one managed server and report the outcome. '
      + 'Read-only and automatic. Pass the server id from server_list.',
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
          ok: { type: 'boolean', required: true },
          detail: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.ok ? `${value.serverId}: SSH connection ok` : `${value.serverId}: SSH failed — ${value.detail}`,
      }],
    },
    async execute(args, exec) {
      const server = inventory.serverById(args.serverId)
      const result = await runRemoteCommand({
        host: server.host,
        port: server.port,
        username: server.username,
        keyRef: server.keyRef,
        command: 'printf ok',
        timeoutMs: config.commandTimeoutMs,
        maxOutputBytes: config.maxOutputBytes,
        signal: exec.signal,
      })
      const ok = result.exitCode === 0 && result.stdout.trim() === 'ok'
      return { serverId: server.id, ok, detail: ok ? '' : (result.stderr.trim() || `exit ${String(result.exitCode)}`) }
    },
    presentCall: args => ({ card: 'generic', title: `Test server ${args.serverId}`, kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'db_add',
    description: 'Add a managed database target. Requires approval. Pass a user-chosen nickname so '
      + 'you can refer to the target naturally later.',
    parameters: {
      nickname: { type: 'string', required: true, description: 'User-chosen name for this database.' },
      kind: { type: 'string', required: true, enum: [...DB_KINDS], description: 'Database engine.' },
      host: { type: 'string', required: true },
      port: { type: 'integer', required: true },
      database: { type: 'string', description: 'Database name (unused for Redis).' },
      username: { type: 'string', description: 'Login user (unused for Redis).' },
      password: { type: 'string', description: 'The database password; stored as a credential reference.' },
      environment: { type: 'string', enum: [...ENVIRONMENTS], default: 'lab' },
      tags: { type: 'array', items: { type: 'string' } },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dbId: { type: 'string', required: true },
          nickname: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Added database ${value.nickname} (${value.dbId}).`,
      }],
    },
    async execute(args, _exec) {
      const dbId = await inventory.addDb({
        nickname: args.nickname,
        kind: args.kind,
        host: args.host,
        port: args.port,
        database: args.database ?? '',
        username: args.username ?? '',
        environment: args.environment ?? 'lab',
        tags: args.tags ?? [],
      }, args.password ?? '')
      return { dbId, nickname: args.nickname }
    },
    presentCall: args => ({ card: 'generic', title: `Add database ${args.nickname}`, kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'db_remove',
    description: 'Remove a managed database target and its stored credential. Requires approval.',
    parameters: {
      dbId: {
        type: 'string',
        required: true,
        description: 'The id of the managed database, taken from db_list.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          dbId: { type: 'string', required: true },
          removed: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.removed ? `Removed database ${value.dbId}.` : `Database ${value.dbId} was not found.`,
      }],
    },
    async execute(args, _exec) {
      const removed = await inventory.removeDb(args.dbId)
      return { dbId: args.dbId, removed }
    },
    presentCall: args => ({ card: 'generic', title: `Remove database ${args.dbId}`, kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'server_add',
    description: 'Add a managed server. Requires approval. Pass a user-chosen nickname so you can '
      + 'refer to the server naturally later; an optional password is stored as a credential '
      + 'reference, otherwise the SSH key path from server configuration is used.',
    parameters: {
      nickname: { type: 'string', required: true, description: 'User-chosen name for this server.' },
      host: { type: 'string', required: true },
      port: { type: 'integer', required: true },
      username: { type: 'string', required: true },
      password: { type: 'string', description: 'Optional SSH password; stored as a credential reference.' },
      environment: { type: 'string', enum: [...ENVIRONMENTS], default: 'lab' },
      tags: { type: 'array', items: { type: 'string' } },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          serverId: { type: 'string', required: true },
          nickname: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Added server ${value.nickname} (${value.serverId}).`,
      }],
    },
    async execute(args, _exec) {
      const serverId = await inventory.addServer({
        nickname: args.nickname,
        host: args.host,
        port: args.port,
        username: args.username,
        environment: args.environment ?? 'lab',
        tags: args.tags ?? [],
      }, args.password)
      return { serverId, nickname: args.nickname }
    },
    presentCall: args => ({ card: 'generic', title: `Add server ${args.nickname}`, kind: 'other' }),
  }))

  ctx.tools.register(defineTool({
    name: 'server_remove',
    description: 'Remove a managed server and its stored credential. Requires approval.',
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
          removed: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.removed ? `Removed server ${value.serverId}.` : `Server ${value.serverId} was not found.`,
      }],
    },
    async execute(args, _exec) {
      const removed = await inventory.removeServer(args.serverId)
      return { serverId: args.serverId, removed }
    },
    presentCall: args => ({ card: 'generic', title: `Remove server ${args.serverId}`, kind: 'other' }),
  }))
}
