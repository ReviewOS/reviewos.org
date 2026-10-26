import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveForTest } from '../helpers/server'

const stamp = crypto.randomUUID().replaceAll('-', '').slice(0, 10)
const owner = `tools${stamp}`
const name = 'native-tools'
let database: any
let userId = 0
let repositoryId = 0
let otherRepositoryId = 0
let issueId = 0
let server: any
let port = 0
let session = ''
let writeToken = ''
let readToken = ''
let projectId = 0
let columns: any[] = []
let itemId = 0
let backend: any
let registryConfig: any
let previousRegistry: any
let registryVisibility = 'private'
let pantryInstance: any
let pantryDirectory = ''
let tarballBytes = new Uint8Array()
let savedPantryEnv: Record<string, string | undefined> = {}
const artifacts = new Map<string, { metadata: any, bytes: ArrayBuffer }>()
const serviceToken = `private-service-${stamp}`

function api(path: string): string { return `/api/repos/${owner}/${name}${path}` }
function url(path: string): string { return `http://127.0.0.1:${port}${path}` }

async function call(path: string, body?: any, token = writeToken): Promise<{ status: number, body: any }> {
  const answer = await fetch(url(api(path)), { method: body ? 'POST' : 'GET', headers: { 'Accept': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: answer.status, body: await answer.json() }
}

async function visit(path: string): Promise<{ answer: Response, html: string, csrf: string }> {
  const answer = await fetch(url(path), { headers: { Cookie: `auth-token=${session}`, Accept: 'text/html' } })
  const html = await answer.text()
  const csrf = /name="_token"[^>]*value="([^"]+)"/.exec(html)?.[1] ?? ''
  return { answer, html, csrf }
}

async function form(path: string, page: { csrf: string }, values: Record<string, string>): Promise<Response> {
  return fetch(url(path), { method: 'POST', redirect: 'manual', headers: { Accept: 'text/html', Cookie: `auth-token=${session}; X-CSRF-Token=${page.csrf}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...values, _token: page.csrf }) })
}

beforeAll(async () => {
  const { injectGlobalAutoImports } = await import('@stacksjs/server')
  await injectGlobalAutoImports()
  database = (globalThis as any).db
  const user = await database.insertInto('users').values({ handle: owner, name: 'Native tools tester', email: `${owner}@example.com`, password: 'unused' }).returning(['id']).executeTakeFirst()
  userId = Number(user.id)
  for (const repositoryName of [name, 'other']) {
    const repository = await database.insertInto('repositories').values({ owner_type: 'user', owner_id: userId, name: repositoryName, visibility: 'private', default_branch: 'main', disk_path: `${owner}/${repositoryName}.git` }).returning(['id']).executeTakeFirst()
    if (repositoryName === name) repositoryId = Number(repository.id)
    else otherRepositoryId = Number(repository.id)
  }
  const issue = await database.insertInto('issues').values({ repository_id: repositoryId, number: 1, author_id: userId, title: 'Ship the native forge tools', body: 'Actual issue', state: 'open', is_pull_request: false }).returning(['id']).executeTakeFirst()
  issueId = Number(issue.id)
  const { createToken } = await import('@stacksjs/auth')
  const issued: any = await createToken(userId, 'native tools browser')
  session = String(issued.plainTextToken ?? issued.token ?? issued.accessToken ?? issued)
  const { generateToken } = await import('../../app/Actions/Tokens/secret')
  for (const level of ['read', 'write']) {
    const secret = generateToken()
    const row = await database.insertInto('access_tokens').values({ user_id: userId, name: `native tools ${level}`, prefix: secret.prefix, token_hash: secret.hash, selection: 'selected', expires_at: new Date(Date.now() + 3600_000).toISOString() }).returning(['id']).executeTakeFirst()
    await database.insertInto('access_token_repositories').values({ access_token_id: Number(row.id), repository_id: repositoryId }).execute()
    await database.insertInto('access_token_permissions').values(['contents', 'wiki', 'projects', 'packages'].map(scope => ({ access_token_id: Number(row.id), scope, level }))).execute()
    if (level === 'write') writeToken = secret.token
    else readToken = secret.token
  }
  backend = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    if (request.headers.get('authorization') !== `Bearer ${serviceToken}`) return Response.json({ error: 'wrong service credential' }, { status: 401 })
    const path = decodeURIComponent(new URL(request.url).pathname)
    if (path === '/api/registry-info') return Response.json({ visibility: registryVisibility, requiresAuth: registryVisibility === 'private', npmFallback: false })
    if (path === '/publish') {
      const data = await request.formData()
      const metadata = JSON.parse(String(data.get('metadata')))
      const file = data.get('tarball') as File
      const key = `${metadata.name}/${metadata.version}`
      if (artifacts.has(key)) return Response.json({ error: 'Version already exists' }, { status: 409 })
      artifacts.set(key, { metadata: { ...metadata, publishedAt: new Date().toISOString(), size: file.size, tarballUrl: 'https://private-service.invalid/bytes', checksum: 'sha256:test' }, bytes: await file.arrayBuffer() })
      return Response.json({ success: true }, { status: 201 })
    }
    const match = /^\/packages\/(@[^/]+\/[^/]+)(?:\/(.*))?$/.exec(path)
    if (!match) return Response.json({ error: 'Unsupported Pantry API path' }, { status: 404 })
    const [, packageName, rest] = match
    const versions = [...artifacts.keys()].filter(key => key.startsWith(`${packageName}/`)).map(key => key.slice(packageName.length + 1))
    if (rest === 'versions') return Response.json({ versions })
    const version = rest?.replace(/\/tarball$/, '') ?? versions.at(-1)
    const artifact = artifacts.get(`${packageName}/${version}`)
    if (!artifact) return Response.json({ error: 'No package' }, { status: 404 })
    return rest?.endsWith('/tarball') ? new Response(artifact.bytes, { headers: { 'Content-Type': 'application/gzip' } }) : Response.json(artifact.metadata)
  } })
  if (process.env.REVIEWOS_TEST_PANTRY_SOURCE) {
    const pantry = await import(process.env.REVIEWOS_TEST_PANTRY_SOURCE)
    pantryDirectory = await mkdtemp(join(tmpdir(), 'reviewos-pantry-integration-'))
    savedPantryEnv = { PANTRY_REGISTRY_TOKEN: process.env.PANTRY_REGISTRY_TOKEN, REGISTRY_VISIBILITY: process.env.REGISTRY_VISIBILITY }
    process.env.PANTRY_REGISTRY_TOKEN = serviceToken
    process.env.REGISTRY_VISIBILITY = 'private'
    pantryInstance = new pantry.Registry({ s3Bucket: 'local', dynamoTable: 'local', baseUrl: backend.url.origin, npmFallback: false, localStoragePath: pantryDirectory })
    const handler = pantry.createHandler(pantryInstance, new pantry.InMemoryAnalytics(), new pantry.InMemoryZigStorage(), backend.url.origin, undefined, undefined, undefined, backend.url.origin, new pantry.DevelopmentScanner())
    backend.reload({ fetch: handler })
  }
  const tarDirectory = await mkdtemp(join(tmpdir(), 'reviewos-test-package-'))
  try {
    await Bun.write(join(tarDirectory, 'package.json'), JSON.stringify({ name: `@${owner}/library`, version: '1.0.0', description: 'Native package' }))
    const packed = Bun.spawn(['tar', '-czf', '-', '-C', tarDirectory, 'package.json'], { stdout: 'pipe', stderr: 'pipe' })
    tarballBytes = new Uint8Array(await new Response(packed.stdout).arrayBuffer())
    if (await packed.exited !== 0) throw new Error(await new Response(packed.stderr).text())
  }
  finally { await rm(tarDirectory, { recursive: true, force: true }) }
  registryConfig = (await import('../../config/registry')).default
  previousRegistry = { ...registryConfig }
  Object.assign(registryConfig, { url: backend.url.origin, token: serviceToken })
  const served = await serveForTest()
  server = served.server
  port = served.port
}, 120_000)

afterAll(async () => {
  if (registryConfig) Object.assign(registryConfig, previousRegistry)
  server?.stop(true)
  backend?.stop(true)
  if (pantryInstance) await pantryInstance.metadata.flush?.()
  if (pantryDirectory) await rm(pantryDirectory, { recursive: true, force: true })
  for (const [key, value] of Object.entries(savedPantryEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (database && userId) {
    await database.deleteFrom('repositories').where('owner_id', '=', userId).where('owner_type', '=', 'user').execute()
    await database.deleteFrom('registry_packages').where('name', 'like', `@${owner}/%`).execute()
    await database.deleteFrom('oauth_access_tokens').where('user_id', '=', userId).execute()
    await database.deleteFrom('access_tokens').where('user_id', '=', userId).execute()
    await database.deleteFrom('users').where('id', '=', userId).execute()
  }
}, 30_000)

describe('native wiki', () => {
  test('creates Markdown with history, safe rendering and raw export', async () => {
    const created = await call('/wiki', { title: 'Home', body: '# Welcome\n\n[Guide](guide.md)\n\n<script server>throw new Error("bad")</script>', summary: 'First page' })
    expect(created.status).toBe(201)
    const shown = await call('/wiki/home')
    expect(shown.status).toBe(200)
    expect(shown.body.html).toContain(`<a href="/${owner}/${name}/wiki/guide"`)
    expect(shown.body.html).not.toContain('<script')
    expect(shown.body.history).toHaveLength(1)
    const raw = await fetch(url(api('/wiki/home?format=raw')), { headers: { Authorization: `Bearer ${readToken}` } })
    expect(raw.headers.get('content-type')).toContain('text/markdown')
    expect(await raw.text()).toContain('# Welcome')
  })
  test('refuses stale writes and keeps both concurrent attempts from succeeding', async () => {
    const attempts = await Promise.all(['First editor', 'Second editor'].map(body => call('/wiki/home', { title: 'Home', body, revision: 1 })))
    expect(attempts.map(answer => answer.status).sort()).toEqual([200, 409])
    expect((await call('/wiki/home')).body.history).toHaveLength(2)
    expect((await call('/wiki/home', { title: 'Home', body: 'no', revision: 2 }, readToken)).status).toBe(403)
  })
  test('renders a signed-in editor and saves with its real cookie and CSRF token', async () => {
    const page = await visit(`/${owner}/${name}/wiki/home?edit=1`)
    expect(page.answer.status).toBe(200)
    expect(page.html).toContain('Save page')
    expect(page.csrf).toBeTruthy()
    const answer = await form(api('/wiki/home'), page, { title: 'Home', body: '# Browser edit', revision: '2', summary: 'Saved from browser' })
    expect(answer.status).toBe(303)
    expect(answer.headers.get('location')).toBe(`/${owner}/${name}/wiki/home`)
    expect((await call('/wiki/home')).body.body).toBe('# Browser edit')
  }, 30_000)
  test('serializes concurrent first saves and previews drafts through the safe renderer', async () => {
    const attempts = await Promise.all(['First draft', 'Second draft'].map(body => call('/wiki', { title: 'Concurrent page', body })))
    expect(attempts.map(answer => answer.status).sort()).toEqual([201, 409])
    expect((await call('/wiki/concurrent-page')).body.history).toHaveLength(1)
    const preview = await call('/wiki-preview', { body: '# Draft\n\n[Home](home.md)\n\n<script>alert(1)</script>' })
    expect(preview.status).toBe(200)
    expect(preview.body.html).toContain(`<a href="/${owner}/${name}/wiki/home"`)
    expect(preview.body.html).not.toContain('<script')
    expect((await call('/wiki-preview', { body: 'not allowed' }, readToken)).status).toBe(403)
  })
  test('deletion preserves history and a historical body can be restored', async () => {
    expect((await call('/wiki/home/delete', { revision: 3 })).status).toBe(200)
    expect((await call('/wiki/home')).status).toBe(404)
    const old = await call('/wiki/home?revision=1&history=1')
    expect(old.body.body).toContain('# Welcome')
    expect((await call('/wiki/home', { title: 'Home', body: old.body.body, revision: 4, summary: 'Restore revision 1' })).status).toBe(200)
    expect((await call('/wiki/home')).body.history).toHaveLength(5)
  })
})

describe('native project boards', () => {
  test('creates a project and links the actual issue', async () => {
    const created = await call('/projects', { title: 'Ship ReviewOS', description: 'Native forge tools' })
    expect(created.status).toBe(201)
    projectId = Number(created.body.id)
    const shown = await call(`/projects/${projectId}`)
    columns = shown.body.columns
    expect(columns.map(column => column.title)).toEqual(['Backlog', 'In progress', 'Done'])
    const added = await call(`/projects/${projectId}/items`, { number: 1, column_id: columns[0].id })
    expect(added.status).toBe(201)
    itemId = Number(added.body.id)
    const board = await call(`/projects/${projectId}`)
    expect(Number(board.body.columns[0].cards[0].issue_id)).toBe(issueId)
    expect((await call(`/projects/${projectId}/items`, { number: 1, column_id: columns[0].id })).status).toBe(409)
  })
  test('moves cards, refuses stale moves, and validates project membership', async () => {
    expect((await call(`/projects/${projectId}/items/${itemId}/move`, { column_id: columns[1].id, revision: 1 })).status).toBe(200)
    expect((await call(`/projects/${projectId}/items/${itemId}/move`, { column_id: columns[2].id, revision: 1 })).status).toBe(409)
    const other = await call('/projects', { title: 'Another board' })
    const otherBoard = await call(`/projects/${other.body.id}`)
    expect((await call(`/projects/${projectId}/items/${itemId}/move`, { column_id: otherBoard.body.columns[0].id, revision: 2 })).status).toBe(404)
    expect((await call(`/projects/${projectId}/columns`, { operation: 'delete', column_id: columns[1].id })).status).toBe(409)
    expect((await call(`/projects/${projectId}/columns`, { operation: 'create', title: 'In review' }, readToken)).status).toBe(403)
  })
  test('uses live issue titles and renders browser board and list controls', async () => {
    await database.updateTable('issues').set({ title: 'Updated actual issue' }).where('id', '=', issueId).execute()
    for (const view of ['board', 'list']) {
      const page = await visit(`/${owner}/${name}/projects/${projectId}?view=${view}`)
      expect(page.answer.status).toBe(200)
      expect(page.html).toContain('Updated actual issue')
      expect(page.html).toContain('Move card')
      expect(page.html).toContain('Column settings')
      expect(page.html).not.toContain('[Error')
    }
  }, 30_000)
  test('paginates a large board and searches across pages before limiting results', async () => {
    await database.insertInto('issues').values(Array.from({ length: 205 }, (_, index) => ({ repository_id: repositoryId, number: 1000 + index, author_id: userId, title: `Backlog task ${index}`, body: '', state: 'open', is_pull_request: false }))).execute()
    const added = await database.selectFrom('issues').select(['id']).where('repository_id', '=', repositoryId).where('number', '>=', 1000).execute()
    await database.insertInto('project_items').values(added.map((issue: any, position: number) => ({ repository_id: repositoryId, project_id: projectId, project_column_id: columns[0].id, issue_id: Number(issue.id), position, revision: 1 }))).execute()
    const first = await call(`/projects/${projectId}`)
    expect(first.body.columns.flatMap((column: any) => column.cards)).toHaveLength(200)
    expect(first.body.next_offset).toBe(200)
    const second = await call(`/projects/${projectId}?offset=200`)
    expect(second.body.columns.flatMap((column: any) => column.cards)).toHaveLength(6)
    expect(second.body.next_offset).toBeNull()
    const filtered = await call(`/projects/${projectId}?q=UPDATED%20ACTUAL%20ISSUE`)
    expect(filtered.body.columns.flatMap((column: any) => column.cards)).toHaveLength(1)
    expect((await call(`/projects/${projectId}?q=%231`)).body.columns.flatMap((column: any) => column.cards)).toHaveLength(1)
    const page = await visit(`/${owner}/${name}/projects/${projectId}?offset=200`)
    expect(page.html).toContain('Previous')
    expect(page.html).not.toContain('[Error')
  }, 30_000)
})

describe('project lifecycle', () => {
  test('manages column order and project lifecycle without deleting linked issues', async () => {
    const created = await call('/projects', { title: 'Lifecycle board' })
    const id = Number(created.body.id)
    const board = (await call(`/projects/${id}`)).body
    const extra = await call(`/projects/${id}/columns`, { operation: 'create', title: 'Review' })
    const columnId = Number(extra.body.id)
    expect(extra.status).toBe(200)
    expect((await call(`/projects/${id}/columns`, { operation: 'rename', column_id: columnId, title: 'Ready for review' })).status).toBe(200)
    expect((await call(`/projects/${id}/columns`, { operation: 'left', column_id: columnId })).status).toBe(200)
    const ordered = (await call(`/projects/${id}`)).body
    expect(ordered.columns.map((column: any) => column.title)).toEqual(['Backlog', 'In progress', 'Ready for review', 'Done'])
    const added = await call(`/projects/${id}/items`, { number: 1, column_id: columnId })
    expect(added.status).toBe(201)
    const cardId = Number(added.body.id)
    expect((await call(`/projects/${id}/items/${cardId}/move`, { column_id: board.columns[0].id, placement: 'first', revision: 1 })).status).toBe(200)
    const second = await call(`/projects/${id}/items`, { number: 1000, column_id: board.columns[0].id })
    const secondId = Number(second.body.id)
    expect((await call(`/projects/${id}/items/${secondId}/move`, { column_id: board.columns[0].id, before_item_id: cardId, revision: 1 })).status).toBe(200)
    expect((await call(`/projects/${id}`)).body.columns[0].cards.map((card: any) => Number(card.id))).toEqual([secondId, cardId])
    expect((await call(`/projects/${id}/items/${secondId}/move`, { column_id: board.columns[0].id, revision: 2 })).status).toBe(200)
    expect((await call(`/projects/${id}`)).body.columns[0].cards.map((card: any) => Number(card.id))).toEqual([cardId, secondId])
    expect((await call(`/projects/${id}/items/${secondId}/move`, { column_id: board.columns[0].id, placement: 'first', revision: 3 })).status).toBe(200)
    expect((await call(`/projects/${id}`)).body.columns[0].cards.map((card: any) => Number(card.id))).toEqual([secondId, cardId])
    expect((await call(`/projects/${id}/columns`, { operation: 'delete', column_id: columnId })).status).toBe(200)
    let current = (await call(`/projects/${id}`)).body.project
    expect((await call(`/projects/${id}`, { state: 'closed', revision: current.revision })).status).toBe(200)
    expect((await call(`/projects/${id}/items/${cardId}/remove`, { revision: 2 })).status).toBe(409)
    expect((await call(`/projects/${id}`, { state: 'open', revision: current.revision })).status).toBe(409)
    current = (await call(`/projects/${id}`)).body.project
    expect((await call(`/projects/${id}`, { state: 'open', revision: current.revision })).status).toBe(200)
    expect((await call(`/projects/${id}/items/${cardId}/remove`, { revision: 2 })).status).toBe(200)
    expect(await database.selectFrom('issues').select(['id']).where('id', '=', issueId).executeTakeFirst()).toBeTruthy()
  })
})

describe('native Pantry registry', () => {
  test('publishes through Pantry and serves protected metadata and bytes', async () => {
    const data = new FormData()
    data.set('metadata', JSON.stringify({ name: `@${owner}/library`, version: '1.0.0', description: 'Native package' }))
    data.set('tarball', new Blob([tarballBytes]), 'package.tgz')
    if (pantryInstance) process.env.REGISTRY_VISIBILITY = 'public'
    else registryVisibility = 'public'
    const unsafeService = await fetch(url(api('/registry/publish')), { method: 'POST', headers: { Authorization: `Bearer ${writeToken}` }, body: data })
    expect(unsafeService.status).toBe(503)
    if (pantryInstance) process.env.REGISTRY_VISIBILITY = 'private'
    else registryVisibility = 'private'
    const answer = await fetch(url(api('/registry/publish')), { method: 'POST', headers: { Authorization: `Bearer ${writeToken}` }, body: data })
    expect(answer.status).toBe(201)
    const shown = await call(`/registry/packages/@${owner}/library`)
    expect(shown.status).toBe(200)
    expect(shown.body.tarballUrl).toBe(`${url(api('/registry'))}/packages/@${owner}/library/1.0.0/tarball`)
    expect(JSON.stringify(shown.body)).not.toContain(serviceToken)
    const download = await fetch(shown.body.tarballUrl, { headers: { Authorization: `Bearer ${readToken}` } })
    expect(download.status).toBe(200)
    expect(download.headers.get('cache-control')).toBe('private, no-store')
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(tarballBytes)
    expect((await fetch(shown.body.tarballUrl)).status).toBe(404)
    expect((await call(`/registry/packages/@${owner}/library/versions`)).body.versions).toEqual(['1.0.0'])
    const duplicate = await fetch(url(api('/registry/publish')), { method: 'POST', headers: { Authorization: `Bearer ${writeToken}` }, body: data })
    expect(duplicate.status).toBe(409)
  })
  test('renders packages and publishing controls for a browser session', async () => {
    const page = await visit(`/${owner}/${name}/packages?name=${encodeURIComponent(`@${owner}/library`)}`)
    expect(page.answer.status).toBe(200)
    expect(page.html).toContain('Native package')
    expect(page.html).toContain('Publish version')
    expect(page.html).toContain('Download tarball')
    expect(page.html).not.toContain(serviceToken)
  }, 30_000)
})

describe('repository boundaries', () => {
  test('deleted repository package names cannot reveal their retained private artifacts to a replacement', async () => {
    const retired = `@${owner}/retired`
    await database.insertInto('registry_packages').values({ repository_id: otherRepositoryId, name: retired }).execute()
    await database.deleteFrom('repositories').where('id', '=', otherRepositoryId).execute()
    const reservation = await database.selectFrom('registry_packages').select(['repository_id']).where('name', '=', retired).executeTakeFirst()
    expect(reservation).toBeTruthy()
    expect(reservation.repository_id).toBeNull()
    const replacement = await database.insertInto('repositories').values({ owner_type: 'user', owner_id: userId, name: 'other', visibility: 'private', default_branch: 'main', disk_path: `${owner}/other.git` }).returning(['id']).executeTakeFirst()
    otherRepositoryId = Number(replacement.id)
    const { claimPackage } = await import('../../app/Actions/Registry/pantry')
    await expect(claimPackage(otherRepositoryId, retired)).rejects.toMatchObject({ status: 409 })
  })
  test('private tools are invisible to strangers and tokens cannot change their repository with body fields', async () => {
    for (const path of ['/wiki', '/projects', '/registry']) expect((await call(path, undefined, '')).status).toBe(404)
    const answer = await fetch(url(`/api/repos/${owner}/other/projects`), { method: 'POST', headers: { Authorization: `Bearer ${writeToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Intrusion', owner, repo: name, repository: name }) })
    expect(answer.status).toBe(404)
    expect(await database.selectFrom('projects').select(['id']).where('repository_id', '=', otherRepositoryId).execute()).toHaveLength(0)
  })
  test('archiving keeps reads and freezes writes', async () => {
    await database.updateTable('repositories').set({ is_archived: true }).where('id', '=', repositoryId).execute()
    for (const path of ['/wiki', '/projects', '/registry']) expect((await call(path)).status).toBe(200)
    expect((await call('/wiki', { title: 'Frozen', body: 'no' })).status).toBe(409)
    expect((await call('/projects', { title: 'Frozen' })).status).toBe(409)
    await database.updateTable('repositories').set({ is_archived: false }).where('id', '=', repositoryId).execute()
  })
})
