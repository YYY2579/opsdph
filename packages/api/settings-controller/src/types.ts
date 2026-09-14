/**
 * Browser-safe failure vocabulary of the configuration surfaces this package
 * serves. The redacted views themselves live with their seam in
 * `@deepseek-ai/dsh-settings/types`, whose Cordis event declarations already
 * register that file for the Client compilation face.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/types
 */

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * Every seam refusal that is not a stale write: an unregistered or malformed
     * namespace, a read-only provider, schema validation, storage.
     */
    'settings/rejected': { readonly ns: string }
    /**
     * The stored revision moved after the caller read it. Its own outcome rather
     * than an invalid request: the caller must re-read and re-apply.
     */
    'settings/conflict': { readonly ns: string; readonly expected: number; readonly actual: number }
    /**
     * The provider refused a valid credential write, for example because a
     * read-only source shadows the reference. The details name only the
     * reference, never the value.
     */
    'credential/rejected': { readonly ref: string }
    /**
     * The ops-server plugin is not installed or disabled, so the settings
     * surface cannot list, probe, or persist servers and databases. The details
     * name nothing sensitive.
     */
    'ops/absent': Record<string, never>
  }
}

/** Confirmation that the settings document was handed to the native editor. */
export interface SettingsDocumentOpenValue {
  readonly opened: true
}

/** Result of opening or revealing one locally authored Agent preset directory. */
export type AgentPresetDirectoryOpenValue =
  | { readonly opened: true }
  | { readonly opened: false; readonly path: string }

/**
 * Authentication of one server as the settings surface passes it. Mirrored
 * here from the ops domain so the Remote boundary stays inside this package's
 * public type subpath; the ops-server service consumes the same shape.
 */
export type ServerAuthWire =
  | { readonly kind: 'key'; readonly keyPath: string }
  | { readonly kind: 'password'; readonly password: string }

/** One server add request from the settings surface; the password, when chosen, crosses the wire once. */
export interface ServerInputWire {
  /** User-chosen name; natural-language handle for the agent and the settings UI. */
  readonly nickname: string
  readonly host: string
  readonly port: number
  readonly username: string
  readonly auth: ServerAuthWire
  readonly environment: 'dev' | 'staging' | 'prod' | 'lab'
  readonly tags: readonly string[]
}

/** One database add request from the settings surface; the password crosses the wire once. */
export interface DbInputWire {
  readonly nickname: string
  readonly kind: 'mysql' | 'redis' | 'postgres'
  readonly host: string
  readonly port: number
  readonly database: string
  readonly username: string
  readonly password: string
  readonly environment: 'dev' | 'staging' | 'prod' | 'lab'
  readonly tags: readonly string[]
}

/** One managed server as the settings surface lists it; never carries a credential value. */
export interface OpsServerView {
  readonly id: string
  readonly nickname: string
  readonly host: string
  readonly port: number
  readonly username: string
  /** Authentication kind of the stored record; a key record keeps its path, a password record no value. */
  readonly auth: { readonly kind: 'key'; readonly keyPath: string } | { readonly kind: 'password' }
  readonly environment: 'dev' | 'staging' | 'prod' | 'lab'
  readonly tags: readonly string[]
}

/** One managed database target as the settings surface lists it; never carries a credential value. */
export interface OpsDbView {
  readonly id: string
  readonly nickname: string
  readonly kind: 'mysql' | 'redis' | 'postgres'
  readonly host: string
  readonly port: number
  readonly database: string
  readonly username: string
  readonly environment: 'dev' | 'staging' | 'prod' | 'lab'
  readonly tags: readonly string[]
}

/** Outcome of one connection probe from the settings surface. */
export interface OpsProbeResult {
  readonly ok: boolean
  readonly detail: string
}
