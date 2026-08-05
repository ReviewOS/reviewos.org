import { Action } from '@stacksjs/actions'
import { mkdir, rename } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { recordAudit } from '../Git/audit'
import { repositoryPath } from '../Git/storage'
import { authorizeRepository } from './authorize'
import { recountForks } from './counters'
import { purgeRepository } from './purge'
import { retiredPath } from './settings'

/**
 * Delete a repository.
 *
 * Nothing is unlinked. The bare repository is moved to
 * `storage/repos-deleted/{owner}/{name}.{timestamp}.git` and the row is removed,
 * so an accidental delete is a `mv` away from being undone for as long as the
 * retention sweep leaves it there. The difference between "deleted the wrong
 * repository" and "deleted the wrong repository and it is gone" is not a
 * difference this product should be able to produce.
 *
 * The name has to be typed back, exactly. It is the only confirmation that
 * survives a misdirected click, a stale tab, or a script pointed at the wrong
 * repository - all three of which produce a correctly authorized request for
 * the wrong thing, which is what the permission check cannot catch.
 */
export default new Action({
  name: 'DeleteRepository',
  description: 'Delete a repository, keeping it recoverable',
  method: 'DELETE',

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'repository:delete')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user } = auth.context
    const owner = String(request.get('owner') ?? '').trim().toLowerCase()
    const confirmation = String(request.get('confirm') ?? '').trim()

    if (confirmation !== repository.name && confirmation !== `${owner}/${repository.name}`)
      return response.json({ error: `Type ${owner}/${repository.name} to confirm` }, 422)

    const from = repositoryPath(owner, repository.name)
    const retired = retiredPath(owner, repository.name, Date.now())

    if (!from.ok || !retired)
      return response.json({ error: 'That repository cannot be deleted by name' }, 422)

    // Database first, disk second, and the order is the whole design.
    //
    // Everything that hangs off a repository - issues, pull requests, reviews,
    // stars - has to go before the row will delete, and any of it can fail. A
    // failure here is a delete that did not happen: the row is intact, the
    // directory has not moved, and the repository still works. The other order
    // moves the repository aside and *then* discovers it cannot remove the row,
    // which leaves a repository that is gone from disk and still listed.
    const purged = await purgeRepository(Number(repository.id))
    if (!purged.ok)
      return response.json({ error: purged.error }, 500)

    // Recorded before the row goes, because afterwards there is no id to look
    // up and no name to report. The audit row and the directory on disk are
    // between them the whole record of what happened.
    await recordAudit({
      action: 'repository.deleted',
      subject: { type: 'repository', id: Number(repository.id) },
      actorId: user?.id ?? null,
      detail: { owner, name: repository.name, retired_to: retired, removed: purged.removed },
    })

    const parentId = Number(repository.parent_id ?? 0)

    await db.deleteFrom('repositories').where('id', '=', Number(repository.id)).execute()

    // Deleting a fork is one fewer fork. Recomputed rather than decremented,
    // for the reason every counter here is: an increment nobody can verify is
    // an increment that has been wrong since the day it was written.
    if (parentId > 0)
      await recountForks(parentId)

    const to = resolve(retired)

    try {
      await mkdir(dirname(to), { recursive: true })
      await rename(from.path!, to)
    }
    catch (error: any) {
      // The row is already gone, so this cannot be undone by refusing. A
      // repository whose directory could not be moved is still recoverable -
      // the bare repository is sitting where it always was, under
      // `storage/repos` - so say where it is rather than reporting a failure
      // for a delete that did happen.
      if (error?.code !== 'ENOENT') {
        return response.json({
          deleted: `${owner}/${repository.name}`,
          recoverable_at: from.relative,
          warning: `The repository was deleted, but its files could not be moved aside: ${error}`,
        })
      }
    }

    return response.json({
      deleted: `${owner}/${repository.name}`,
      recoverable_at: retired,
      removed: purged.removed,
    })
  },
})
