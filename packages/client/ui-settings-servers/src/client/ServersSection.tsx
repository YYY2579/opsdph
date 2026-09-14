/**
 * Servers & Databases settings section: one page managing the ops targets the
 * agent addresses in chat. Each target is added through a probe-before-save
 * form — the connection must pass its test before the save button enables — and
 * listed with its authentication kind and a remove action behind confirmation.
 * Every list view is fetched through the wire; nothing here holds a password
 * after the form is dismissed, and no returned value ever carries one.
 */

import { useEffect, useState } from 'react'
import type { Dispatch, ReactNode, SetStateAction } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  DbInputWire, OpsDbView, OpsServerView, ServerInputWire,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { OpsOperations } from './operations.ts'
import type { en } from './locales.ts'
import styles from './ServersSection.module.css'

/** Injected dependencies of {@link ServersSection}. */
export interface ServersSectionInjected {
  /** The Host ops operations the page invokes. */
  operations: OpsOperations
  /** Section copy. */
  t: (key: keyof typeof en) => string
}

/** Props delivered by the slot outlet. */
export type ServersSectionProps = Partial<InjectFace<ServersSectionInjected>>

/** Environment choices one target may declare. */
const ENVIRONMENTS = ['lab', 'prod', 'staging', 'dev'] as const
type Environment = (typeof ENVIRONMENTS)[number]

/** Database engine choices. */
const DB_KINDS = ['mysql', 'redis', 'postgres'] as const
type DbKind = (typeof DB_KINDS)[number]

/** Default ports by database engine, pre-filled in the add form. */
const DB_DEFAULT_PORTS: Record<DbKind, string> = { mysql: '3306', redis: '6379', postgres: '5432' }

/** One server add-form draft. */
interface ServerDraft {
  nickname: string
  host: string
  port: string
  username: string
  auth: 'key' | 'password'
  keyPath: string
  password: string
  environment: Environment
  tags: string
}

/** One database add-form draft. */
interface DbDraft {
  nickname: string
  kind: DbKind
  host: string
  port: string
  database: string
  username: string
  password: string
  environment: Environment
  tags: string
}

function blankServerDraft(): ServerDraft {
  return { nickname: '', host: '', port: '22', username: '', auth: 'key', keyPath: '', password: '', environment: 'lab', tags: '' }
}

function blankDbDraft(): DbDraft {
  return { nickname: '', kind: 'mysql', host: '', port: '3306', database: '', username: '', password: '', environment: 'lab', tags: '' }
}

/** Split the comma-separated tag input into trimmed non-empty tags. */
function tagsOf(input: string): string[] {
  return input.split(',').map(tag => tag.trim()).filter(tag => tag !== '')
}

/** Whether a numeric port string is a valid TCP port. */
function portValid(value: string): boolean {
  const port = Number(value)
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

/** Required-field completeness of one server draft. */
function serverComplete(draft: ServerDraft): boolean {
  return draft.nickname.trim() !== '' && draft.host.trim() !== '' && draft.username.trim() !== ''
    && portValid(draft.port) && (draft.auth === 'key' ? draft.keyPath.trim() !== '' : true)
}

/** Required-field completeness of one database draft. */
function dbComplete(draft: DbDraft): boolean {
  return draft.nickname.trim() !== '' && draft.host.trim() !== '' && portValid(draft.port)
}

/** One server row's secondary line: address, user, auth, and environment. */
function serverMeta(server: OpsServerView, t: ServersSectionInjected['t']): string {
  const auth = server.auth.kind === 'key' ? t('authKey') : t('authPassword')
  return `${server.host}:${server.port} · ${server.username} · ${auth} · ${server.environment}`
}

/** One database row's secondary line: address, user, and environment. */
function dbMeta(db: OpsDbView): string {
  return `${db.host}:${db.port}${db.database === '' ? '' : ` / ${db.database}`}${db.username === '' ? '' : ` · ${db.username}`} · ${db.environment}`
}

/**
 * Render the Servers & Databases section content column.
 * @param props - slot-delivered injected dependencies.
 * @returns the section, or null while the shell has not injected yet.
 */
export function ServersSection(props: ServersSectionProps): ReactNode {
  const { operations, t } = props
  if (operations === undefined || t === undefined) return null
  return <Loaded operations={operations} t={t} />
}

function Loaded({ operations, t }: { operations: OpsOperations; t: ServersSectionInjected['t'] }): ReactNode {
  const [servers, setServers] = useState<OpsServerView[]>([])
  const [dbs, setDbs] = useState<OpsDbView[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'absent'>('loading')
  const [errorText, setErrorText] = useState<string | undefined>(undefined)
  const [savedNotice, setSavedNotice] = useState<string | undefined>(undefined)
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; label: string; kind: 'server' | 'db' } | undefined>(undefined)
  const [deleting, setDeleting] = useState(false)
  const [deleteFailure, setDeleteFailure] = useState<string | undefined>(undefined)

  useEffect(() => {
    void Promise.all([operations.listServers(), operations.listDbs()]).then(([serverOutcome, dbOutcome]) => {
      const absent = serverOutcome.kind === 'absent' || dbOutcome.kind === 'absent'
      if (absent) {
        setState('absent')
        return
      }
      const refused = serverOutcome.kind === 'refused'
        ? serverOutcome
        : dbOutcome.kind === 'refused' ? dbOutcome : undefined
      if (refused !== undefined) {
        setState('error')
        setErrorText(refused.message)
        return
      }
      if (serverOutcome.kind !== 'loaded' || dbOutcome.kind !== 'loaded') return
      setServers(serverOutcome.value)
      setDbs(dbOutcome.value)
      setState('ready')
    })
  }, [operations])

  const reload = (): void => {
    void Promise.all([operations.listServers(), operations.listDbs()]).then(([serverOutcome, dbOutcome]) => {
      const absent = serverOutcome.kind === 'absent' || dbOutcome.kind === 'absent'
      if (absent) {
        setState('absent')
        return
      }
      const refused = serverOutcome.kind === 'refused'
        ? serverOutcome
        : dbOutcome.kind === 'refused' ? dbOutcome : undefined
      if (refused !== undefined) {
        setState('error')
        setErrorText(refused.message)
        return
      }
      if (serverOutcome.kind !== 'loaded' || dbOutcome.kind !== 'loaded') return
      setServers(serverOutcome.value)
      setDbs(dbOutcome.value)
      setState('ready')
    })
  }

  const confirmDelete = (): void => {
    if (deleteTarget === undefined || deleting) return
    setDeleting(true)
    setDeleteFailure(undefined)
    const pending = deleteTarget.kind === 'server'
      ? operations.removeServer(deleteTarget.id)
      : operations.removeDb(deleteTarget.id)
    void pending.then((failure) => {
      if (failure !== undefined) {
        setDeleteFailure(failure)
        return
      }
      setDeleteTarget(undefined)
      void reload()
    }).finally(() => { setDeleting(false) })
  }

  if (state === 'loading') return <div className={styles.section}><p className={styles.muted}>{t('loading')}</p></div>
  if (state === 'absent') {
    return (
      <div className={styles.section}>
        <h2 className={styles.title}>{t('title')}</h2>
        <p className={styles.error} role="alert">{t('pluginMissing')}</p>
      </div>
    )
  }
  if (state === 'error') {
    return (
      <div className={styles.section}>
        <h2 className={styles.title}>{t('title')}</h2>
        <p className={styles.error} role="alert">{`${t('loadFailed')}: ${errorText ?? ''}`}</p>
        <button type="button" className={styles.secondaryButton} onClick={() => { void reload() }}>{t('retry')}</button>
      </div>
    )
  }

  return (
    <div className={styles.section}>
      <h2 className={styles.title}>{t('title')}</h2>
      <p className={styles.intro}>{t('intro')}</p>
      {savedNotice === undefined ? null : <p className={styles.savedNotice} role="status" aria-live="polite">{savedNotice}</p>}

      <h3 className={styles.blockTitle}>{t('serversTitle')}</h3>
      {servers.length === 0 ? <p className={styles.muted}>{t('serversEmpty')}</p> : (
        <ul className={styles.rows}>
          {servers.map(server => (
            <li key={server.id} className={styles.row}>
              <span className={styles.rowIdentity}>
                <span className={styles.rowName}>{server.nickname}</span>
                <span className={styles.rowMeta}>{serverMeta(server, t)}</span>
              </span>
              <button
                type="button"
                className={styles.dangerButton}
                aria-label={`${t('remove')} ${server.nickname}`}
                onClick={() => { setDeleteTarget({ id: server.id, label: server.nickname, kind: 'server' }) }}
              >
                {t('remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <ServerForm
        operations={operations}
        t={t}
        onSaved={(nickname) => {
          setSavedNotice(t('saved').replace('{nickname}', nickname))
          void reload()
        }}
      />

      <h3 className={styles.blockTitle}>{t('dbsTitle')}</h3>
      {dbs.length === 0 ? <p className={styles.muted}>{t('dbsEmpty')}</p> : (
        <ul className={styles.rows}>
          {dbs.map(db => (
            <li key={db.id} className={styles.row}>
              <span className={styles.rowIdentity}>
                <span className={styles.rowName}>{`${db.nickname} (${db.kind})`}</span>
                <span className={styles.rowMeta}>{dbMeta(db)}</span>
              </span>
              <button
                type="button"
                className={styles.dangerButton}
                aria-label={`${t('remove')} ${db.nickname}`}
                onClick={() => { setDeleteTarget({ id: db.id, label: db.nickname, kind: 'db' }) }}
              >
                {t('remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
      <DbForm
        operations={operations}
        t={t}
        onSaved={(nickname) => {
          setSavedNotice(t('saved').replace('{nickname}', nickname))
          void reload()
        }}
      />

      <Modal
        open={deleteTarget !== undefined}
        onClose={() => { if (!deleting) setDeleteTarget(undefined) }}
        title={deleteTarget === undefined ? '' : t('removeConfirm').replace('{nickname}', deleteTarget.label)}
        closeLabel={t('close')}
        description={t('removeDescription')}
        className={styles.deleteDialog as string}
        footer={(
          <>
            <Button variant="outline" autoFocus disabled={deleting} onClick={() => { setDeleteTarget(undefined) }}>
              {t('cancel')}
            </Button>
            <Button
              variant="outline"
              className={styles.deleteConfirm}
              disabled={deleting}
              onClick={confirmDelete}
            >
              {deleteTarget === undefined ? '' : t('removeConfirmButton').replace('{nickname}', deleteTarget.label)}
            </Button>
          </>
        )}
      >
        {deleteFailure === undefined ? null : <p className={styles.error}>{deleteFailure}</p>}
      </Modal>
    </div>
  )
}

/** Shared add-form chrome: title, test outcome, and the save/test actions. */
interface FormShellProps<T> {
  t: ServersSectionInjected['t']
  draft: T
  complete: (draft: T) => boolean
  testing: boolean
  testPassed: boolean
  testDetail: string | undefined
  saving: boolean
  saveFailure: string | undefined
  onTest: () => void
  onSave: () => void
  testLabel: string
  children: ReactNode
}

function FormShell<T>(props: FormShellProps<T>): ReactNode {
  const { t, draft, complete, testing, testPassed, testDetail, saving, saveFailure, onTest, onSave, testLabel, children } = props
  return (
    <div className={styles.form}>
      {children}
      <div className={styles.formActions}>
        <Button variant="outline" disabled={testing || !complete(draft)} onClick={onTest}>
          {testing ? t('testing') : testLabel}
        </Button>
        <Button
          variant="primary"
          disabled={saving || !testPassed}
          title={testPassed ? undefined : t('saveNeedsTest')}
          onClick={onSave}
        >
          {saving ? t('saving') : t('save')}
        </Button>
      </div>
      {testDetail === undefined ? null : (
        <p className={testPassed ? styles.testPassed : styles.testFailed} role="status">
          {testPassed ? t('testPassed') : `${t('testFailed')}: ${testDetail}`}
        </p>
      )}
      {saveFailure === undefined ? null : <p className={styles.error} role="alert">{saveFailure}</p>}
    </div>
  )
}

function Field(props: { label: string; children: ReactNode }): ReactNode {
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{props.label}</span>
      {props.children}
    </label>
  )
}

/** One form-wide draft state: a partial patch invalidates the test verdict and any failure text. */
function useDraft<T>(initial: () => T): {
  draft: T
  setDraftState: Dispatch<SetStateAction<T>>
  patch: (update: Partial<T>) => void
  testPassed: boolean
  setTestPassed: Dispatch<SetStateAction<boolean>>
  testDetail: string | undefined
  setTestDetail: Dispatch<SetStateAction<string | undefined>>
  saveFailure: string | undefined
  setSaveFailure: Dispatch<SetStateAction<string | undefined>>
} {
  const [draft, setDraftState] = useState<T>(initial)
  const [testPassed, setTestPassed] = useState(false)
  const [testDetail, setTestDetail] = useState<string | undefined>(undefined)
  const [saveFailure, setSaveFailure] = useState<string | undefined>(undefined)
  const patch = (update: Partial<T>): void => {
    setDraftState(previous => ({ ...previous, ...update }))
    setTestPassed(false)
    setTestDetail(undefined)
    setSaveFailure(undefined)
  }
  return { draft, setDraftState, patch, testPassed, setTestPassed, testDetail, setTestDetail, saveFailure, setSaveFailure }
}

/** The server add form: probe-before-save over the ops wire. */
function ServerForm(props: { operations: OpsOperations; t: ServersSectionInjected['t']; onSaved: (nickname: string) => void }): ReactNode {
  const { operations, t, onSaved } = props
  const {
    draft, setDraftState, patch: setDraft, testPassed, setTestPassed,
    testDetail, setTestDetail, saveFailure, setSaveFailure,
  } = useDraft<ServerDraft>(blankServerDraft)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)

  const runTest = (): void => {
    setTesting(true)
    setTestPassed(false)
    setTestDetail(undefined)
    void operations.testServer(toServerInput(draft)).then((result) => {
      setTestPassed(result.ok)
      setTestDetail(result.detail)
    }).finally(() => { setTesting(false) })
  }

  const runSave = (): void => {
    setSaving(true)
    setSaveFailure(undefined)
    void operations.addServer(toServerInput(draft)).then((failure) => {
      if (failure !== undefined) {
        setSaveFailure(failure)
        return
      }
      setDraftState(blankServerDraft)
      setTestPassed(false)
      setTestDetail(undefined)
      onSaved(draft.nickname.trim())
    }).finally(() => { setSaving(false) })
  }

  return (
    <div className={styles.formBlock}>
      <h4 className={styles.formTitle}>{t('addServer')}</h4>
      <FormShell
        t={t}
        draft={draft}
        complete={serverComplete}
        testing={testing}
        testPassed={testPassed}
        testDetail={testDetail}
        saving={saving}
        saveFailure={saveFailure}
        onTest={runTest}
        onSave={runSave}
        testLabel={t('test')}
      >
        <div className={styles.fieldGrid}>
          <Field label={t('nickname')}>
            <input
              className={styles.input}
              value={draft.nickname}
              placeholder={t('nicknamePlaceholder')}
              onChange={(event) => { setDraft({ nickname: event.target.value }) }}
            />
          </Field>
          <Field label={t('host')}>
            <input
              className={styles.input}
              value={draft.host}
              placeholder={t('hostPlaceholder')}
              onChange={(event) => { setDraft({ host: event.target.value }) }}
            />
          </Field>
          <Field label={t('port')}>
            <input
              className={`${styles.input} ${styles.narrowInput}`}
              value={draft.port}
              inputMode="numeric"
              onChange={(event) => { setDraft({ port: event.target.value }) }}
            />
          </Field>
          <Field label={t('username')}>
            <input
              className={styles.input}
              value={draft.username}
              onChange={(event) => { setDraft({ username: event.target.value }) }}
            />
          </Field>
          <Field label={t('authMethod')}>
            <select
              className={`${styles.input} ${styles.selectInput}`}
              value={draft.auth}
              onChange={(event) => { setDraft({ auth: event.target.value === 'password' ? 'password' : 'key' }) }}
            >
              <option value="key">{t('authKey')}</option>
              <option value="password">{t('authPassword')}</option>
            </select>
          </Field>
          {draft.auth === 'key'
            ? (
              <Field label={t('keyPath')}>
                <input
                  className={styles.input}
                  value={draft.keyPath}
                  placeholder={t('keyPathPlaceholder')}
                  onChange={(event) => { setDraft({ keyPath: event.target.value }) }}
                />
              </Field>
            )
            : (
              <Field label={t('password')}>
                <input
                  className={styles.input}
                  type="password"
                  value={draft.password}
                  onChange={(event) => { setDraft({ password: event.target.value }) }}
                />
              </Field>
            )}
          <Field label={t('environment')}>
            <select
              className={`${styles.input} ${styles.selectInput}`}
              value={draft.environment}
              onChange={(event) => { setDraft({ environment: event.target.value as Environment }) }}
            >
              {ENVIRONMENTS.map(environment => <option key={environment} value={environment}>{environment}</option>)}
            </select>
          </Field>
          <Field label={t('tags')}>
            <input
              className={styles.input}
              value={draft.tags}
              placeholder={t('tagsPlaceholder')}
              onChange={(event) => { setDraft({ tags: event.target.value }) }}
            />
          </Field>
        </div>
      </FormShell>
    </div>
  )
}

/** Map one server draft to its wire input. */
export function toServerInput(draft: ServerDraft): ServerInputWire {
  return {
    nickname: draft.nickname.trim(),
    host: draft.host.trim(),
    port: Number(draft.port),
    username: draft.username.trim(),
    auth: draft.auth === 'key'
      ? { kind: 'key', keyPath: draft.keyPath.trim() }
      : { kind: 'password', password: draft.password },
    environment: draft.environment,
    tags: tagsOf(draft.tags),
  }
}

/** The database add form: probe-before-save over the ops wire. */
function DbForm(props: { operations: OpsOperations; t: ServersSectionInjected['t']; onSaved: (nickname: string) => void }): ReactNode {
  const { operations, t, onSaved } = props
  const {
    draft, setDraftState, patch: setDraft, testPassed, setTestPassed,
    testDetail, setTestDetail, saveFailure, setSaveFailure,
  } = useDraft<DbDraft>(blankDbDraft)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)

  const runTest = (): void => {
    setTesting(true)
    setTestPassed(false)
    setTestDetail(undefined)
    void operations.testDb(toDbInput(draft)).then((result) => {
      setTestPassed(result.ok)
      setTestDetail(result.detail)
    }).finally(() => { setTesting(false) })
  }

  const runSave = (): void => {
    setSaving(true)
    setSaveFailure(undefined)
    void operations.addDb(toDbInput(draft)).then((failure) => {
      if (failure !== undefined) {
        setSaveFailure(failure)
        return
      }
      setDraftState(blankDbDraft)
      setTestPassed(false)
      setTestDetail(undefined)
      onSaved(draft.nickname.trim())
    }).finally(() => { setSaving(false) })
  }

  const redis = draft.kind === 'redis'

  return (
    <div className={styles.formBlock}>
      <h4 className={styles.formTitle}>{t('addDb')}</h4>
      <FormShell
        t={t}
        draft={draft}
        complete={dbComplete}
        testing={testing}
        testPassed={testPassed}
        testDetail={testDetail}
        saving={saving}
        saveFailure={saveFailure}
        onTest={runTest}
        onSave={runSave}
        testLabel={t('test')}
      >
        <div className={styles.fieldGrid}>
          <Field label={t('nickname')}>
            <input
              className={styles.input}
              value={draft.nickname}
              placeholder={t('nicknamePlaceholder')}
              onChange={(event) => { setDraft({ nickname: event.target.value }) }}
            />
          </Field>
          <Field label={t('dbKind')}>
            <select
              className={`${styles.input} ${styles.selectInput}`}
              value={draft.kind}
              onChange={(event) => {
                const kind = event.target.value as DbKind
                setDraft({ kind, port: DB_DEFAULT_PORTS[kind] })
              }}
            >
              {DB_KINDS.map(kind => <option key={kind} value={kind}>{kind}</option>)}
            </select>
          </Field>
          <Field label={t('host')}>
            <input
              className={styles.input}
              value={draft.host}
              placeholder={t('hostPlaceholder')}
              onChange={(event) => { setDraft({ host: event.target.value }) }}
            />
          </Field>
          <Field label={t('port')}>
            <input
              className={`${styles.input} ${styles.narrowInput}`}
              value={draft.port}
              inputMode="numeric"
              onChange={(event) => { setDraft({ port: event.target.value }) }}
            />
          </Field>
          {!redis && (
            <Field label={t('database')}>
              <input
                className={styles.input}
                value={draft.database}
                placeholder={t('databasePlaceholder')}
                onChange={(event) => { setDraft({ database: event.target.value }) }}
              />
            </Field>
          )}
          {!redis && (
            <Field label={t('dbUser')}>
              <input
                className={styles.input}
                value={draft.username}
                onChange={(event) => { setDraft({ username: event.target.value }) }}
              />
            </Field>
          )}
          <Field label={t('password')}>
            <input
              className={styles.input}
              type="password"
              value={draft.password}
              onChange={(event) => { setDraft({ password: event.target.value }) }}
            />
          </Field>
          <Field label={t('environment')}>
            <select
              className={`${styles.input} ${styles.selectInput}`}
              value={draft.environment}
              onChange={(event) => { setDraft({ environment: event.target.value as Environment }) }}
            >
              {ENVIRONMENTS.map(environment => <option key={environment} value={environment}>{environment}</option>)}
            </select>
          </Field>
          <Field label={t('tags')}>
            <input
              className={styles.input}
              value={draft.tags}
              placeholder={t('tagsPlaceholder')}
              onChange={(event) => { setDraft({ tags: event.target.value }) }}
            />
          </Field>
        </div>
      </FormShell>
    </div>
  )
}

/** Map one database draft to its wire input. */
export function toDbInput(draft: DbDraft): DbInputWire {
  return {
    nickname: draft.nickname.trim(),
    kind: draft.kind,
    host: draft.host.trim(),
    port: Number(draft.port),
    database: draft.database.trim(),
    username: draft.username.trim(),
    password: draft.password,
    environment: draft.environment,
    tags: tagsOf(draft.tags),
  }
}
