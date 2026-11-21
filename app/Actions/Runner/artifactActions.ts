import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { setTimeout as pause } from 'node:timers/promises'
import { retryAfterMilliseconds } from '@stacksjs/http'
import { MAX_ARTIFACT_BYTES } from '../Artifact/storage'

interface ArtifactActionInput {
  kind: 'upload' | 'download'
  values: Record<string, unknown>
  workspace: string
  baseUrl: string
  token: string
  output: string
  signal?: AbortSignal
}
const MAX_FILES = 200
function fail(reason: string): never { throw Error(reason) }
function safePath(value: string): boolean {
  return !!value && !isAbsolute(value) && !value.includes('\\') && !value.includes('\0') && !value.split('/').some(part => !part || part === '..' || part === '.' || part === '.git' || part === '.reviewos-runner')
}
function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
async function bounded(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) return fail('Artifact response has no body')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > limit) { await reader.cancel(); fail('Artifact exceeds the byte limit') }
      chunks.push(value)
    }
    return Buffer.concat(chunks, size)
  }
  finally { reader.releaseLock() }
}
function interruptedTransfer(error: unknown): boolean {
  return error instanceof TypeError || ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ConnectionClosed', 'ERR_STREAM_PREMATURE_CLOSE', 'UND_ERR_SOCKET'].includes(String((error as { code?: unknown })?.code ?? ''))
}
const TRANSIENT_ARTIFACT_STATUS = new Set([408, 429, 500, 502, 503, 504])

/** Keep retries within one lease and cover an interrupted body as well as headers. */
async function transferArtifact<T>(kind: 'upload' | 'download', signal: AbortSignal, request: () => Promise<Response>, read: (response: Response) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted()
    let delay = 200 * 2 ** attempt
    try {
      const response = await request()
      if (response.ok) return await read(response)
      delay = retryAfterMilliseconds(response.headers.get('retry-after')) ?? delay
      await response.body?.cancel().catch(() => {})
      if (attempt === 2 || !TRANSIENT_ARTIFACT_STATUS.has(response.status))
        fail(`Artifact ${kind} returned HTTP ${response.status}`)
    }
    catch (error) {
      signal.throwIfAborted()
      if (attempt === 2 || !interruptedTransfer(error)) throw error
    }
    await pause(delay, undefined, { signal })
  }
  return fail(`Artifact ${kind} attempts exhausted`)
}

/** The fetch endpoint only reads an immutable archive. */
async function downloadArchive(controller: string, headers: Record<string, string>, name: string, signal: AbortSignal): Promise<{ expected: string, bytes: Uint8Array }> {
  let expected: string | null = null
  return transferArtifact('download', signal, () => fetch(`${controller}/api/runner/artifacts/fetch`, { method: 'POST', redirect: 'error', signal,
    headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }), async (response) => {
    const received = response.headers.get('X-Artifact-Digest')
    if (!received || !/^[a-f0-9]{64}$/.test(received) || (expected && received !== expected)) {
      await response.body?.cancel().catch(() => {})
      fail('Artifact download digest mismatch')
    }
    expected = received
    const bytes = await bounded(response, MAX_ARTIFACT_BYTES)
    if (digest(bytes) !== expected) fail('Artifact download digest mismatch')
    return { expected, bytes }
  })
}
function checkedDirectory(workspace: string, path: string): string {
  if (!safePath(path)) return fail('Artifact destination must stay inside the workspace')
  const root = realpathSync(workspace)
  let destination = root
  for (const part of path.split('/')) {
    destination = resolve(destination, part)
    if (existsSync(destination) && (!lstatSync(destination).isDirectory() || lstatSync(destination).isSymbolicLink()))
      return fail('Artifact destination contains a link or non-directory')
  }
  if (existsSync(destination) && readdirSync(destination).length) return fail('Artifact destination must be empty')
  return destination
}
/** Named archives retain the job-token run boundary and server retention/quota. */
export async function artifactAction(input: ArtifactActionInput): Promise<{ ok: boolean, reason: string }> {
  try {
    const { values } = input
    const allowed = new Set(input.kind === 'upload' ? ['name', 'path', 'if-no-files-found', 'retention-days', 'compression-level', 'include-hidden-files', 'overwrite'] : ['name', 'path'])
    for (const key of Object.keys(values)) if (!allowed.has(key)) fail(`Artifact input ${key} is not supported by the native adapter`)
    const name = String(values.name ?? 'artifact')
    if (!/^[\w.-]{1,200}$/.test(name)) fail('Artifact name must use letters, numbers, dots, hyphens or underscores')
    const controller = new URL(input.baseUrl).origin
    const headers = { 'Authorization': `Bearer ${input.token}`, 'X-Runner-Protocol': '1' }
    const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000)
    if (input.kind === 'upload') {
      if (String(values.overwrite ?? false) !== 'false' || String(values['include-hidden-files'] ?? false) !== 'false')
        fail('Native artifacts are immutable and exclude hidden files')
      const missing = String(values['if-no-files-found'] ?? 'warn')
      if (!['warn', 'error', 'ignore'].includes(missing)) fail('Invalid if-no-files-found value')
      const retention = Number(values['retention-days'] ?? 7), compression = Number(values['compression-level'] ?? 6)
      if (!Number.isInteger(retention) || retention < 1 || retention > 90 || !Number.isInteger(compression) || compression < 0 || compression > 9)
        fail('Artifact retention or compression is outside its supported range')
      const root = realpathSync(input.workspace)
      const files = new Set<string>(), roots: string[][] = []
      for (const pattern of String(values.path ?? '').split('\n').map(one => one.trim()).filter(Boolean)) {
        if (!safePath(pattern) || pattern.startsWith('!')) fail('Artifact paths must be workspace-relative positive patterns')
        const parts = pattern.split('/'), dynamic = parts.findIndex(part => /[*?\[\]{}]/.test(part))
        const directory = existsSync(resolve(root, pattern)) && lstatSync(resolve(root, pattern)).isDirectory()
        const prefix = directory ? pattern : dynamic < 0 ? dirname(pattern) : parts.slice(0, dynamic).join('/')
        roots.push(prefix === '.' || !prefix ? [] : prefix.split('/'))
        const glob = directory ? `${pattern}/**/*` : pattern
        for await (const file of new Bun.Glob(glob).scan({ cwd: root, onlyFiles: false, dot: false, followSymlinks: false })) {
          if (!safePath(file) || file.split('/').some(part => part.startsWith('.'))) fail('Artifact contains a hidden or unsafe path')
          const full = resolve(root, file), info = lstatSync(full)
          if (info.isDirectory()) continue
          if (!info.isFile() || info.isSymbolicLink() || !realpathSync(full).startsWith(`${root}/`)) fail('Artifact contains a link outside the workspace')
          files.add(file)
          if (files.size > MAX_FILES) fail(`Artifact exceeds the ${MAX_FILES}-file limit`)
        }
      }
      if (!files.size) return { ok: missing !== 'error', reason: `${missing === 'warn' ? 'Warning: ' : ''}No files matched the artifact paths` }
      let common = roots[0] ?? []
      for (const parts of roots.slice(1)) {
        let length = 0
        while (length < common.length && common[length] === parts[length]) length++
        common = common.slice(0, length)
      }
      const entries: Record<string, Uint8Array> = {}
      let size = 0
      for (const file of [...files].sort()) {
        const full = resolve(root, file), info = lstatSync(full)
        size += info.size
        if (size > MAX_ARTIFACT_BYTES) fail('Artifact exceeds the byte limit')
        const entry = relative(resolve(root, ...common), full)
        if (!safePath(entry)) fail('Artifact entry leaves its archive root')
        entries[entry] = readFileSync(full)
      }
      const raw = await new Bun.Archive(entries).bytes()
      if (raw.length > MAX_ARTIFACT_BYTES) fail('Artifact archive exceeds the byte limit')
      const bytes = gzipSync(raw, { level: compression })
      if (bytes.length > MAX_ARTIFACT_BYTES) fail('Artifact archive exceeds the byte limit')
      // The server retains one immutable artifact per run/name/content. The
      // same bytes can safely be replayed if it stored them before the reply broke.
      const receipt = await transferArtifact('upload', signal, () => fetch(`${controller}/api/runner/artifacts`, { method: 'POST', redirect: 'error', signal,
        headers: { ...headers, 'Content-Type': 'application/gzip', 'X-Artifact-Name': name, 'X-Artifact-Retention-Days': String(retention) }, body: bytes }),
      async response => JSON.parse(Buffer.from(await bounded(response, 65536)).toString('utf8')))
      if (!Number.isSafeInteger(receipt.id) || receipt.id <= 0 || receipt.name !== name || receipt.digest !== digest(bytes) || receipt.size_bytes !== bytes.length)
        fail('Artifact upload receipt changed its identity or digest')
      if (input.output) appendFileSync(input.output, `artifact-id=${receipt.id}\nartifact-digest=${receipt.digest}\n`)
      return { ok: true, reason: `Published artifact ${name} (${files.size} files), digest ${receipt.digest}` }
    }
    if (!values.name) fail('Native artifact download requires a name')
    const destination = checkedDirectory(input.workspace, String(values.path ?? name))
    const { expected, bytes } = await downloadArchive(controller, headers, name, signal)
    const raw = gunzipSync(bytes, { maxOutputLength: MAX_ARTIFACT_BYTES })
    const files = await new Bun.Archive(raw).files()
    if (!files.size || files.size > MAX_FILES) fail('Artifact archive has an invalid file count')
    let size = 0
    for (const [name, file] of files) {
      if (!safePath(name)) fail('Artifact archive contains an unsafe path')
      size += file.size
      if (size > MAX_ARTIFACT_BYTES) fail('Artifact archive exceeds the expanded byte limit')
    }
    mkdirSync(destination, { recursive: true })
    for (const [name, file] of files) {
      const target = resolve(destination, name)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, new Uint8Array(await file.arrayBuffer()), { flag: 'wx' })
    }
    if (input.output) appendFileSync(input.output, `download-path=${destination}\n`)
    return { ok: true, reason: `Downloaded and verified artifact ${name} (${files.size} files), digest ${expected}` }
  }
  catch (error) {
    input.signal?.throwIfAborted()
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
