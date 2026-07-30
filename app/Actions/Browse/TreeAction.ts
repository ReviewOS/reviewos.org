import { Action } from '@stacksjs/actions'
import { findRepositoryByPath, mayUseService, userFromBasicAuth } from '../Git/access'
import { isSafeRevision, runGit } from '../Git/git'
import { repositoryPath } from '../Git/storage'
import { currentUser } from '../Identity/lookup'

/**
 * List a directory at a ref.
 *
 * `git ls-tree` with a NUL-delimited format, so a filename containing a newline
 * (legal, and a classic way to confuse a parser) cannot split one entry into
 * two.
 */
export default new Action({
  name: 'BrowseTree',
  description: 'List a directory in a repository at a ref',
  method: 'GET',

  async handle(request: any) {
    const owner = String(request.get('owner') ?? '')
    const name = String(request.get('repository') ?? '')
    const ref = String(request.get('ref') ?? 'HEAD')
    const path = String(request.get('path') ?? '')

    if (!isSafeRevision(ref))
      return response.json({ error: 'Invalid ref' }, 422)

    const repository = await findRepositoryByPath(owner, name)
    if (!repository)
      return response.json({ error: 'Not found' }, 404)

    const user = await currentUser(request)
    const viaToken = await userFromBasicAuth(request.headers?.get?.('authorization') ?? null)
    const viewer = user?.id ?? viaToken ?? null

    if (!(await mayUseService(repository, viewer, 'upload-pack')))
      return response.json({ error: 'Not found' }, 404)

    const resolved = repositoryPath(owner, name)
    if (!resolved.ok)
      return response.json({ error: 'Not found' }, 404)

    const target = path ? `${ref}:${path}` : ref
    const result = await runGit(resolved.path!, ['ls-tree', '-z', '--long', target])

    if (!result.ok)
      return response.json({ error: 'No such path at that ref' }, 404)

    const entries = result.stdout
      .split('\0')
      .filter(Boolean)
      .map((line) => {
        // `<mode> <type> <sha> <size>\t<name>`
        const tab = line.indexOf('\t')
        const meta = line.slice(0, tab).split(/\s+/)
        return {
          mode: meta[0],
          type: meta[1],
          sha: meta[2],
          size: meta[3] === '-' ? null : Number(meta[3]),
          name: line.slice(tab + 1),
        }
      })

    return response.json({ ref, path, entries })
  },
})
