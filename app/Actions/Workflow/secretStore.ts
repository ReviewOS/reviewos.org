/**
 * Secrets this instance never held.
 *
 * The roadmap's position, and it is the right one: **the best secret is one we
 * never had.** An encrypted column is a good answer to "where do we keep it",
 * and no answer at all to "what happens when this database is copied". A
 * reference means the value lives in the store an organisation already runs -
 * Vault, a mounted secret directory, whatever their platform hands them - and
 * this instance reads it at the moment a job is handed out and forgets it.
 *
 * **Stores are configured by the operator, never by a repository.** A secret's
 * value may name a store and a path inside it; it may not name a URL. That is
 * the difference between "read this from the store you set up" and "fetch this
 * from an address a repository administrator typed", which is a request this
 * server makes from inside the network on somebody else's say-so.
 */

import { readFile } from 'node:fs/promises'
import { join, normalize } from 'node:path'
import process from 'node:process'

/** How a stored value says it is a reference rather than a value. */
export const REFERENCE_PREFIX = 'reviewos-secret-reference:'

export interface SecretStore {
  name: string
  kind: 'file' | 'vault'
  /** For `vault`, the base address. For `file`, the directory. */
  address: string
  /** For `vault`, a file holding the token. Read per request, so a rotated token is picked up. */
  tokenFile?: string | null
  /** For `vault`, the enterprise namespace, when there is one. */
  namespace?: string | null
}

export interface SecretReference {
  store: string
  /** The path inside the store, with no leading slash. */
  path: string
  /** The field inside what the path returns. Empty when the value is the whole thing. */
  field: string
}

/**
 * Read a reference.
 *
 * `store://name/path/to/thing#FIELD`. Null for anything else, including a URL:
 * a scheme this does not know is a value, and treating an unknown scheme as a
 * fetch is how a secret becomes a request to somewhere nobody chose.
 */
export function parseReference(raw: string): SecretReference | null {
  const text = String(raw ?? '').trim()

  if (!text.startsWith('store://'))
    return null

  const rest = text.slice('store://'.length)
  const [address, field = ''] = rest.split('#')
  const [store, ...segments] = String(address).split('/')

  if (!store || segments.length === 0)
    return null

  const path = segments.join('/')

  // No climbing. On a file store the directory above the root is the rest of
  // the machine, and on Vault it is somebody else's mount.
  if (path.split('/').includes('..'))
    return null

  return { store, path, field: field.trim() }
}

/**
 * The stores this instance knows, from the file `REVIEWOS_SECRET_STORES` names.
 *
 * A file rather than a set of environment variables, because the list is a
 * mapping and the environment is not - and because a Vault token belongs in a
 * file the platform mounts rather than in a variable that appears in every
 * `ps` and every crash report.
 *
 * Never throws. A file that is missing or malformed means no stores, and a
 * reference to a store that does not exist fails the job that needed it with
 * the name in the message - which is the failure an operator can act on.
 */
export async function configuredStores(path = process.env.REVIEWOS_SECRET_STORES): Promise<Record<string, SecretStore>> {
  const file = String(path ?? '').trim()

  if (!file)
    return {}

  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    const stores: Record<string, SecretStore> = {}

    for (const [name, raw] of Object.entries(parsed ?? {})) {
      if (!raw || typeof raw !== 'object')
        continue

      const entry = raw as Record<string, unknown>
      const kind = String(entry.kind ?? '').toLowerCase()

      if (kind !== 'file' && kind !== 'vault')
        continue

      stores[name] = {
        name,
        kind,
        address: String(entry.address ?? ''),
        tokenFile: entry.tokenFile === undefined ? null : String(entry.tokenFile),
        namespace: entry.namespace === undefined ? null : String(entry.namespace),
      }
    }

    return stores
  }
  catch {
    return {}
  }
}

export interface ResolvedSecret {
  ok: boolean
  value: string
  /** Why not, in words an operator can act on. Never carries the value. */
  reason: string
}

/**
 * One reference, resolved.
 *
 * Failure is loud on purpose. A credential that resolves to an empty string is
 * a job that authenticates as nobody and fails somewhere far from the cause;
 * the caller turns this into a refusal to start the job, naming the secret.
 */
export async function resolveReference(
  reference: SecretReference,
  stores: Record<string, SecretStore>,
  fetcher: typeof fetch = fetch,
): Promise<ResolvedSecret> {
  const store = stores[reference.store]

  if (!store)
    return { ok: false, value: '', reason: `no secret store called \`${reference.store}\` is configured on this instance` }

  if (store.kind === 'file')
    return readFromFile(store, reference)

  return readFromVault(store, reference, fetcher)
}

/**
 * A directory the platform mounted: Docker secrets, a Kubernetes volume.
 *
 * The simplest store there is, and the one most instances already have - which
 * is why it is first-party rather than an example in the documentation.
 */
async function readFromFile(store: SecretStore, reference: SecretReference): Promise<ResolvedSecret> {
  const root = normalize(store.address || '/')
  const target = normalize(join(root, reference.path))

  // Checked after normalising, because `a/../../b` is only visible afterwards.
  if (!target.startsWith(root))
    return { ok: false, value: '', reason: 'that path climbs out of the store' }

  try {
    const contents = await readFile(target, 'utf8')

    /*
     * A trailing newline is stripped. Every editor and every `echo >` adds one,
     * and a credential with a newline on the end fails authentication in a way
     * that looks like the credential being wrong rather than like whitespace.
     */
    return { ok: true, value: contents.replace(/\n$/, ''), reason: 'read from the mounted store' }
  }
  catch {
    return { ok: false, value: '', reason: `\`${reference.path}\` is not in the \`${store.name}\` store` }
  }
}

/**
 * HashiCorp Vault, KV version 2.
 *
 * The version matters: v2 wraps the values under `data.data`, and reading a v1
 * path as v2 gets an object where the value should be. The path is passed
 * through as written - `secret/data/deploy` rather than `secret/deploy` - so
 * what an operator puts in a reference is what they would type into the CLI.
 */
async function readFromVault(store: SecretStore, reference: SecretReference, fetcher: typeof fetch): Promise<ResolvedSecret> {
  const token = await vaultToken(store)

  if (!token)
    return { ok: false, value: '', reason: `the \`${store.name}\` store has no readable token file` }

  try {
    const answer = await fetcher(`${store.address.replace(/\/+$/, '')}/v1/${reference.path}`, {
      headers: {
        'X-Vault-Token': token,
        ...(store.namespace ? { 'X-Vault-Namespace': store.namespace } : {}),
        'Accept': 'application/json',
      },
    })

    if (!answer.ok)
      return { ok: false, value: '', reason: `the \`${store.name}\` store answered ${answer.status} for \`${reference.path}\`` }

    const body = await answer.json().catch(() => null) as any
    const data = body?.data?.data ?? body?.data ?? null

    if (!data || typeof data !== 'object')
      return { ok: false, value: '', reason: `\`${reference.path}\` in \`${store.name}\` holds nothing this can read` }

    const field = reference.field || Object.keys(data)[0] || ''
    const value = data[field]

    if (value === undefined || value === null)
      return { ok: false, value: '', reason: `\`${reference.path}\` in \`${store.name}\` has no field \`${field}\`` }

    return { ok: true, value: String(value), reason: 'read from the store' }
  }
  catch (error) {
    /*
     * The message, not the exception. A network error here reaches an operator
     * through a job's log, and a stack trace in a log is a stack trace nobody
     * reads - while "connection refused" is the whole answer.
     */
    return { ok: false, value: '', reason: `the \`${store.name}\` store could not be reached: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** The token, read per request so a rotated one is picked up without a restart. */
async function vaultToken(store: SecretStore): Promise<string> {
  if (!store.tokenFile)
    return ''

  try {
    return (await readFile(store.tokenFile, 'utf8')).trim()
  }
  catch {
    return ''
  }
}
