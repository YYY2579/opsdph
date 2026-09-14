/**
 * Remote command transport over the host's OpenSSH client. The transport owns
 * argument construction, output bounding, timeout, and cancellation; it never
 * resolves a credential value, so a private-key path stays the only thing the
 * configuration carries.
 *
 * OpenSSH is the transport rather than a JavaScript SSH implementation because
 * this workspace denies unreviewed dependency build scripts, and the host
 * client already holds the user's identities and `known_hosts`.
 * @module @deepseek-ai/dsh-ops-server/ssh
 */

import { spawn } from 'node:child_process'

/** Default ceiling on the bytes retained from one remote command's standard output. */
export const DEFAULT_MAX_OUTPUT_BYTES = 262_144

/** One remote command request, fully resolved by the caller that owns the target. */
export interface RemoteCommandRequest {
  /** Host name or address exactly as the inventory declares it. */
  readonly host: string
  readonly port: number
  readonly username: string
  /** Path of the OpenSSH private key; omitted means the OpenSSH default identity or agent. */
  readonly keyRef?: string
  /** Password for password authentication; routed through `sshpass`, which must be on PATH. */
  readonly password?: string
  /** The complete remote command line, run by the remote login shell. */
  readonly command: string
  /** Hard limit on the whole command; the transport kills the client when it expires. */
  readonly timeoutMs: number
  /** Retained standard-output ceiling in bytes. */
  readonly maxOutputBytes: number
  /** Cancels the command; the transport kills the client. */
  readonly signal?: AbortSignal
}

/** Bounded outcome of one remote command. */
export interface RemoteCommandResult {
  /** Exit status, or null when a signal or the timeout ended the process. */
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
  /** True when standard output exceeded the retained ceiling. */
  readonly truncated: boolean
  /** True when the transport killed the client at `timeoutMs`. */
  readonly timedOut: boolean
  /** True when {@link RemoteCommandRequest.signal} aborted the command. */
  readonly cancelled: boolean
}

/** The child-process surface the transport uses; tests substitute a fake. */
export interface SshChild {
  readonly stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null
  readonly stderr: { on(event: 'data', listener: (chunk: Buffer) => void): unknown } | null
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

/** Builds one SSH client process from the resolved executable and argument list. */
export type SshSpawner = (executable: string, args: readonly string[]) => SshChild

/** Non-interactive SSH flags: no password prompt, no host-key prompt, bounded connect. */
const CONNECT_OPTIONS = [
  '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=accept-new',
] as const

/**
 * Build the SSH argument list for one request.
 * @param request - the resolved remote command request.
 * @returns arguments for the `ssh` executable, ending in the remote command line.
 */
export function buildSshArgs(request: Pick<
  RemoteCommandRequest,
  'host' | 'port' | 'username' | 'keyRef' | 'command' | 'timeoutMs'
>): string[] {
  const connectSeconds = Math.max(1, Math.ceil(request.timeoutMs / 1000))
  const args = [
    ...CONNECT_OPTIONS,
    '-o', `ConnectTimeout=${connectSeconds}`,
    '-p', String(request.port),
  ]
  if (request.keyRef !== undefined && request.keyRef !== '') {
    args.push('-i', request.keyRef)
  }
  args.push(`${request.username}@${request.host}`, request.command)
  return args
}

/** The default spawner: the host `ssh` (or `sshpass` for passwords) client with no inherited standard input. */
const systemSpawn: SshSpawner = (executable, args) => spawn(executable, [...args], {
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
}) as unknown as SshChild

/**
 * Resolve the client executable and its argument list for one request: a
 * password routes through `sshpass` (which must be on PATH), anything else
 * through the host `ssh` client directly.
 * @param request - the resolved remote command request.
 * @returns the executable and its full argument list.
 */
export function buildSshInvocation(request: Pick<
  RemoteCommandRequest,
  'host' | 'port' | 'username' | 'keyRef' | 'password' | 'command' | 'timeoutMs'
>): { readonly executable: string; readonly args: string[] } {
  const sshArgs = buildSshArgs(request)
  if (request.password === undefined || request.password === '') {
    return { executable: 'ssh', args: sshArgs }
  }
  return { executable: 'sshpass', args: ['-p', request.password, 'ssh', ...sshArgs] }
}

/**
 * Run one remote command, bounding retained output and enforcing the timeout.
 * @param request - the resolved remote command request.
 * @param spawner - process factory; tests pass a fake.
 * @returns the bounded command outcome.
 */
export function runRemoteCommand(
  request: RemoteCommandRequest,
  spawner: SshSpawner = systemSpawn,
): Promise<RemoteCommandResult> {
  return new Promise<RemoteCommandResult>((resolve, reject) => {
    const startedAt = Date.now()
    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let cancelled = false
    let settled = false
    let child: SshChild

    const finish = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onAbort)
      resolve({
        exitCode,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
        truncated,
        timedOut,
        cancelled,
      })
    }

    const onAbort = (): void => {
      cancelled = true
      child.kill()
    }

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, request.timeoutMs)

    const { executable, args } = buildSshInvocation(request)
    try {
      child = spawner(executable, args)
    } catch (error) {
      clearTimeout(timer)
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }

    child.stdout?.on('data', (chunk) => {
      const room = request.maxOutputBytes - Buffer.byteLength(stdout, 'utf8')
      if (room <= 0) {
        truncated = true
        return
      }
      if (chunk.byteLength > room) {
        truncated = true
        stdout += chunk.subarray(0, room).toString('utf8')
        return
      }
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    child.on('close', code => finish(code))

    if (request.signal !== undefined) {
      if (request.signal.aborted) onAbort()
      else request.signal.addEventListener('abort', onAbort)
    }
  })
}
