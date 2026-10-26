import { db } from '@stacksjs/database'
import registryConfig from '../../../config/registry'
import { ForgeError } from '../Support/forge'
import { dbTimestamp } from '../Support/sql'

export function registryConfigured(): boolean {
  return Boolean(registryConfig.url && registryConfig.token)
}

export function packageName(value: unknown): string {
  const name = String(value ?? '').trim()
  if (name.length > 214 || !/^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/.test(name))
    throw new ForgeError('Use a scoped package name such as @owner/package')
  return name
}

export function packagePath(name: string): string {
  return name.split('/').map(part => encodeURIComponent(part).replace('%40', '@')).join('/')
}

export function packageVersion(value: unknown): string {
  const version = String(value ?? '').trim()
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/.test(version) || version.length > 64)
    throw new ForgeError('Use a semantic version such as 1.2.3')
  return version
}

/** Only fixed Pantry API paths reach the private service. Redirects never carry its token elsewhere. */
export async function pantryRequest(path: string, init: RequestInit = {}): Promise<Response> {
  if (!registryConfigured())
    throw new ForgeError('The package registry is not configured. Set REVIEWOS_REGISTRY_URL and REVIEWOS_REGISTRY_TOKEN.', 503)
  let base: URL
  try { base = new URL(registryConfig.url) }
  catch { throw new ForgeError('The registry service URL is invalid', 503) }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash)
    throw new ForgeError('The registry service URL is invalid', 503)
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${registryConfig.token}`)
  let answer: Response
  try {
    answer = await fetch(`${base.href.replace(/\/$/, '')}${path}`, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(init.method === 'POST' ? 120_000 : 30_000) })
  }
  catch {
    throw new ForgeError('The Pantry registry service is unavailable. Try again shortly.', 503)
  }
  if (answer.status >= 300 && answer.status < 400 || [401, 403].includes(answer.status)) {
    await answer.body?.cancel()
    throw new ForgeError('The Pantry registry service refused the forge connection. Check its URL and service token.', 503)
  }
  return answer
}

export async function pantryJson(path: string, init: RequestInit = {}): Promise<any> {
  const answer = await pantryRequest(path, init)
  if (Number(answer.headers.get('content-length') ?? 0) > 1024 * 1024) {
    await answer.body?.cancel()
    throw new ForgeError('The registry returned too much metadata', 502)
  }
  let data: any
  try {
    const reader = answer.body?.getReader()
    const chunks: ArrayBuffer[] = []
    let size = 0
    if (reader) {
      try {
        while (true) {
          const next = await reader.read()
          if (next.done)
            break
          size += next.value.byteLength
          if (size > 1024 * 1024) {
            await reader.cancel()
            throw new ForgeError('The registry returned too much metadata', 502)
          }
          chunks.push(new Uint8Array(next.value).buffer)
        }
      }
      finally { reader.releaseLock() }
    }
    data = JSON.parse(await new Blob(chunks).text())
    if (!data || typeof data !== 'object')
      throw new Error('Expected a metadata object')
  }
  catch (error) {
    if (error instanceof ForgeError)
      throw error
    throw new ForgeError('The registry returned invalid metadata', 502)
  }
  if (!answer.ok)
    throw new ForgeError(String(data.error ?? 'The registry request failed').slice(0, 500), answer.status === 400 ? 400 : answer.status === 404 ? 404 : answer.status === 409 ? 409 : answer.status === 413 ? 413 : answer.status === 422 ? 422 : 502)
  return data
}

export async function registryPackages(repositoryId: number, offset = 0): Promise<any[]> {
  return db.selectFrom('registry_packages').select(['id', 'name', 'created_at']).where('repository_id', '=', repositoryId).orderBy('name', 'asc').offset(offset).limit(101).execute()
}

export async function requirePackage(repositoryId: number, name: string): Promise<void> {
  const row = await db.selectFrom('registry_packages').select(['id']).where('repository_id', '=', repositoryId).where('name', '=', name).executeTakeFirst()
  if (!row)
    throw new ForgeError('No such package in this repository', 404)
}

/** Reserve a global name once. Failed uploads retain their claim for a safe retry. */
export async function claimPackage(repositoryId: number, name: string): Promise<void> {
  const existing = await db.selectFrom('registry_packages').select(['repository_id']).where('name', '=', name).executeTakeFirst()
  if (existing) {
    if (Number(existing.repository_id) !== repositoryId)
      throw new ForgeError('That package name belongs to another repository', 409)
    return
  }
  try {
    await db.insertInto('registry_packages').values({ repository_id: repositoryId, name, created_at: dbTimestamp(), updated_at: dbTimestamp() }).execute()
  }
  catch (error) {
    // A concurrent first publish may have reserved the same name. Read its
    // authoritative owner; any other failure remains an operational error.
    const winner = await db.selectFrom('registry_packages').select(['repository_id']).where('name', '=', name).executeTakeFirst()
    if (!winner)
      throw error
    if (Number(winner.repository_id) !== repositoryId)
      throw new ForgeError('That package name belongs to another repository', 409)
  }
}

export function registryBase(request: RequestInstance): string {
  return `/api/repos/${encodeURIComponent(request.getParam('owner'))}/${encodeURIComponent(request.getParam('repository'))}/registry`
}

export function publicMetadata(metadata: any, base: string): any {
  const name = packageName(metadata.name)
  const version = packageVersion(metadata.version)
  return { ...metadata, tarballUrl: `${base}/packages/${packagePath(name)}/${encodeURIComponent(version)}/tarball` }
}
