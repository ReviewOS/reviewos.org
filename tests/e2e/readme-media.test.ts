// A README's own images, through the real route.
//
// The claim is two things joined, and neither is worth much alone: that a
// relative reference in repository text is resolved against the repository, and
// that the URL it resolves to actually returns an image a browser will paint.
//
// It failed at both ends. `![card](./public/images/social.png)` reached the
// page as written, so the browser asked for `/{owner}/public/images/social.png`
// - a path in nobody's namespace - and if it had been pointed at `/repos/raw`
// instead it would have got `application/octet-stream` with `nosniff`, which an
// `<img>` refuses. Every image in every mirrored README was a broken icon, and
// it read as the upstream README being broken.
//
// The unit tests cover the arithmetic and the sniffing. This covers the join.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { removeRepositoryDirectory, removeRepositoryOwnerDirectory } from '../helpers/repositoryDirectory'

const created = { ownerId: 0, repositoryId: 0, handle: '', name: '', diskPath: '', temp: '' }

let available = false
let port = 0
let server: any = null

/** A one-pixel PNG, written byte by byte so the fixture cannot rot. */
const PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0,
  0, 144, 119, 83, 222, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 207, 192, 240, 31, 0, 5, 0,
  1, 255, 137, 153, 61, 29, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
])

function unique(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(5))).toString('hex')}`
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'E2E',
      GIT_AUTHOR_EMAIL: 'e2e@example.com',
      GIT_COMMITTER_NAME: 'E2E',
      GIT_COMMITTER_EMAIL: 'e2e@example.com',
    },
  })

  const [, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  if (code !== 0)
    throw new Error(`git ${args.join(' ')} exited ${code}: ${stderr.trim()}`)

  return ''
}

async function page(path: string): Promise<string> {
  const answer = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { Accept: 'text/html' } })

  return await answer.text()
}

function mediaUrl(path: string): string {
  const query = new URLSearchParams({ owner: created.handle, repo: created.name, ref: 'main', path })

  return `/api/repos/media?${query.toString()}`
}

beforeAll(async () => {
  created.temp = mkdtempSync(join(tmpdir(), 'reviewos-readme-media-'))

  try {
    const { injectGlobalAutoImports } = await import('@stacksjs/server')
    const { route } = await import('@stacksjs/router')

    await injectGlobalAutoImports()
    await (globalThis as any).db.selectFrom('users').select(['id']).limit(1).execute()

    await route.importRoutes()
    server = await route.serve({ port: 0, hostname: '127.0.0.1' })
    port = Number((server as any)?.port ?? (server as any)?.server?.port ?? 0)

    if (!port)
      throw new Error('the router did not report a port')

    const { repositoryPath } = await import('../../app/Actions/Git/storage')
    const { initBare } = await import('../../app/Actions/Git/git')

    created.handle = unique('rdm')
    const owner: any = await (globalThis as any).db
      .insertInto('users')
      .values({ name: 'Readme Media', email: `${created.handle}@example.com`, handle: created.handle, password: 'x' })
      .returning(['id'])
      .executeTakeFirst()

    created.ownerId = Number(owner?.id)

    created.name = unique('repo')
    const resolved = repositoryPath(created.handle, created.name)
    created.diskPath = resolved.path!

    const repository: any = await (globalThis as any).db
      .insertInto('repositories')
      .values({
        owner_type: 'user',
        owner_id: created.ownerId,
        name: created.name,
        description: 'created by the readme media end to end test',
        visibility: 'public',
        default_branch: 'main',
        disk_path: resolved.relative!,
      })
      .returning(['id'])
      .executeTakeFirst()

    created.repositoryId = Number(repository?.id)

    mkdirSync(resolve(created.diskPath, '..'), { recursive: true })
    await initBare(created.diskPath, 'main')

    const work = join(created.temp, 'seed')
    mkdirSync(join(work, 'public', 'images'), { recursive: true })
    mkdirSync(join(work, 'docs'), { recursive: true })
    await git(work, 'init', '--initial-branch=main')

    writeFileSync(join(work, 'public', 'images', 'social.png'), PNG)
    writeFileSync(join(work, 'docs', 'setup.md'), '# Setup\n')
    writeFileSync(join(work, 'notes.txt'), 'not an image at all\n')

    // The two shapes a README puts a banner in: markdown, and a centred block
    // of raw HTML. Both were broken, and fixing only one fixes half of them.
    writeFileSync(
      join(work, 'README.md'),
      [
        '# Rapid App Development',
        '',
        '![Social Card](./public/images/social.png)',
        '',
        '<p align="center"><img src="public/images/social.png" alt="Centred"></p>',
        '',
        '[![npm](https://img.shields.io/npm/v/stacks?style=flat-square)](https://npmjs.com/package/stacks)',
        '',
        '[setup](docs/setup.md)',
        '',
      ].join('\n'),
    )

    await git(work, 'add', '.')
    await git(work, 'commit', '-m', 'a readme with its own images')
    await git(work, 'push', created.diskPath, 'main')

    available = true
  }
  catch (error) {
    console.warn(`[readme-media] skipping: ${error instanceof Error ? error.message : String(error)}`)
    available = false
  }
}, 120_000)

afterAll(async () => {
  try {
    if (created.repositoryId)
      await (globalThis as any).db.deleteFrom('repositories').where('id', '=', created.repositoryId).execute()

    if (created.ownerId)
      await (globalThis as any).db.deleteFrom('users').where('id', '=', created.ownerId).execute()
  }
  catch { /* the files still go, below */ }

  if (created.diskPath) {
    removeRepositoryDirectory(created.diskPath)

    try {
      removeRepositoryOwnerDirectory(created.diskPath)
    }
    catch { /* somebody else's repository lives there too */ }
  }

  if (created.temp)
    rmSync(created.temp, { recursive: true, force: true })

  try {
    server?.stop?.(true)
  }
  catch { /* already down */ }
})

describe('a README on the repository page', () => {
  test('points its relative image at somewhere that serves an image', async () => {
    if (!available)
      return

    const html = await page(`/${created.handle}/${created.name}`)

    expect(html).toContain('/api/repos/media?')
    expect(html).toContain(`path=${encodeURIComponent('public/images/social.png')}`)
    // The failure this replaces: the reference reaching the page as written.
    expect(html).not.toContain('src="./public/images/social.png"')
  })

  test('resolves an image written as raw HTML too', async () => {
    if (!available)
      return

    const html = await page(`/${created.handle}/${created.name}`)

    expect(html).toContain('alt="Centred"')
    expect(html).not.toContain('src="public/images/social.png"')
  })

  test('leaves a badge on another host exactly as written', async () => {
    if (!available)
      return

    const html = await page(`/${created.handle}/${created.name}`)

    expect(html).toContain('https://img.shields.io/npm/v/stacks?style=flat-square')
  })

  test('sends a relative link to the browse screen', async () => {
    if (!available)
      return

    const html = await page(`/${created.handle}/${created.name}`)

    expect(html).toContain(`href="/${created.handle}/${created.name}/tree/main/docs/setup.md"`)
  })
})

describe('the media endpoint', () => {
  test('serves the image as an image, and says so', async () => {
    if (!available)
      return

    const answer = await fetch(`http://127.0.0.1:${port}${mediaUrl('public/images/social.png')}`)

    expect(answer.status).toBe(200)
    expect(answer.headers.get('content-type')).toBe('image/png')
    expect(answer.headers.get('content-disposition')).toBe('inline')

    const bytes = new Uint8Array(await answer.arrayBuffer())

    // Byte-identical, which is what fails if the blob is ever read as UTF-8 on
    // the way through: a PNG that has been decoded and re-encoded is no longer
    // a PNG, and the length is the first thing to go.
    expect(bytes.length).toBe(PNG.length)
    expect([...bytes]).toEqual([...PNG])
  })

  test('makes the response inert', async () => {
    if (!available)
      return

    const answer = await fetch(`http://127.0.0.1:${port}${mediaUrl('public/images/social.png')}`)

    // `nosniff` is what makes the sniffed type the type the browser uses, and
    // the sandbox is what makes an SVG served here unable to reach this origin.
    expect(answer.headers.get('x-content-type-options')).toBe('nosniff')
    expect(answer.headers.get('content-security-policy')).toContain('sandbox')
  })

  test('refuses a file that is not an image, whatever it is called', async () => {
    if (!available)
      return

    const answer = await fetch(`http://127.0.0.1:${port}${mediaUrl('notes.txt')}`)

    expect(answer.status).toBe(404)
  })

  test('refuses a path that is not there', async () => {
    if (!available)
      return

    const answer = await fetch(`http://127.0.0.1:${port}${mediaUrl('public/images/nothing.png')}`)

    expect(answer.status).toBe(404)
  })
})

describe('the raw endpoint, which this does not change', () => {
  test('still refuses to serve a repository binary as its own type', async () => {
    if (!available)
      return

    const query = new URLSearchParams({ owner: created.handle, repo: created.name, ref: 'main', path: 'public/images/social.png' })
    const answer = await fetch(`http://127.0.0.1:${port}/api/repos/raw?${query.toString()}`)

    expect(answer.status).toBe(200)
    expect(answer.headers.get('content-type')).toBe('application/octet-stream')
  })
})
