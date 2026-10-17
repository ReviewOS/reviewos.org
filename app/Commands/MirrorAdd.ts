import type { CLI } from '@stacksjs/types'
import { randomBytes } from 'node:crypto'
import process from 'node:process'

// Imported rather than relied on as a global: `db` is a server auto-import, and
// a buddy command does not run through the preloader that injects those.
import { db } from '@stacksjs/database'
import { initBare } from '../Actions/Git/git'
import { repositoryPath } from '../Actions/Git/storage'

/**
 * Register a mirror of a repository hosted somewhere else.
 *
 * The local name is asked for separately from the remote, because they are two
 * facts and not one: `stacksjs/stacks` upstream is `stacks/stacks` here.
 * Deriving the local name from the remote would make renaming impossible and
 * would quietly collide the moment two hosts use the same owner name.
 *
 * Idempotent. Running it twice updates the mirror rather than creating a
 * second one, so it is safe in a deploy step and safe to re-run when a setting
 * changes.
 */

export interface MirrorOptions {
  remote?: string
  owner?: string
  name?: string
  metadata?: boolean
  interval?: string
  /** The credential to read the upstream with: `MIRROR_TOKEN_<REF>` (see `credentials.ts`). */
  credential?: string
  /** Run the repository's workflows here on every sync that moves something. */
  ci?: boolean
  /** Private here whatever the upstream says. */
  private?: boolean
  /** For tests: what asks GitHub whether the upstream is public. */
  fetchImpl?: typeof fetch
}

export default function (cli: CLI) {
  cli
    .command('mirror:add', 'Register a pull mirror of a repository hosted elsewhere')
    .option('--remote <slug>', 'The upstream repository, as owner/name')
    .option('--owner <handle>', 'The local owner handle (an organization or user)')
    .option('--name <name>', 'The local repository name', { default: '' })
    .option('--metadata', 'Also import issues, pull requests and review threads', { default: false })
    .option('--interval <seconds>', 'Seconds between sweeps', { default: '900' })
    .option('--credential <ref>', 'Read the upstream with MIRROR_TOKEN_<REF>, for a private repository', { default: '' })
    .option('--ci', 'Run the repository\'s workflows here whenever a sync moves it', { default: false })
    .option('--private', 'Keep the mirror private here, whatever the upstream is', { default: false })
    .action(async (options: MirrorOptions) => {
      try {
        await addMirror(options)
        process.exit(0)
      }
      catch (error) {
        // `console.error` rather than the logger: the logger writes
        // asynchronously and `process.exit` below can beat it to the terminal,
        // which turns a failure into a silent exit code 1.
        console.error('Could not register the mirror:')
        console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
        process.exit(1)
      }
    })
}

/** `owner/name`, rejected rather than guessed at when it is not that shape. */
export function parseRemote(raw: string): { owner: string, name: string } | null {
  const cleaned = String(raw ?? '')
    .trim()
    .replace(/^https?:\/\/(?:www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '')

  const parts = cleaned.split('/')
  if (parts.length !== 2) return null

  const [owner, name] = parts
  if (!owner || !name) return null
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) return null

  return { owner, name }
}

/**
 * Register one mirror, or update the one already there.
 *
 * Exported because `mirror:apply` converges a declared file through this
 * function rather than through inserts of its own: two code paths writing the
 * same rows is how a mirror created one way ends up without the webhook secret
 * the other way generates.
 */
export async function addMirror(options: MirrorOptions): Promise<void> {
  const remote = parseRemote(options.remote ?? '')
  if (!remote)
    throw new Error('--remote must be owner/name, for example stacksjs/stacks')

  const ownerHandle = String(options.owner ?? '').trim()
  if (!ownerHandle)
    throw new Error('--owner is required: the local owner the mirror belongs to')

  // The local name defaults to the remote's, which is the common case, but it
  // is a default rather than a derivation - `--name` overrides it. A dotted
  // name survives now, so `.github` mirrors as `.github`.
  const localName = String(options.name ?? '').trim() || remote.name

  const owner = await resolveOwner(ownerHandle)
  const resolved = repositoryPath(owner.handle, localName)
  if (!resolved.ok || !resolved.path)
    throw new Error(`${owner.handle}/${localName} did not resolve to a safe path`)

  const diskPath = resolved.path

  // The bare repository has to exist before the first fetch, and creating it
  // here means `mirror:add` is the only step needed to go from nothing to a
  // mirror the sweep will pick up.
  await initBare(diskPath)

  const visibility = options.private
    ? 'private'
    : await upstreamVisibility(remote, options.credential, options.fetchImpl)

  const repositoryId = await upsertRepository(owner, localName, diskPath, visibility)
  await upsertMirror(repositoryId, remote, options)

  console.log(`Mirroring ${remote.owner}/${remote.name} as ${owner.handle}/${localName} (${visibility})`)
  console.log(`  repository ${repositoryId} at ${diskPath}`)
  console.log(options.metadata
    ? '  metadata sync enabled (issues, pull requests, review threads)'
    : '  code only; pass --metadata to import issues and pull requests too')
  if (options.ci)
    console.log('  workflows run here on every sync that moves something')
}

/**
 * Whether the upstream is public, asked of GitHub with the token the mirror
 * will fetch with.
 *
 * A mirror used to be created public and made private only by the metadata
 * sync, which runs only when `--metadata` was passed - while the fetch itself
 * falls back to the instance's `GITHUB_TOKEN`, which may well read private
 * repositories. So a private repository mirrored code-only was served to
 * anybody, from its first sync for ever. Now the question is asked before the
 * row exists, and **anything but a clear "public" is private**: no answer, a
 * rate limit or a refusal keeps the code hidden, because a mirror that is
 * private by mistake is one setting away from right, and one that is public by
 * mistake has already been read.
 */
export async function upstreamVisibility(
  remote: { owner: string, name: string },
  credential?: string,
  fetchImpl?: typeof fetch,
): Promise<'public' | 'private'> {
  try {
    const { mirrorToken } = await import('../Actions/Mirror/credentials')
    const { GitHubClient } = await import('../Actions/Mirror/github-client')
    const token = await mirrorToken(credential)
    const found = await new GitHubClient({ token, fetchImpl }).repository(remote.owner, remote.name)

    return found && found.private === false ? 'public' : 'private'
  }
  catch {
    return 'private'
  }
}

async function resolveOwner(handle: string): Promise<{ id: number, handle: string, type: 'organization' | 'user' }> {
  const org = await db
    .selectFrom('organizations')
    .select(['id', 'handle'])
    .where('handle', '=', handle)
    .executeTakeFirst()

  if (org)
    return { id: Number(org.id), handle: String(org.handle), type: 'organization' }

  const user = await db
    .selectFrom('users')
    .select(['id', 'handle'])
    .where('handle', '=', handle)
    .executeTakeFirst()

  if (user)
    return { id: Number(user.id), handle: String(user.handle), type: 'user' }

  throw new Error(`No organization or user is called ${handle}`)
}

async function upsertRepository(
  owner: Awaited<ReturnType<typeof resolveOwner>>,
  name: string,
  diskPath: string,
  visibility: 'public' | 'private',
): Promise<number> {
  const existing = await db
    .selectFrom('repositories')
    .select(['id'])
    .where('owner_type', '=', owner.type)
    .where('owner_id', '=', owner.id)
    .where('name', '=', name)
    .executeTakeFirst()

  if (existing) {
    // Made private when it should be, never public: a repository somebody
    // chose to hide here stays hidden even if its upstream is open.
    await db
      .updateTable('repositories')
      .set(visibility === 'private' ? { disk_path: diskPath, visibility } : { disk_path: diskPath })
      .where('id', '=', Number(existing.id))
      .execute()
    return Number(existing.id)
  }

  const inserted = await db
    .insertInto('repositories')
    .values({
      owner_type: owner.type,
      owner_id: owner.id,
      name,
      // As open as the upstream and no more (`upstreamVisibility`): a public
      // repository mirrored privately would hide it from the people who can
      // already read it there, and the other way round leaks it.
      visibility,
      default_branch: 'main',
      disk_path: diskPath,
    })
    .returning(['id'])
    .executeTakeFirst()

  return Number(inserted?.id)
}

async function upsertMirror(
  repositoryId: number,
  remote: { owner: string, name: string },
  options: MirrorOptions,
): Promise<void> {
  /*
   * A generated webhook secret, printed once.
   *
   * Webhook-driven sync fails closed without one - `MirrorWebhookAction`
   * ignores a delivery it cannot verify rather than trusting it - so a mirror
   * created without a secret would silently fall back to the interval sweep.
   * Generating it here means the fast path works by default and the operator
   * has something to paste into the upstream's hook settings.
   */
  const webhookSecret = randomBytes(32).toString('hex')

  const row = {
    repository_id: repositoryId,
    webhook_secret: webhookSecret,
    direction: 'pull',
    provider: 'github',
    remote_url: `https://github.com/${remote.owner}/${remote.name}.git`,
    remote_owner: remote.owner,
    remote_name: remote.name,
    interval_seconds: Math.max(60, Number(options.interval ?? 900) || 900),
    enabled: true,
    sync_metadata: Boolean(options.metadata),
    credential_ref: String(options.credential ?? '').trim() || null,
    run_workflows: Boolean(options.ci),
  }

  const existing = await db
    .selectFrom('repository_mirrors')
    .select(['id'])
    .where('repository_id', '=', repositoryId)
    .executeTakeFirst()

  if (existing) {
    /*
     * An existing mirror keeps the secret it already has.
     *
     * Rotating it on every `mirror:add` would break the hook already
     * configured upstream, and the symptom is the worst kind: deliveries keep
     * arriving, keep failing verification, and the mirror quietly falls back to
     * the interval - slower, and with nothing saying why.
     */
    const { webhook_secret: _fresh, ...rest } = row as Record<string, unknown>

    await db
      .updateTable('repository_mirrors')
      .set(rest as any)
      .where('id', '=', Number(existing.id))
      .execute()

    return
  }

  await db.insertInto('repository_mirrors').values(row as any).execute()

  console.log('')
  console.log('Webhook secret (shown once):')
  console.log(`  ${webhookSecret}`)
  console.log('')
  console.log('Paste it into the upstream repository\'s webhook settings. Without it,')
  console.log('deliveries are ignored and the mirror falls back to its interval.')
}
