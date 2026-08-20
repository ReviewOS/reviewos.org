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
  const planned = new Set(plan.changes.map(change => change.local.toLowerCase()))

  for (const mirror of declared.mirrors ?? []) {
    const local = `${mirror.owner}/${localNameOf(mirror)}`

    if (!planned.has(local.toLowerCase()))
      continue

    await addMirror({
      remote: mirror.remote,
      owner: mirror.owner,
      name: mirror.name ?? '',
      metadata: mirror.metadata ?? false,
      interval: String(mirror.interval ?? 900),
    })
  }

  return plan
}

/** Every mirror already here, keyed by the local `owner/name` in lower case. */
async function readExisting(): Promise<Map<string, { local: string, remote: string }>> {
  const found = new Map<string, { local: string, remote: string }>()

  const rows: any[] = await db
    .selectFrom('repository_mirrors')
    .innerJoin('repositories', 'repositories.id', '=', 'repository_mirrors.repository_id')
    .select([
      'repositories.name as name',
      'repositories.owner_type as owner_type',
      'repositories.owner_id as owner_id',
      'repository_mirrors.remote_owner as remote_owner',
      'repository_mirrors.remote_name as remote_name',
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
    found.set(local.toLowerCase(), { local, remote: `${row.remote_owner}/${row.remote_name}` })
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
