import { lstat, mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { repositoryPath } from './storage'

/** Move the existing bare repository without replacing anything at the destination. */
export async function moveRepository(fromOwner: string, toOwner: string, name: string): Promise<string> {
  const from = repositoryPath(fromOwner, name)
  const to = repositoryPath(toOwner, name)
  if (!from.ok || !to.ok)
    throw new Error('That owner or repository name cannot be used')

  const destination = await lstat(to.path!).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (destination)
    throw new Error(`${toOwner}/${name} already exists on disk`)

  await mkdir(dirname(to.path!), { recursive: true })
  await rename(from.path!, to.path!)
  return to.relative!
}
