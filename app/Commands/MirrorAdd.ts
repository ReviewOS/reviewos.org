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

interface MirrorOptions {
  remote?: string
  owner?: string
  name?: string
  metadata?: boolean
  interval?: string
}

export default function (cli: CLI) {
  cli
    .command('mirror:add', 'Register a pull mirror of a repository hosted elsewhere')
    .option('--remote <slug>', 'The upstream repository, as owner/name')
    .option('--owner <handle>', 'The local owner handle (an organization or user)')
    .option('--name <name>', 'The local repository name', { default: '' })
    .option('--metadata', 'Also import issues, pull requests and review threads', { default: false })
    .option('--interval <seconds>', 'Seconds between sweeps', { default: '900' })
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

async function addMirror(options: MirrorOptions): Promise<void> {
  const remote = parseRemote(options.remote ?? '')
  if (!remote)
    throw new Error('--remote must be owner/name, for example stacksjs/stacks')

  const ownerHandle = String(options.owner ?? '').trim()
  if (!ownerHandle)
    throw new Error('--owner is required: the local owner the mirror belongs to')

  // The local name defaults to the remote's, which is the common case, but it
  // is a default rather than a derivation - `--name` overrides it.
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

  const repositoryId = await upsertRepository(owner, localName, diskPath)
  await upsertMirror(repositoryId, remote, options)

  console.log(`Mirroring ${remote.owner}/${remote.name} as ${owner.handle}/${localName}`)
  console.log(`  repository ${repositoryId} at ${diskPath}`)
  console.log(options.metadata
    ? '  metadata sync enabled (issues, pull requests, review threads)'
    : '  code only; pass --metadata to import issues and pull requests too')
}

async function resolveOwner(handle: string): Promise<{ id: number, handle: string, type: 'organization' | 'user' }> {
  const org: any = await db
    .selectFrom('organizations')
    .select(['id', 'handle'])
    .where('handle', '=', handle)
    .executeTakeFirst()

  if (org)
    return { id: Number(org.id), handle: String(org.handle), type: 'organization' }

  const user: any = await db
    .selectFrom('users')
    .select(['id', 'handle'])
    .where('handle', '=', handle)
    .executeTakeFirst()

  if (user)
    return { id: Number(user.id), handle: String(user.handle), type: 'user' }

  throw new Error(`No organization or user is called ${handle}`)
}

async function upsertRepository(
  owner: { id: number, handle: string, type: string },
  name: string,
  diskPath: string,
): Promise<number> {
  const existing: any = await db
    .selectFrom('repositories')
    .select(['id'])
    .where('owner_type', '=', owner.type)
    .where('owner_id', '=', owner.id)
    .where('name', '=', name)
    .executeTakeFirst()

  if (existing) {
    await db
      .updateTable('repositories')
      .set({ disk_path: diskPath })
      .where('id', '=', Number(existing.id))
      .execute()
    return Number(existing.id)
  }

  const inserted: any = await db
    .insertInto('repositories')
    .values({
      owner_type: owner.type,
      owner_id: owner.id,
      name,
      // A mirror of a public repository is public. Anything else would hide it
      // from the people who can already read it upstream.
      visibility: 'public',
      default_branch: 'main',
      disk_path: diskPath,
    } as any)
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
  }

  const existing: any = await db
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
