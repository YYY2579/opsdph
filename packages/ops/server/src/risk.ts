/**
 * Risk classification of ops commands. This module only decides a level from
 * command text and target environment; the `tools/pre-execute` gate in
 * `index.ts` is the enforcement point that consumes the level. Anything that
 * is not provably read-only classifies as a mutation, because the gate's
 * fail-closed fallback is to ask.
 * @module @deepseek-ai/dsh-ops-server/risk
 */

import type { DbKind, Environment, RiskLevel } from '@deepseek-ai/dsh-ops-common'

/**
 * Primary verbs whose bare use reads without changing remote state. A command
 * whose first word is absent here is a mutation; a compound verb is read-only
 * only with an allow-listed subcommand (see {@link COMPOUND_READ_SUBCOMMANDS}).
 */
export const READ_ONLY_VERBS: ReadonlySet<string> = new Set([
  'basename', 'cal', 'cat', 'cd', 'date', 'df', 'dirname', 'dmesg', 'du', 'echo',
  'egrep', 'env', 'expr', 'false', 'fgrep', 'file', 'find', 'free', 'grep', 'head',
  'hexdump', 'hostname', 'hostnamectl', 'htop', 'id', 'journalctl', 'less', 'ls',
  'lsblk', 'lscpu', 'lsof', 'md5sum', 'more', 'nproc', 'od', 'printenv', 'printf',
  'ps', 'pwd', 'readlink', 'realpath', 'seq', 'sha256sum', 'sleep', 'ss', 'stat',
  'tail', 'test', 'timedatectl', 'top', 'true', 'uname', 'uptime', 'w', 'wc',
  'which', 'who', 'whoami', 'xxd',
  'systemctl', 'service', 'git', 'docker', 'kubectl', 'nginx',
])

/**
 * Read-only subcommands for {@link READ_ONLY_VERBS} compound verbs. `actionIndex`
 * is the word position of the action: `systemctl <action> <unit>` puts it at 1,
 * while `service <name> <action>` puts it at 2. A compound verb whose action is
 * absent or outside its read set is a mutation.
 */
export const COMPOUND_READ_SUBCOMMANDS: Readonly<Record<string, { actionIndex: number; read: ReadonlySet<string> }>> = {
  systemctl: {
    actionIndex: 1,
    read: new Set([
      'status', 'is-active', 'is-enabled', 'is-failed', 'show', 'list-units',
      'list-timers', 'list-sockets', 'list-dependencies', 'list-unit-files', 'get-default',
    ]),
  },
  service: { actionIndex: 2, read: new Set(['status']) },
  git: {
    actionIndex: 1,
    read: new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'describe', 'ls-files', 'blame', 'help', 'version']),
  },
  docker: {
    actionIndex: 1,
    read: new Set(['ps', 'logs', 'inspect', 'images', 'stats', 'version', 'info', 'history', 'port', 'top']),
  },
  kubectl: {
    actionIndex: 1,
    read: new Set(['get', 'describe', 'logs', 'top', 'version', 'cluster-info', 'api-resources', 'explain']),
  },
  nginx: { actionIndex: 1, read: new Set(['-t', '-T']) },
}

/**
 * Tokens that change state wherever they appear in a command (other than as
 * the primary verb, whose own subcommand check decides it). Redirections that
 * write files and command-sequencing operators are included.
 */
export const MUTATE_MARKERS: ReadonlySet<string> = new Set([
  '&', '-delete', '-exec', '-ok',
  'apt', 'apt-get', 'aptitude', 'chattr', 'chgrp', 'chkconfig', 'chmod', 'chown',
  'cmake', 'configure', 'cp', 'crontab', 'curl', 'dd', 'dnf', 'dpkg', 'firewall-cmd',
  'groupadd', 'groupdel', 'groupmod', 'helm', 'install', 'iptables', 'kill', 'killall',
  'ln', 'make', 'meson', 'mkdir', 'mount', 'mv', 'mysql', 'nft', 'ninja', 'npm',
  'pacman', 'passwd', 'pip', 'pip3', 'pkill', 'pkexec', 'pnpm', 'psql', 'redis-cli',
  'rm', 'rmdir', 'rpm', 'rsync', 'scp', 'sed', 'shutdown', 'sqlite3', 'su', 'sudo',
  'swapoff', 'swapon', 'systemd-tmpfiles', 'tee', 'touch', 'ufw', 'umount', 'unlink',
  'useradd', 'userdel', 'usermod', 'wget', 'yarn', 'yum', 'zypper',
])

/** Destructive patterns; any match classifies the whole command as L4. */
export const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  /\brm\s+(?:-[a-z]*[rf][a-z]*\s+)+(?:\/|\/\*|\*)(?:\s|$)/,
  /\bmkfs(?:\.\w+)?\b/,
  /\bparted\b/,
  /\bfdisk\b/,
  /\bdd\b[^\n]*\bof=/,
  /\b(?:shutdown|poweroff|halt|reboot)\b/,
  /\bkill\s+-9\s+1\b/,
  /\bdrop\s+(?:database|schema)\b/,
  /\bgit\s+push\b[^\n]*--force\b/,
  /\bcrontab\s+-r\b/,
]

/**
 * Split a command line into its command segments (semicolons, `&&`, `||`, and
 * newlines run independent commands).
 * @param command - the complete remote command line.
 * @returns the trimmed non-empty segments.
 */
function segmentsOf(command: string): string[] {
  return command.split(/;|\|\||&&|\n/).map(segment => segment.trim()).filter(segment => segment !== '')
}

/**
 * Split one command segment into words. Pipes separate stages; `>`, `>>`, and
 * `&` stay as their own words so redirection and backgrounding are visible.
 * @param segment - one command segment.
 * @returns the non-empty words of the segment.
 */
function wordsOf(segment: string): string[] {
  return segment.split(/[\s|]+/).filter(word => word !== '')
}

/**
 * Whether one command segment provably reads without changing remote state.
 * The primary verb must be read-only, its compound subcommand must be
 * allow-listed, and no later word may be a mutation marker or a redirection.
 * @param segment - one command segment.
 * @returns true when the segment is provably read-only.
 */
function isReadSegment(segment: string): boolean {
  const words = wordsOf(segment)
  if (words.length === 0) return true
  const primary = words[0]
  if (primary === undefined || !READ_ONLY_VERBS.has(primary)) return false
  const compound = COMPOUND_READ_SUBCOMMANDS[primary]
  if (compound !== undefined) {
    const action = words[compound.actionIndex]
    if (action === undefined || !compound.read.has(action)) return false
  }
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index]
    if (word === undefined) return false
    if (word === '&' || word.startsWith('>')) return false
    // Command substitution executes nested shell text whose effect is not
    // provably read-only; `$(( ... ))` arithmetic is the harmless exception.
    if (word.startsWith('$(') && !word.startsWith('$((')) return false
    if (word.startsWith('`')) return false
    if (MUTATE_MARKERS.has(word)) return false
  }
  return true
}

/**
 * Escalate a mutating command by target environment: the safer the
 * environment, the lower the level, but never below L1 (a mutation always
 * asks).
 * @param environment - the target's environment class.
 * @returns the risk level of an otherwise-unclassified mutation.
 */
function escalation(environment: Environment): RiskLevel {
  switch (environment) {
    case 'prod': return 'L3'
    case 'staging': return 'L2'
    default: return 'L1'
  }
}

/**
 * Classify one free-form remote command against its target environment.
 * Destructive patterns are always L4; everything that is not provably
 * read-only is a mutation escalated by environment; provably read-only
 * commands are L0.
 * @param command - the complete remote command line.
 * @param environment - the target server's environment class.
 * @returns the command's risk level.
 */
export function classifyCommandRisk(command: string, environment: Environment): RiskLevel {
  const segments = segmentsOf(command)
  if (segments.length === 0) return escalation(environment)
  if (DESTRUCTIVE_PATTERNS.some(pattern => pattern.test(command))) return 'L4'
  return segments.every(isReadSegment) ? 'L0' : escalation(environment)
}

/** SQL leading verbs that provably read; any other leading verb asks. */
const READ_ONLY_SQL_VERBS = new Set(['select', 'show', 'explain', 'describe', 'desc', 'pragma', 'with'])

/** Redis leading verbs that provably read; any other leading verb asks. */
const READ_ONLY_REDIS_VERBS = new Set([
  'info', 'dbsize', 'ping', 'get', 'mget', 'hget', 'hgetall', 'hlen', 'hkeys', 'hvals',
  'llen', 'lrange', 'scard', 'smembers', 'zcard', 'zrange', 'ttl', 'type', 'exists',
  'keys', 'scan', 'strlen', 'getrange', 'srandmember', 'echo', 'time',
])

/**
 * Classify one read-only database command by its leading verb. SQL comments,
 * trailing semicolons, and case are tolerated; anything whose leading verb is
 * absent from the read-only set classifies as a mutation (ask).
 * @param command - the database command text.
 * @param kind - the target database engine.
 * @returns `L0` for a provably read-only command, `L1` otherwise.
 */
export function classifyDbQueryRisk(command: string, kind: DbKind): RiskLevel {
  const stripped = command
    .replace(/^[\s;]+/u, '')
    .replace(/^\/\*[\s\S]*?\*\//u, '')
    .replace(/^--[^\n]*\n?/u, '')
    .trim()
    .replace(/;+\s*$/u, '')
  const verb = stripped.split(/\s+/u, 1)[0]?.toLowerCase()
  if (verb === undefined || verb === '') return 'L1'
  const readSet = kind === 'redis' ? READ_ONLY_REDIS_VERBS : READ_ONLY_SQL_VERBS
  return readSet.has(verb) ? 'L0' : 'L1'
}
