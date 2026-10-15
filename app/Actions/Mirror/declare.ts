/**
 * The mirrors this instance should have, as a file.
 *
 * Every mirror on the deployed instance was added by hand, one
 * `buddy mirror:add` at a time, on a box nobody keeps a record of - which is
 * how `stacksjs/.github` came to be the one repository nobody thought to add.
 * Its absence was invisible from the outside: the organization page read four
 * repositories looking for a profile, found none, and rendered exactly what an
 * organization that never wrote one renders. The fix was a command somebody
 * had to remember to run, which is the same failure one turn later.
 *
 * So the intended set is a file in this repository, applied on every deploy.
 * It is reviewed, it has a history, and applying it twice does nothing the
 * second time.
 *
 * **Additive, and deliberately so.** A declaration that removed whatever it
 * did not mention would, the first time somebody applied a partial file, take
 * a hundred and fourteen mirrors off the instance. What is here and not in the
 * file is reported and left alone - the same rule `app/Actions/Runner/declare.ts`
 * follows, for the same reason: the failure mode of a convergence tool has to
 * be "nothing happened".
 */

import { db } from '@stacksjs/database'
import { addMirror, parseRemote } from '../../Commands/MirrorAdd'
import { isTrue } from '../Support/sql'

/** One line of the file: an upstream repository, and where it lives here. */
export interface DeclaredMirror {
  /** `owner/name` upstream, as GitHub spells it. */
  remote: string
  /** The local owner handle - an organization or a user on this instance. */
  owner: string
  /** The local repository name. Defaults to the upstream's. */
  name?: string
  /** Import issues, pull requests and review threads as well as code. */
  metadata?: boolean
  /** Seconds between sweeps. */
  interval?: number
  /** Run its workflows here on every sync that moves something (`run_workflows`). */
  ci?: boolean
  /** Read the upstream with `MIRROR_TOKEN_<CREDENTIAL>`: a private repository. */
  credential?: string
  /** Private here, whatever the upstream says. */
  private?: boolean
}

export interface DeclaredMirrors {
  mirrors: DeclaredMirror[]
}

export interface MirrorChange {
  /** `owner/name` as it will be known here. */
  local: string
  detail: string
}

export interface MirrorPlan {
  changes: MirrorChange[]
  /** Mirrors on the instance that this file does not mention. Never touched. */
  drift: string[]
  /** Declared mirrors whose owner does not exist here yet, skipped rather than fatal. */
  skipped: MirrorChange[]
}

/**
 * Read a declaration.
 *
 * YAML, like `fleet.yml`, because an operator reading a list of repositories
 * should not have to count brackets. A file that does not parse is an error
 * with the file named in it rather than an exception out of a deploy step.
 */
export function readDeclaration(source: string): { mirrors: DeclaredMirrors, error: string | null } {
  try {
    const parsed = Bun.YAML.parse(String(source ?? '')) as unknown

    if (!parsed || typeof parsed !== 'object')
      return { mirrors: { mirrors: [] }, error: 'that file does not describe any mirrors' }

    const document = parsed as Record<string, unknown>
    const rows = Array.isArray(document.mirrors) ? document.mirrors : []

    const mirrors = rows.map((raw) => {
      const row = (raw ?? {}) as Record<string, any>

      return {
        remote: String(row.remote ?? ''),
        owner: String(row.owner ?? ''),
        name: row.name ? String(row.name) : undefined,
        metadata: row.metadata === undefined ? undefined : Boolean(row.metadata),
        interval: row.interval === undefined ? undefined : Number(row.interval),
        ci: row.ci === undefined ? undefined : Boolean(row.ci),
        credential: row.credential ? String(row.credential) : undefined,
        private: row.private === undefined ? undefined : Boolean(row.private),
      }
    }).filter(row => row.remote && row.owner)

    return { mirrors: { mirrors }, error: null }
  }
  catch (error) {
    return { mirrors: { mirrors: [] }, error: error instanceof Error ? error.message : String(error) }
  }
}

/** What a declared line will be called on this instance. */
export function localNameOf(declared: DeclaredMirror): string {
  const named = String(declared.name ?? '').trim()
  if (named)
    return named

  return parseRemote(declared.remote)?.name ?? ''
}

/**
 * What applying this file would do, without doing any of it.
 *
 * The half an operator runs before a deploy they care about. It reads and
 * writes nothing, which is the property that makes it worth having: a preview
 * that could change something is a preview nobody runs on the day it matters.
 */
export async function planMirrors(declared: DeclaredMirrors): Promise<MirrorPlan> {
  const changes: MirrorChange[] = []
  const skipped: MirrorChange[] = []

  const existing = await readExisting()
  const wanted = new Set<string>()

  for (const mirror of declared.mirrors ?? []) {
    const remote = parseRemote(mirror.remote)
    const name = localNameOf(mirror)
    const local = `${mirror.owner}/${name}`

    if (!remote || !name) {
      skipped.push({ local, detail: `${mirror.remote} is not an owner/name upstream` })
      continue
    }

    wanted.add(local.toLowerCase())

    if (!await ownerExists(mirror.owner)) {
      /*
       * Skipped rather than fatal. This runs in the deploy's pre-start, and a
       * declaration naming an organization somebody has not created yet must
       * not be a release that will not start - the instance is fine, one line
       * of the file is early.
       */
      skipped.push({ local, detail: `no organization or user called ${mirror.owner} on this instance` })
      continue
    }

    if (existing.has(local.toLowerCase())) {
      const current = existing.get(local.toLowerCase())!

      if (current.remote !== `${remote.owner}/${remote.name}`)
        changes.push({ local, detail: `repoint ${local} at ${remote.owner}/${remote.name} (it mirrors ${current.remote})` })

      for (const detail of settingsDrift(local, current, mirror))
        changes.push({ local, detail })

      continue
    }

    changes.push({ local, detail: `mirror ${remote.owner}/${remote.name} as ${local}` })
  }

  const drift = [...existing.keys()]
    .filter(local => !wanted.has(local))
    .map(local => existing.get(local)!.local)
    .sort()

  return { changes, drift, skipped }
}

/**
 * Apply the file.
 *
 * Through `addMirror`, which is what `buddy mirror:add` calls, rather than a
 * second set of inserts: two code paths writing the same rows is how a mirror
 * created one way ends up without the webhook secret the other way generates.
 */
export async function applyMirrors(declared: DeclaredMirrors): Promise<MirrorPlan> {
  const plan = await planMirrors(declared)
  const existing = await readExisting()
  const planned = new Set(plan.changes.map(change => change.local.toLowerCase()))

  for (const mirror of declared.mirrors ?? []) {
    const local = `${mirror.owner}/${localNameOf(mirror)}`

    if (!planned.has(local.toLowerCase()))
      continue

    const current = existing.get(local.toLowerCase())
    const remote = parseRemote(mirror.remote)
    if (current && remote && current.remote.toLowerCase() === `${remote.owner}/${remote.name}`.toLowerCase()) {
      // The same upstream, settings that moved: change those and nothing else.
      // `addMirror` would rewrite the whole row - a fresh interval, metadata
      // off - for a line that only asked for CI.
      await settleSettings(current, mirror)
      continue
    }

    await addMirror({
      remote: mirror.remote,
      owner: mirror.owner,
      name: mirror.name ?? '',
      metadata: mirror.metadata ?? false,
      interval: String(mirror.interval ?? 900),
      credential: mirror.credential,
      ci: mirror.ci ?? false,
      private: mirror.private ?? false,
    })
  }

  return plan
}

/** Every mirror already here, keyed by the local `owner/name` in lower case. */
/** A mirror this instance already has, with the settings a declaration can change. */
export interface ExistingMirror {
  local: string
  remote: string
  mirrorId: number
  repositoryId: number
  runWorkflows: boolean
  credentialRef: string
  visibility: string
}

/**
 * What a line asks to change on a mirror that already exists, in words.
 *
 * Only what the line says: a key it leaves out is no opinion, so a file that
 * predates `ci:` cannot switch CI off on every mirror somebody turned it on
 * for by hand. And never towards public - `private: false` is not a request to
 * publish a repository, because that is not a decision a file applied on
 * every deploy should be able to make.
 */
export function settingsDrift(local: string, current: Pick<ExistingMirror, 'runWorkflows' | 'credentialRef' | 'visibility'>, declared: DeclaredMirror): string[] {
  const drift: string[] = []

  if (declared.ci !== undefined && declared.ci !== current.runWorkflows)
    drift.push(declared.ci ? `run ${local}'s workflows here` : `stop running ${local}'s workflows here`)

  const credential = String(declared.credential ?? '').trim()
  if (credential && credential !== current.credentialRef)
    drift.push(`read ${local} with the ${credential} credential`)

  if (declared.private === true && current.visibility !== 'private')
    drift.push(`make ${local} private`)

  return drift
}

/** Apply `settingsDrift`'s answer, and only that, to an existing mirror. */
async function settleSettings(current: ExistingMirror, declared: DeclaredMirror): Promise<void> {
  const mirror: Record<string, unknown> = {}

  if (declared.ci !== undefined && declared.ci !== current.runWorkflows)
    mirror.run_workflows = declared.ci

  const credential = String(declared.credential ?? '').trim()
  if (credential && credential !== current.credentialRef)
    mirror.credential_ref = credential

  if (Object.keys(mirror).length > 0) {
    await db
      .updateTable('repository_mirrors')
      .set(mirror as any)
      .where('id', '=', current.mirrorId)
      .execute()
  }

  if (declared.private === true && current.visibility !== 'private') {
    await db
      .updateTable('repositories')
      .set({ visibility: 'private' })
      .where('id', '=', current.repositoryId)
      .execute()
  }
}

async function readExisting(): Promise<Map<string, ExistingMirror>> {
  const found = new Map<string, ExistingMirror>()

  const rows: any[] = await db
    .selectFrom('repository_mirrors')
    .innerJoin('repositories', 'repositories.id', '=', 'repository_mirrors.repository_id')
    .select([
      'repositories.id as repository_id',
      'repositories.name as name',
      'repositories.owner_type as owner_type',
      'repositories.owner_id as owner_id',
      'repositories.visibility as visibility',
      'repository_mirrors.id as mirror_id',
      'repository_mirrors.remote_owner as remote_owner',
      'repository_mirrors.remote_name as remote_name',
      'repository_mirrors.run_workflows as run_workflows',
      'repository_mirrors.credential_ref as credential_ref',
    ])
    .execute()
    .catch(() => [])

  if (rows.length === 0)
    return found

  const handles = await ownerHandles(rows)

  for (const row of rows) {
    const handle = handles.get(`${row.owner_type}:${row.owner_id}`)
    if (!handle)
      continue

    const local = `${handle}/${row.name}`
    found.set(local.toLowerCase(), {
      local,
      remote: `${row.remote_owner}/${row.remote_name}`,
      mirrorId: Number(row.mirror_id),
      repositoryId: Number(row.repository_id),
      runWorkflows: isTrue(row.run_workflows),
      credentialRef: String(row.credential_ref ?? ''),
      visibility: String(row.visibility ?? ''),
    })
  }

  return found
}

/** Handles for a page of rows, in two queries rather than one per row. */
async function ownerHandles(rows: readonly any[]): Promise<Map<string, string>> {
  const handles = new Map<string, string>()

  for (const [type, table] of [['user', 'users'], ['organization', 'organizations']] as const) {
    const ids = [...new Set(rows.filter(row => row.owner_type === type).map(row => Number(row.owner_id)))]

    if (ids.length === 0)
      continue

    const found: any[] = await db.selectFrom(table).select(['id', 'handle']).where('id', 'in', ids).execute().catch(() => [])

    for (const row of found)
      handles.set(`${type}:${row.id}`, String(row.handle))
  }

  return handles
}

/** Whether an owner exists here, which is the one thing a declaration cannot create. */
async function ownerExists(handle: string): Promise<boolean> {
  const name = String(handle ?? '').trim()
  if (!name)
    return false

  const org = await db.selectFrom('organizations').select(['id']).where('handle', '=', name).executeTakeFirst().catch(() => undefined)
  if (org)
    return true

  const user = await db.selectFrom('users').select(['id']).where('handle', '=', name).executeTakeFirst().catch(() => undefined)

  return Boolean(user)
}
