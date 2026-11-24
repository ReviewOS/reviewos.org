// A download that stops moving fails, and one that keeps moving does not.
//
// b02022bb asked Bun's `fetch` for `timeout: ARTIFACT_IDLE_TIMEOUT_MS`. Bun
// takes no such option: it was a type error on main and, at runtime, nothing at
// all, so a stalled connection held a download until the job's lease ran out.
// The idle half is now a deadline that moves with every chunk. Here it is
// shortened from five minutes to a fraction of a second by mapping that one
// delay, so the test is about the behaviour and not the number.

import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { artifactAction } from '../../app/Actions/Runner/artifactActions'

const IDLE = 300_000
const SHORT = 150

let root = ''
let archive: Uint8Array = new Uint8Array()
let mode: 'flowing' | 'stalled' = 'flowing'
let downloads = 0
let server: ReturnType<typeof Bun.serve>
let workspaces = 0

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'reviewos-artifact-idle-'))
  // Random, so it does not compress into a single chunk.
  archive = gzipSync(await new Bun.Archive({ 'app.bin': crypto.getRandomValues(new Uint8Array(4096)) }).bytes())

  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
    downloads++
    const body = archive
    const headers = { 'X-Artifact-Digest': createHash('sha256').update(body).digest('hex') }
    let offset = 0

    // Small chunks with a gap between them, longer in total than the idle
    // deadline: flowing must survive it, stalled stops after the first chunk.
    return new Response(new ReadableStream({ async pull(controller) {
      if (offset >= body.length)
        return controller.close()
      if (mode === 'stalled' && offset > 0)
        return await Bun.sleep(SHORT * 20)
      await Bun.sleep(offset ? SHORT / 3 : 0)
      controller.enqueue(body.subarray(offset, offset += 256))
    } }), { headers })
  } })
})

afterAll(() => {
  server.stop(true)
  rmSync(root, { recursive: true, force: true })
})

let shortened: ReturnType<typeof spyOn> | null = null

afterEach(() => {
  shortened?.mockRestore()
  shortened = null
})

function shortenIdle(): void {
  const original = globalThis.setTimeout
  shortened = spyOn(globalThis, 'setTimeout').mockImplementation(((handler: any, ms?: number, ...rest: any[]) =>
    original(handler, ms === IDLE ? SHORT : ms, ...rest)) as any)
}

async function download() {
  const workspace = join(root, `job-${++workspaces}`)
  const { mkdirSync } = await import('node:fs')
  mkdirSync(workspace, { recursive: true })
  const outcome = await artifactAction({ kind: 'download', values: { name: 'build', path: 'out' }, workspace, baseUrl: `http://127.0.0.1:${server.port}`, token: 't', output: '', signal: new AbortController().signal })
  return { outcome, workspace }
}

test('a download that keeps moving finishes, however long it takes in all', async () => {
  mode = 'flowing'
  shortenIdle()

  const started = Date.now()
  const { outcome, workspace } = await download()

  expect(outcome.ok, outcome.reason).toBe(true)
  expect(Date.now() - started).toBeGreaterThan(SHORT)
  expect(readFileSync(join(workspace, 'out', 'app.bin'))).toHaveLength(4096)
}, 30_000)

test('a download that stops moving fails as stalled, after its retries', async () => {
  mode = 'stalled'
  downloads = 0
  shortenIdle()

  const { outcome } = await download()

  expect(outcome.ok).toBe(false)
  expect(outcome.reason).toContain('stalled')
  expect(downloads).toBe(3)
}, 30_000)
