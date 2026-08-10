import type { CLI } from '@stacksjs/types'
import process from 'node:process'

// Imported rather than relied on as a global: `db` is a server auto-import, and
// a buddy command does not run through the preloader that injects those.
import { db } from '@stacksjs/database'
import { repositoryPath } from '../Actions/Git/storage'

/**
 * Start an import from GitHub.
 *
 * A command rather than an endpoint, for now and deliberately. An import spends
 * somebody else's rate limit and writes a repository's whole history; the
 * person doing it is an operator with shell access during a migration, not a
 * visitor clicking a button. The *progress* is on the API - which is the half
 * people need to watch - and the trigger stays here until there is a reason for
 * it not to.
 */
export default function (cli: CLI) {
  cli
    .command('import:github <source>', 'Import a GitHub repository, with its issues and reviews')
    .option('--owner <handle>', 'The user or organization to own it here', { default: '' })
    .option('--name <name>', 'The name to give it here', { default: '' })
    .option('--private', 'Make the imported repository private', { default: false })
    .option('--map <pairs>', 'Authors you know are the same person: alice=alice,bob=robert', { default: '' })
    .action(async (source: string, options: any) => {
      try {
        await start(String(source), options)
        process.exit(0)
      }
      catch (error) {
        // `console.error` rather than the logger: the logger writes
        // asynchronously and `process.exit` can beat it to the terminal.
        console.error('Could not start the import:')
        console.error(error instanceof Error ? (error.stack ?? error.message) : String(error))
        process.exit(1)
      }
    })
}

async function start(source: string, options: any): Promise<void> {
  const [remoteOwner, remoteName] = source.split('/')

  if (!remoteOwner || !remoteName)
    throw new Error('Name the repository as owner/name, for example acme/api')

  const ownerHandle = String(options.owner ?? '').trim().toLowerCase() || remoteOwner.toLowerCase()
  const name = String(options.name ?? '').trim() || remoteName

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

  const repository: any = await db
    .insertInto('repositories')
    .values({
      owner_type: owner.type,
      owner_id: owner.id,
      name,
      description: `Imported from github.com/${source}`,
      // Private by default when asked, and public otherwise - the same default
      // a new repository gets, because an import is not a reason to change what
      // somebody expects.
      visibility: options.private ? 'private' : 'public',
      default_branch: 'main',
      disk_path: resolved.relative!,
    })
    .returning(['id'])
    .executeTakeFirst()

  /*
   * An operation row, because an import is exactly what operations are for: it
   * is long, it has a state machine, and somebody needs to watch it from a
   * different process than the one running it.
   */
  const operation: any = await db
    .insertInto('operations')
    .values({
      kind: 'repository:import',
      status: 'queued',
      subject_type: 'repository',
      subject_id: Number(repository?.id),
      started_at: new Date().toISOString(),
    })
    .returning(['id'])
    .executeTakeFirst()

  const ImportRepositoryJob = (await import('../Jobs/ImportRepositoryJob')).default

  await ImportRepositoryJob.dispatch({
    repositoryId: Number(repository?.id),
    operationId: Number(operation?.id),
    source: `${remoteOwner}/${remoteName}`,
    claims: String(options.map ?? ''),
  })

  console.log(`Importing github.com/${source} into ${ownerHandle}/${name}`)
  console.log(`  Watch it: GET /api/operations/${operation?.id}`)
  console.log('')
  console.log('The repository is clonable as soon as the git stage finishes, which is first.')
  console.log('Issues and reviews arrive after it.')

  if (!process.env.GITHUB_TOKEN)
    console.log('\nNo GITHUB_TOKEN is set. Public repositories will work, at sixty API calls an hour.')
}

/** The user or organization that will own it, which has to already exist. */
async function resolveOwner(handle: string): Promise<{ type: 'user' | 'organization', id: number }> {
  const organization = await db.selectFrom('organizations').select(['id']).where('handle', '=', handle).executeTakeFirst()

  if (organization)
    return { type: 'organization', id: Number(organization.id) }

  const user = await db.selectFrom('users').select(['id']).where('handle', '=', handle).executeTakeFirst()

  if (user)
    return { type: 'user', id: Number(user.id) }

  throw new Error(`There is no user or organization called ${handle} here. Make one first, or pass --owner.`)
}
