// Isolate native OS stand-ins. Admission is observed through the real runner HTTP contract.
import { mock } from 'bun:test'
import * as nativeFs from 'node:fs'
import * as nativeOs from 'node:os'
import * as nativeChildProcess from 'node:child_process'

const actualFs = { ...nativeFs }
const actualOs = { ...nativeOs }
const actualChildProcess = { ...nativeChildProcess }
const gib = 1024n ** 3n
let physical = 21n * gib
let important = String(29n * gib)
let unavailable = false
let hostPlatform = 'darwin'
let temporaryInsufficient = false
mock.module('node:fs', () => ({ ...actualFs, statfsSync: () => ({ bavail: physical, bsize: 1n }) }))
mock.module('node:os', () => ({ ...actualOs, platform: () => hostPlatform }))
mock.module('node:child_process', () => ({ ...actualChildProcess, execFileSync: (...args: any[]) => {
  if (unavailable) throw new Error('OS measurement unavailable or timed out')
  const path = args[1].at(-1)
  return temporaryInsufficient && path === actualOs.tmpdir() ? String(10n * gib) : important
} }))

const { runOnce } = await import('../../app/Actions/Runner/localExecutor')
const polls: unknown[] = []
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  polls.push(await request.json())
  return Response.json({ job: null, runner_id: 5 })
} })
try {
  const measure = () => runOnce({ baseUrl: `http://127.0.0.1:${server.port}`, token: 'macos-capacity-fixture', minimumFreeDiskMb: 24 * 1024, workspaceRoot: '/workspace' })
  await measure()
  important = String(24n * gib)
  await measure()
  important = String(23n * gib)
  await measure()
  important = String(29n * gib)
  unavailable = true
  await measure()
  unavailable = false
  for (const malformed of ['', '-1', 'NaN', 'Infinity', '123 invalid']) {
    important = malformed
    await measure()
  }
  important = String(29n * gib)
  temporaryInsufficient = true
  await measure()
  temporaryInsufficient = false
  hostPlatform = 'linux'
  await measure()
  physical = 24n * gib
  unavailable = true
  await measure()
  hostPlatform = 'darwin'
  await measure()
  console.log(JSON.stringify(polls))
}
finally { server.stop(true) }
