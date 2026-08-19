import type { CLI } from '@stacksjs/types'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'

// Imported rather than relied on as a global: `db` is a server auto-import and
// a buddy command does not run through the preloader that injects those.
import { db } from '@stacksjs/database'
import { blobStore } from '../Actions/Git/blobs'
import { initBare, runGit } from '../Actions/Git/git'
import { entriesFor, replay, verifyBundle } from '../Actions/Git/wal'

/**
 * Put a repository back the way it was.
 *
 * This is the backup feature and the phase 18 materialization proof in one
 * command, and it ships before any multi-node work does - deliberately, because
 * a write-ahead log nobody has ever restored from is a directory of files with
 * a hopeful name. Running this is what turns it into a backup.
 *
 * The shape is what a replica will do later, done by hand: take the bundles
 * from the blob store, fetch them into a fresh bare repository in sequence
 * order, then replay the ref transactions on top. Phase 18c's `ensureLocal`
 * does exactly this without being asked.
 *
 * **It never writes over a repository that is there.** The destination is a new
 * directory, and the operator moves it into place when they have looked at it.
 * An operation that restores over a live repository is one somebody runs at
 * four in the morning with the wrong argument.
 */
export default function (cli: CLI) {
  cli
    .command('git:restore <repository>', 'Rebuild a repository from its write-ahead log')
    .option('--at <sequence>', 'Stop after this sequence number, rather than replaying everything', { default: '' })
    .option('--into <path>', 'Where to build it. Defaults to a sibling directory', { default: '' })
    .option('--verify', 'Verify every bundle before using it', { default: false })
    .action(async (repository: string, options: any) => {
      try {
        await restore(String(repository), options)
        process.exit(0)
      }
      catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        process.exit(1)
      }
    })
}

async function restore(reference: string, options: any): Promise<void> {
  const [ownerHandle, name] = reference.split('/')

  if (!ownerHandle || !name)
    throw new Error('Name the repository as owner/name, for example acme/app')

  const repositoryId = await resolveRepository(ownerHandle, name)

  if (!repositoryId)
    throw new Error(`${reference} is not a repository on this instance`)

  const through = Number(options.at)
  const entries = await entriesFor(repositoryId, {
    throughSequence: Number.isFinite(through) && through > 0 ? through : undefined,
  })

  if (entries.length === 0)
    throw new Error(`${reference} has no write-ahead log entries. Is GIT_WAL set?`)

  const destination = String(options.into || '').trim()
    || join(process.cwd(), 'storage', 'restored', `${ownerHandle}-${name}-${entries[entries.length - 1]!.sequence}.git`)

  await mkdir(dirname(destination), { recursive: true })

  const created = await initBare(destination, 'main')

  if (!created.ok)
    throw new Error(`could not create ${destination}: ${created.stderr}`)

  console.log(`Restoring ${reference} into ${destination}`)
  console.log(`${entries.length} log entries, through sequence ${entries[entries.length - 1]!.sequence}`)

  const store = await blobStore()
  const scratch = join(destination, 'restore-bundles')
  await mkdir(scratch, { recursive: true })

  let fetched = 0

  /*
   * The objects first, all of them, before any ref moves.
   *
   * A bundle's prerequisites are commits it does not contain, so bundle N can
   * only be fetched once N-1 is in - which is what makes sequence order load
   * bearing rather than tidy.
   */
  for (const entry of entries) {
    if (entry.status === 'void' || !entry.blobKey)
      continue

    const stream = await store.get(entry.blobKey)

    if (!stream) {
      console.error(`  sequence ${entry.sequence}: the bundle is missing from the store (${entry.blobKey})`)

      continue
    }

    const bundlePath = join(scratch, `${String(entry.sequence).padStart(12, '0')}.bundle`)
    await Bun.write(bundlePath, await new Response(stream).arrayBuffer())

    if (options.verify) {
      const verdict = await verifyBundle(destination, bundlePath)

      if (!verdict.ok) {
        console.error(`  sequence ${entry.sequence}: the bundle does not verify - ${verdict.reason}`)

        continue
      }
    }

    // `--force` because the log is the authority here: a later entry moving a
    // ref backwards is a force push that really happened, and refusing to
    // replay it would restore a repository that never existed.
    const result = await runGit(destination, ['fetch', '--force', bundlePath, '+refs/*:refs/*'], {
      timeoutMs: 10 * 60_000,
      priority: 'background',
    })

    if (result.ok)
      fetched += 1
    else
      console.error(`  sequence ${entry.sequence}: ${result.stderr.trim().split('\n')[0]}`)
  }

  const outcome = await replay(destination, entries)

  console.log(`Fetched ${fetched} bundles, applied ${outcome.applied} ref updates`)

  for (const failure of outcome.failed)
    console.error(`  ${failure}`)

  const refs = await runGit(destination, ['for-each-ref', '--format=%(refname) %(objectname)'])

  console.log('\nRestored refs:')
  console.log(refs.stdout.trim() || '  (none)')
  console.log(`\nNothing was written over. Move it into place yourself when you have looked at it:\n  ${destination}`)
}

async function resolveRepository(ownerHandle: string, name: string): Promise<number | null> {
  for (const table of ['users', 'organizations'] as const) {
    const owner: any = await db
      .selectFrom(table)
      .select(['id'])
      .where('handle', '=', ownerHandle)
      .executeTakeFirst()
      .catch(() => null)

    if (!owner)
      continue

    const repository: any = await db
      .selectFrom('repositories')
      .select(['id'])
      .where('owner_type', '=', table === 'users' ? 'user' : 'organization')
      .where('owner_id', '=', Number(owner.id))
      .where('name', '=', name)
      .executeTakeFirst()
      .catch(() => null)

    if (repository)
      return Number(repository.id)
  }

  return null
}
