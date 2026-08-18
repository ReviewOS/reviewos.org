import { Action } from '@stacksjs/actions'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { canInOrganization } from '../../Permissions'
import { numberSetting, setting } from '../../Ops/settings'
import { DEFAULT_LABELS } from '../Issue/labels'
import { currentUser, organizationRoleOf, resolveOwner } from '../Identity/lookup'
import { log } from '@stacksjs/logging'
import { initBare } from '../Git/git'
import { installHooks, useSharedHooks } from '../Git/hooks'
import { repositoryPath } from '../Git/storage'
import { writeInitialCommit } from './initialCommit'
import { scaffoldFiles } from './scaffold'
import { recordSize } from './size'

/**
 * Create a repository: the row and the bare repository on disk.
 *
 * The two are one unit. A row with no repository behind it answers every clone
 * with a confusing error, and a repository on disk with no row is invisible and
 * never garbage collected. If the disk step fails the row is removed again.
 */
export default new Action({
  name: 'CreateRepository',
  description: 'Create a repository for a user or an organization',
  method: 'POST',

  async handle(request: any) {
    const user = await currentUser(request)
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const name = String(request.get('name') ?? '').trim()
    const ownerHandle = String(request.get('owner') ?? user.handle).trim().toLowerCase()

    const owner = await resolveOwner(ownerHandle)
    if (!owner)
      return response.json({ error: 'No such owner' }, 404)

    // Creating under an organization needs membership; creating under another
    // person is never allowed.
    if (owner.kind === 'organization') {
      const role = await organizationRoleOf(owner.id, user.id)
      if (!canInOrganization(role, 'repositories:create'))
        return response.json({ error: 'Forbidden' }, 403)
    }
    else if (owner.id !== user.id) {
      return response.json({ error: 'Forbidden' }, 403)
    }

    /*
     * The per-account limit, on a personal repository only.
     *
     * An organization's repositories are the organization's, and counting them
     * against whoever happened to press the button would make the limit depend
     * on which member did - which is not a rule anybody could predict. A shared
     * instance that wants to bound an organization wants a different setting,
     * and there is no point inventing one nothing asks for.
     */
    const limit = await numberSetting('max_repositories_per_user')

    if (limit > 0 && owner.kind === 'user') {
      // `db.fn.count`, the shape `app/Actions/Repo/counters.ts` uses. The
      // callback form other query builders take is not supported here, and it
      // fails at runtime rather than at the type check.
      const owned = await db
        .selectFrom('repositories')
        .select(db.fn.count('id').as('n'))
        .where('owner_type', '=', 'user')
        .where('owner_id', '=', owner.id)
        .executeTakeFirst()

      if (Number(owned?.n ?? 0) >= limit)
        return response.json({ error: `This instance allows ${limit} repositories per account.` }, 422)
    }

    const resolved = repositoryPath(owner.handle, name)
    if (!resolved.ok)
      return response.json({ error: 'That repository name cannot be used' }, 422)

    const clash = await db
      .selectFrom('repositories')
      .select(['id'])
      .where('owner_type', '=', owner.kind)
      .where('owner_id', '=', owner.id)
      .where('name', '=', name)
      .executeTakeFirst()

    if (clash)
      return response.json({ error: 'A repository with that name already exists' }, 409)

    /*
     * The instance's default when the caller does not say, rather than `public`.
     *
     * A company instance almost always wants `private`, and getting it wrong
     * once is a repository that was public for however long it took somebody to
     * notice. A caller that names a visibility still gets what it asked for -
     * this is a default, not a policy, and a policy that overrode an explicit
     * request would break every client that sends one.
     */
    const asked = String(request.get('visibility') ?? '').trim()
    const visibility = asked || await setting('default_repository_visibility')

    if (!['public', 'private', 'internal'].includes(visibility))
      return response.json({ error: 'Unknown visibility' }, 422)

    const defaultBranch = String(request.get('default_branch') ?? 'main')

    const created = await db
      .insertInto('repositories')
      .values({
        owner_type: owner.kind,
        owner_id: owner.id,
        name,
        description: String(request.get('description') ?? ''),
        visibility,
        default_branch: defaultBranch,
        disk_path: resolved.relative!,
      })
      .returning(['id'])
      .executeTakeFirst()

    const repositoryId = Number(created?.id)

    try {
      await mkdir(dirname(resolved.path!), { recursive: true })
      const init = await initBare(resolved.path!, defaultBranch)
      if (!init.ok)
        throw new Error(init.stderr || 'git init failed')

      // Point it at the shared hooks, so a push into it reaches the
      // application. Not fatal if it fails: the repository works, clones and
      // accepts pushes without it, and what is lost is the timeline entry
      // rather than the commits. A repository that exists with no history
      // recording beats no repository at all, and `buddy git:hooks` repairs it.
      await installHooks()
      if (!(await useSharedHooks(resolved.path!)))
        log.warn(`[repo] could not point ${resolved.relative} at the shared hooks; pushes will not be recorded until this is repaired`)
    }
    catch (error) {
      await db.deleteFrom('repositories').where('id', '=', repositoryId).execute()
      throw error
    }

    // A first commit, when one was asked for.
    //
    // Not by default, and that is the important half: somebody creating a
    // repository to push an existing history into must get an empty one, or
    // their first push is a non-fast-forward rejection against a commit they
    // never made. So an empty repository stays what you get unless a file is
    // named.
    const scaffold = scaffoldFiles({
      repository: name,
      description: String(request.get('description') ?? ''),
      readme: readFlag(request.get('readme')),
      gitignore: request.get('gitignore'),
      license: request.get('license'),
      holder: String(request.get('license_holder') ?? '') || owner.handle,
    })

    let initialCommit: string | null = null

    if (scaffold.length > 0) {
      const written = await writeInitialCommit(resolved.path!, defaultBranch, scaffold, {
        name: user.handle,
        // A local address rather than the account's own: the commit is made by
        // the server on somebody's behalf, and putting their real address in a
        // commit they did not write publishes it to everyone who clones.
        email: `${user.handle}@users.noreply.${String(request.get('host') ?? 'localhost')}`,
      })

      if (written.ok) {
        initialCommit = written.sha ?? null
        await recordSize(repositoryId, resolved.path!)
      }
      else {
        // The repository exists and works; it is simply empty. Failing the
        // creation over a README would throw away a repository somebody can
        // push to for the sake of a file they can add in one commit.
        log.warn(`[repo] could not write the initial commit for ${resolved.relative}: ${written.error}`)
      }
    }

    // The starting vocabulary for triage. Without it the first person to file
    // an issue has to invent a taxonomy before they can label anything.
    await db
      .insertInto('repository_labels')
      .values(DEFAULT_LABELS.map(label => ({
        repository_id: repositoryId,
        name: label.name,
        color: label.color,
        description: label.description,
        is_default: true,
      })))
      .execute()

    return response.json({
      id: repositoryId,
      owner: owner.handle,
      name,
      visibility,
      default_branch: defaultBranch,
      clone_url: `/${owner.handle}/${name}.git`,
      initial_commit: initialCommit,
    }, 201)
  },
})

/**
 * A checkbox, as a form sends it.
 *
 * Absent is false here rather than "leave alone", because there is nothing yet
 * to leave alone: a repository being created either gets a README or does not.
 */
function readFlag(value: unknown): boolean {
  const text = String(value ?? '').toLowerCase()

  return text === 'true' || text === '1' || text === 'on' || text === 'yes'
}
