import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { canonicalRepositoryIdentity } from '../../app/Actions/Git/hooks'

test('hook identity survives release aliases while rejecting directories outside canonical repository storage', async () => {
  const base = await mkdtemp(join(tmpdir(), 'reviewos-hook-paths-'))
  try {
    const root = join(base, 'persistent', 'repos')
    const actual = join(root, 'owner', 'demo.git')
    const alias = join(base, 'release-repos')
    const outside = join(base, 'outside', 'owner', 'demo.git')
    await mkdir(actual, { recursive: true }); await mkdir(outside, { recursive: true })
    await symlink(root, alias, 'dir')
    expect(await canonicalRepositoryIdentity(actual, alias)).toEqual({ owner: 'owner', name: 'demo' })
    expect(await canonicalRepositoryIdentity(join(alias, 'owner', 'demo.git'), alias)).toEqual({ owner: 'owner', name: 'demo' })
    expect(await canonicalRepositoryIdentity(outside, alias)).toBeNull()
    await symlink(outside, join(root, 'owner', 'escape.git'), 'dir')
    expect(await canonicalRepositoryIdentity(join(root, 'owner', 'escape.git'), alias)).toBeNull()
    expect(await canonicalRepositoryIdentity(join(base, 'retired-release', 'storage', 'repos', 'owner', 'demo.git'), alias)).toBeNull()
  } finally { await rm(base, { recursive: true, force: true }) }
})
