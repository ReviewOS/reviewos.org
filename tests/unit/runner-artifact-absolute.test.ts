// `actions/upload-artifact` with an absolute path.
//
// Actions accepts `path: ${{ runner.temp }}/recorded.diff`, and
// zig-anti-virus's differential workflow uploads exactly that on failure. The
// native adapter refused every absolute path, so the one artifact that explains
// a red run was the one that never arrived. An absolute path is now read when
// it lands in the workspace or this job's runner temporary directory, and only
// then.

import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { gunzipSync } from 'node:zlib'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { artifactAction } from '../../app/Actions/Runner/artifactActions'

let root = ''
let workspace = ''
let server: ReturnType<typeof Bun.serve>
let uploaded: Uint8Array = new Uint8Array()
let responseDelay = 0

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'reviewos-artifact-absolute-'))
  workspace = join(root, 'job-1')
  mkdirSync(join(workspace, '.reviewos-runner', 'temp'), { recursive: true })
  mkdirSync(join(workspace, 'zig-out'), { recursive: true })
  writeFileSync(join(workspace, '.reviewos-runner', 'temp', 'recorded.diff'), 'diff --git a b\n')
  writeFileSync(join(workspace, 'zig-out', 'bench.json'), '{}\n')
  writeFileSync(join(root, 'elsewhere.txt'), 'not the job\'s\n')
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    uploaded = new Uint8Array(await request.arrayBuffer())
    const digest = createHash('sha256').update(uploaded).digest('hex')
    if (responseDelay) await Bun.sleep(responseDelay)
    return Response.json({ id: 1, name: request.headers.get('x-artifact-name'), digest, size_bytes: uploaded.length }, { status: 201 })
  } })
})

afterAll(() => {
  server.stop(true)
  rmSync(root, { recursive: true, force: true })
})

async function upload(path: string, signal?: AbortSignal) {
  return await artifactAction({ kind: 'upload', values: { name: 'evidence', path }, workspace, baseUrl: `http://127.0.0.1:${server.port}`, token: 't', output: '', signal })
}

async function entries(): Promise<string[]> {
  return [...(await new Bun.Archive(gunzipSync(uploaded)).files()).keys()].sort()
}

describe('an absolute upload path', () => {
  test('in the runner temporary directory is uploaded, named by its file', async () => {
    const outcome = await upload(join(workspace, '.reviewos-runner', 'temp', 'recorded.diff'))

    expect(outcome.ok, outcome.reason).toBe(true)
    expect(await entries()).toEqual(['recorded.diff'])
  })

  test('in the workspace is the same as the relative path', async () => {
    const outcome = await upload(join(workspace, 'zig-out', 'bench.json'))

    expect(outcome.ok, outcome.reason).toBe(true)
    expect(await entries()).toEqual(['bench.json'])
  })

  test('anywhere else is refused', async () => {
    const outcome = await upload(join(root, 'elsewhere.txt'))

    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toContain('temporary directory')
  })

  test('and a relative path still cannot reach into the runner\'s own directory', async () => {
    expect((await upload('.reviewos-runner/temp/recorded.diff')).ok).toBe(false)
  })
})

test('a valid named upload can finish while its job is still active', async () => {
  const timeout = AbortSignal.timeout.bind(AbortSignal)
  const shortenedLegacyDeadline = spyOn(AbortSignal, 'timeout').mockImplementation(ms => timeout(ms === 300_000 ? 30 : ms))
  responseDelay = 120
  try {
    const outcome = await upload('zig-out/bench.json', new AbortController().signal)
    expect(outcome.ok, outcome.reason).toBe(true)
    expect(await entries()).toEqual(['bench.json'])
  }
  finally {
    responseDelay = 0
    shortenedLegacyDeadline.mockRestore()
  }
})

test('cancelling the job still aborts a named upload', async () => {
  responseDelay = 120
  try {
    await expect(upload('zig-out/bench.json', AbortSignal.timeout(30))).rejects.toThrow()
  }
  finally {
    responseDelay = 0
  }
})
