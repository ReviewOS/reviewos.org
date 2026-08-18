import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { log } from '@stacksjs/logging'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { canInOrganization } from '../../Permissions'
import { cloneBare, runGit } from '../Git/git'
import { installHooks, useSharedHooks } from '../Git/hooks'
import { repositoryPath } from '../Git/storage'
import { currentUser, organizationRoleOf, resolveOwner } from '../Identity/lookup'
import { DEFAULT_LABELS } from '../Issue/labels'
import { authorizeRepository } from './authorize'
import { recountForks } from './counters'
import { forkName } from './settings'
import { recordSize } from './size'

/**
 * Fork a repository.
 *
 * `git clone --bare --local` from the source on disk, which on a filesystem
 * that supports it hardlinks the object store rather than copying it. A fork of
 * a large repository is then near-instant and costs almost no disk until one
 * side or the other writes new objects, which is the whole reason forking is
 * cheap enough to be the normal way to contribute.
 *
 * What is *not* copied is as deliberate as what is. A fork takes the code and
 * nothing else: no issues, no pull requests, no labels beyond the starting set,
 * no collaborators, no stars. A fork is a place to write a change, not a copy
 * of somebody else's conversation, and every forge that copied the issues
 * across regretted it.
 *
 * Visibility does not travel either. A fork of a private repository starts
 * private, and a fork of a public one starts public: inheriting is the only
 * choice that cannot leak, since the alternative is a default that eventually
 * publishes something.
 */
export default new Action({
  name: 'ForkRepository',
  description: 'Fork a repository into an account or organization',
  method: 'POST',

  /*
   * Declared here so the generated reference lists them and the validator
   * enforces them from the same object. `owner` plus one of `repo` or
   * `repository` is how every repository-scoped endpoint is addressed - see
   * `authorizeRepository` - and a caller that forgets one should be told that
   * rather than shown a 404 that reads as "no such repository".
   */
  validations: {
    owner: { rule: schema.string().required() },
    repo: { rule: schema.string() },
    repository: { rule: schema.string() },
    to: { rule: schema.string() },
  },

  responses: {
    201: { description: 'The fork, with its own owner and name.' },
    401: { description: 'Unauthenticated.' },
    409: { description: 'The destination owner already has a repository with that name.' },
    404: { description: 'No such repository, or none this caller may see. A private repository answers this rather than 403, because a 403 confirms it exists.' },
  },

  async handle(request: RequestInstance) {
    // Reading is the whole requirement. Anybody who can read a repository can
    // fork it - that is what makes a fork the way to contribute without being
    // given write access first.
    const auth = await authorizeRepository(request, 'repository:read')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const source = auth.context.repository
    const user = await currentUser(request)
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const sourceOwner = String(request.get('owner') ?? '').trim().toLowerCase()
    const targetHandle = String(request.get('to') ?? user.handle).trim().toLowerCase()

    const target = await resolveOwner(targetHandle)
    if (!target)
      return response.json({ error: 'No such owner' }, 404)

    if (target.kind === 'organization') {
      const role = await organizationRoleOf(target.id, user.id)
      if (!canInOrganization(role, 'repositories:create'))
        return response.json({ error: `You cannot create a repository in ${target.handle}` }, 403)
    }
    else if (target.id !== user.id) {
      return response.json({ error: 'You can only fork into your own account or an organization you are in' }, 403)
    }

    // Forking your own repository into the same account would be a copy under a
    // different name, which is a rename people did not mean.
    if (source.owner_type === target.kind && Number(source.owner_id) === target.id)
      return response.json({ error: 'You already own this repository' }, 422)

    const existing = await db
      .selectFrom('repositories')
      .select(['name'])
      .where('owner_type', '=', target.kind)
      .where('owner_id', '=', target.id)
      .execute()

    const name = forkName(source.name, existing.map((row: any) => String(row.name)))
    if (!name)
      return response.json({ error: `${target.handle} already has too many repositories called ${source.name}` }, 409)

    const from = repositoryPath(sourceOwner, source.name)
    const to = repositoryPath(target.handle, name)

    if (!from.ok || !to.ok)
      return response.json({ error: 'That repository name cannot be used' }, 422)

    const created = await db
      .insertInto('repositories')
      .values({
        owner_type: target.kind,
        owner_id: target.id,
        name,
        description: source.description ?? '',
        visibility: source.visibility,
        default_branch: source.default_branch,
        disk_path: to.relative!,
        is_fork: true,
        parent_id: Number(source.id),
      })
      .returning(['id'])
      .executeTakeFirst()

    const repositoryId = Number(created?.id)

    try {
      await mkdir(dirname(to.path!), { recursive: true })

      const clone = await cloneBare(from.path!, to.path!)
      if (!clone.ok)
        throw new Error(clone.stderr || 'git clone failed')

      // A clone sets `origin` pointing at a path on the server's disk. Nothing
      // reads it, and leaving it is a filesystem path sitting in a config file
      // that a fetch might one day follow.
      await runGit(to.path!, ['remote', 'remove', 'origin'])

      await installHooks()
      if (!(await useSharedHooks(to.path!)))
        log.warn(`[repo] could not point ${to.relative} at the shared hooks; pushes will not be recorded until this is repaired`)
    }
    catch (error) {
      await db.deleteFrom('repositories').where('id', '=', repositoryId).execute()
      throw error
    }

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

    await recountForks(Number(source.id))
    await recordSize(repositoryId, to.path!)

    return response.json({
      id: repositoryId,
      owner: target.handle,
      name,
      forked_from: `${sourceOwner}/${source.name}`,
      visibility: source.visibility,
      clone_url: `/${target.handle}/${name}.git`,
    }, 201)
  },
})
