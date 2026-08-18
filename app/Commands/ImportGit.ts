import type { CLI } from '@stacksjs/types'
import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import process from 'node:process'

// Imported rather than relied on as a global: `db` is a server auto-import, and
// a buddy command does not run through the preloader that injects those.
import { db } from '@stacksjs/database'
import { mirrorClone, runGit } from '../Actions/Git/git'
import { repositoryPath } from '../Actions/Git/storage'

/**
 * Import any git repository, from any URL, with no metadata.
 *
 * The escape hatch that makes the other importers optional. Somebody moving off
 * a forge nobody has written an importer for - Bitbucket, cgit, a bare
 * repository on a server that is being decommissioned - can still get their
 * history in, today, with one command.
 *
 * **It is honest about what it does not bring.** There are no issues, no pull
 * requests and no reviews, because a git URL does not carry them. Saying so at
 * the point of use matters: an operator who ran this expecting a full migration
 * and found empty issue lists would reasonably conclude the product is broken.
 *
 * Synchronous rather than queued, unlike the GitHub import. There is exactly
 * one step and no rate limit, so a job would add a worker dependency and a
 * progress row to something whose whole duration is one `git clone`.
 */
export default function (cli: CLI) {
  cli
    .command('import:git <url>', 'Import any git repository by URL, with no metadata')
    .option('--owner <handle>', 'The user or organization to own it here', { default: '' })
    .option('--name <name>', 'The name to give it here', { default: '' })
    .option('--private', 'Make the imported repository private', { default: false })
    .action(async (url: string, options: any) => {
      try {
        await importGit(String(url), options)
        process.exit(0)
      }
      catch (error) {
        console.error('Could not import the repository:')
        console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
        process.exit(1)
      }
    })
}

async function importGit(url: string, options: any): Promise<void> {
  const name = String(options.name ?? '').trim() || nameFromUrl(url)

  if (!name)
    throw new Error('Could not work out a name from that URL. Pass --name.')

  const ownerHandle = String(options.owner ?? '').trim().toLowerCase()

  if (!ownerHandle)
    throw new Error('Say who owns it here with --owner.')

  const owner = await resolveOwner(ownerHandle)
  const resolved = repositoryPath(ownerHandle, name)

  if (!resolved.ok)
    throw new Error(`${ownerHandle}/${name} does not resolve to a safe path`)

  const existing = await db
    .selectFrom('repositories')
    .select(['id'])
    .where('owner_type', '=', owner.type)
    .where('owner_id', '=', owner.id)
    .where('name', '=', name)
    .executeTakeFirst()

  if (existing)
    throw new Error(`${ownerHandle}/${name} already exists here. Delete it first, or import under another name.`)

  await mkdir(dirname(resolved.path!), { recursive: true })

  console.log(`Cloning ${url}`)

  // `mirrorClone`, never `runGit`: `runGit` prepends `--git-dir`, which a clone
  // reads as its destination, and its 30 second timeout would kill any real
  // repository mid-transfer.
  const clone = await mirrorClone(url, resolved.path!)

  if (!clone.ok) {
    // Removed before the failure is reported, so a retry is not blocked by a
    // half-written directory that looks like a finished clone.
    await rm(resolved.path!, { recursive: true, force: true }).catch(() => undefined)

    throw new Error(`git clone failed: ${clone.stderr.slice(0, 400)}`)
  }

  /*
   * The remote goes, exactly as it does in the GitHub import.
   *
   * An imported repository is this instance's. Leaving a remote pointing at
   * wherever it came from is how somebody later pushes here, sees it succeed,
   * and finds their change on a server they thought they had left.
   */
  await runGit(resolved.path!, ['remote', 'remove', 'origin'])

  // The branch the clone actually has, rather than a guess. A repository whose
  // default branch is `master` or `trunk` and is recorded as `main` shows an
  // empty file list on its own front page.
  const head = await runGit(resolved.path!, ['symbolic-ref', '--short', 'HEAD'])
  const defaultBranch = head.ok ? head.stdout.trim() : 'main'

  await db.insertInto('repositories').values({
    owner_type: owner.type,
    owner_id: owner.id,
    name,
    description: `Imported from ${url}`,
    visibility: options.private ? 'private' : 'public',
    default_branch: defaultBranch || 'main',
    disk_path: resolved.relative!,
  }).execute()

  console.log(`Imported into ${ownerHandle}/${name}, default branch ${defaultBranch || 'main'}`)
  console.log('')
  console.log('Git history only. A git URL carries no issues, pull requests or reviews -')
  console.log('use `buddy import:github` if they are on GitHub and you want them too.')
}

/**
 * A repository name out of a URL.
 *
 * Handles the three spellings people paste: `https://host/owner/name.git`,
 * `git@host:owner/name.git`, and a local path. The `.git` suffix is stripped
 * because it is a convention of the transport rather than part of the name, and
 * a repository called `api.git` here would be `api.git.git` on disk.
 */
export function nameFromUrl(url: string): string {
  const trimmed = String(url ?? '').trim().replace(/\/+$/, '')
  const last = trimmed.split(/[/:]/).pop() ?? ''

  return last.replace(/\.git$/i, '')
}

/** The user or organization that will own it, which has to already exist. */
async function resolveOwner(handle: string): Promise<{ type: 'user' | 'organization', id: number }> {
  const organization = await db.selectFrom('organizations').select(['id']).where('handle', '=', handle).executeTakeFirst()

  if (organization)
    return { type: 'organization', id: Number(organization.id) }

  const user = await db.selectFrom('users').select(['id']).where('handle', '=', handle).executeTakeFirst()

  if (user)
    return { type: 'user', id: Number(user.id) }

  throw new Error(`There is no user or organization called ${handle} here. Make one first.`)
}
