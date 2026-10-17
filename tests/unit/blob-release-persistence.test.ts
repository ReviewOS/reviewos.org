import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { tsCloud } from '../../config/cloud'

const root = resolve(import.meta.dir, '../..')
const paths = ['storage/artifacts', 'storage/attachments', 'storage/lfs', 'storage/release-assets', 'storage/wal']

describe('blob storage across atomic releases', () => {
  test('production names one absolute blob root outside disposable releases', () => {
    // This setting is a public filesystem path, not an authentication secret.
    const source = readFileSync(join(root, '.env.production'), 'utf8')
    const value = /^BLOB_LOCAL_ROOT=(.+)$/m.exec(source)?.[1]?.trim().replace(/^['"]|['"]$/g, '') ?? ''
    expect(isAbsolute(value)).toBe(true)
    expect(value).not.toContain('/releases/')
  })

  test('neither server packages a developer or previous runtime blob tree', () => {
    for (const name of ['reviewos', 'api']) {
      const site = tsCloud.sites?.[name]
      for (const path of paths)
        expect(site?.exclude, `${name}: ${path}`).toContain(path)
    }
  })

  test('a fresh API process reads evidence after its writer release is removed', async () => {
    const fixture = mkdtempSync(join(tmpdir(), 'reviewos-blob-releases-'))
    try {
      const oldRelease = join(fixture, 'releases', 'old')
      const newRelease = join(fixture, 'releases', 'new')
      const shared = join(fixture, 'shared', 'blobs')
      mkdirSync(oldRelease, { recursive: true })
      mkdirSync(newRelease, { recursive: true })
      const config = join(fixture, 'bunfig.toml')
      writeFileSync(config, '')
      const script = `
        import { blobStore } from ${JSON.stringify(join(root, 'app/Actions/Git/blobs.ts'))}
        const store = await blobStore()
        const key = 'artifacts/aa/bb/retained-fixture'
        if (process.argv.at(-1) === 'write') await store.put(key, 'retained CI evidence')
        else {
          const body = await store.get(key)
          if (!body) throw new Error('The new release lost its evidence')
          console.log(await new Response(body).text())
        }
      `
      const run = async (cwd: string, phase: string) => {
        const child = Bun.spawn([process.execPath, '--no-env-file', `--config=${config}`, '-e', script, phase], {
          cwd, env: { ...process.env, BLOB_LOCAL_ROOT: shared, BLOB_S3_BUCKET: '' }, stdout: 'pipe', stderr: 'pipe',
        })
        const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
        expect(code, error).toBe(0)
        return output.trim()
      }
      await run(oldRelease, 'write')
      rmSync(oldRelease, { recursive: true })
      expect(await run(newRelease, 'read')).toBe('retained CI evidence')
    }
    finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})
