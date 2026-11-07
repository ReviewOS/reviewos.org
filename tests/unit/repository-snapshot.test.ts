import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalBlobStore } from '../../app/Actions/Git/blobs'
import { snapshotRepository, restoreRepositorySnapshot } from '../../app/Actions/Git/snapshot'

// Real git bundle, restored into a fresh bare repository, then streamed back
// through the storage seam. No live repository or database is altered.
test('repository snapshots retain history, tags, binary files and default branch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-snapshot-'))
  const options = { repositoryRoot: join(root, 'storage/repos'), scratchRoot: join(root, 'scratch') }
  try {
    const source = join(root, 'work'); mkdirSync(source)
    const git = (args: string[], cwd = source) => { const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' }); if (result.exitCode) throw new Error(result.stderr.toString()); return result.stdout.toString() }
    git(['init', '-b', 'development']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.test'])
    writeFileSync(join(source, 'binary'), new Uint8Array([0, 255, 0, 254])); git(['add', '.']); git(['commit', '-m', 'first']); git(['tag', 'v1'])
    writeFileSync(join(source, 'second'), 'all history remains'); git(['add', '.']); git(['commit', '-m', 'second'])
    const destination = join(root, 'storage/repos/fixture/example.git'); mkdirSync(join(root, 'storage/repos/fixture'), { recursive: true }); git(['clone', '--mirror', source, destination])
    const store = new LocalBlobStore(join(root, 'objects'))
    const result = await snapshotRepository({ id: 1, owner: 'fixture', name: 'example' }, store, options)
    const manifest = await new Response(await store.get(result.manifestKey!)).json() as any
    expect(manifest.head).toBe('refs/heads/development'); expect(manifest.refs).toHaveLength(2)
    const bundle = join(root, 'download.bundle'); await Bun.write(bundle, new Response(await store.get(manifest.key)))
    const restored = join(root, 'roundtrip.git'); git(['clone', '--mirror', bundle, restored])
    expect(git(['rev-list', '--all', '--count'], restored).trim()).toBe('2')
    const bytes = Bun.spawnSync(['git', 'show', 'refs/heads/development:binary'], { cwd: restored }).stdout
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([0, 255, 0, 254]))
    const recovered = join(root, 'operator-restored.git')
    const resultRestored = await restoreRepositorySnapshot(1, result.manifestKey!, recovered, store, options)
    expect(resultRestored.refs).toBe(2)
    expect(git(['symbolic-ref', 'HEAD'], recovered).trim()).toBe('refs/heads/development')
    await expect(restoreRepositorySnapshot(1, result.manifestKey!, destination, store, options)).rejects.toThrow('already exists')
    expect((await snapshotRepository({ id: 1, owner: 'fixture', name: 'example' }, store, options)).unchanged).toBe(true)
    expect(git(['rev-list', '--all', '--count'], destination).trim()).toBe('2')
    const prepared = await snapshotRepository({ id: 2, owner: 'fixture', name: 'example' }, store, { ...options, prepareBatch: true })
    expect(prepared.pending).toBe(true)
    expect(prepared.bytes).toBe(0)
    expect(await store.list('repositories/2/snapshots')).toHaveLength(0)
    const checkpoint = await new Response(await store.get(prepared.candidateKey!)).json() as any
    expect(checkpoint.verifiedAt).toBeUndefined()
    // A push between queue batches must not silently replace the prepared revision.
    writeFileSync(join(source, 'third'), 'new live history'); git(['add', '.']); git(['commit', '-m', 'third'])
    git(['fetch', source, '+refs/*:refs/*'], destination)
    const verified = await snapshotRepository({ id: 2, owner: 'fixture', name: 'example' }, store, { ...options, prepareBatch: true, candidateKey: prepared.candidateKey })
    expect(verified.pending).not.toBe(true)
    expect((await snapshotRepository({ id: 2, owner: 'fixture', name: 'example' }, store, { ...options, prepareBatch: true, candidateKey: prepared.candidateKey })).unchanged).toBe(true)
    const pinnedRestore = join(root, 'pinned-restored.git')
    await restoreRepositorySnapshot(2, verified.manifestKey!, pinnedRestore, store, options)
    expect(git(['rev-list', '--all', '--count'], pinnedRestore).trim()).toBe('2')
    expect(git(['rev-list', '--all', '--count'], destination).trim()).toBe('3')
    // Current refs still need a later backup; the old candidate cannot claim them.
    expect((await snapshotRepository({ id: 2, owner: 'fixture', name: 'example' }, store, { ...options, prepareBatch: true })).pending).toBe(true)
    const corrupt = await snapshotRepository({ id: 3, owner: 'fixture', name: 'example' }, store, { ...options, prepareBatch: true })
    const bad = await new Response(await store.get(corrupt.candidateKey!)).json() as any
    await store.put(bad.key, 'corrupted prepared bytes')
    await expect(snapshotRepository({ id: 3, owner: 'fixture', name: 'example' }, store, { ...options, prepareBatch: true, candidateKey: corrupt.candidateKey })).rejects.toThrow('checksum failed')
    expect(await store.list('repositories/3/snapshots')).toHaveLength(0)
    await expect(snapshotRepository({ id: 3, owner: 'fixture', name: 'example' }, store, { ...options, candidateKey: prepared.candidateKey })).rejects.toThrow('Invalid repository preparation checkpoint')
    const invalid = join(root, 'storage/repos/fixture/invalid.git'); mkdirSync(invalid); writeFileSync(join(invalid, 'HEAD'), 'not a repository')
    await expect(snapshotRepository({ id: 4, owner: 'fixture', name: 'invalid' }, store, options)).rejects.toThrow('refs could not be read completely')

  } finally { rmSync(root, { recursive: true, force: true }) }
})
