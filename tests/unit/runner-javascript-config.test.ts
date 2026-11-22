import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOnce } from '../../app/Actions/Runner/localExecutor'

test('a JavaScript action runs before dependencies without the repository preload or dotenv, in the workflow workspace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-js-runtime-'))
  const workspace = join(root, 'job-9811')
  const action = join(workspace, '.reviewos/actions/fixture')
  mkdirSync(action, { recursive: true })
  writeFileSync(join(workspace, 'bunfig.toml'), 'preload = ["./app-preload.ts"]\n')
  writeFileSync(join(workspace, 'app-preload.ts'), 'await Bun.write("./preload-ran", "unexpected"); throw new Error("Repository preload must not execute in an action");\n')
  writeFileSync(join(workspace, '.env'), 'REVIEWOS_ACTION_FIXTURE_DOTENV=repository-value\n')
  writeFileSync(join(action, 'action.yml'), 'runs:\n  using: node20\n  main: index.js\n')
  writeFileSync(join(action, 'index.js'), `import { realpathSync } from 'node:fs'
await Bun.write('result.json', JSON.stringify({
  inWorkspace: realpathSync(process.cwd()) === realpathSync(process.env.GITHUB_WORKSPACE),
  dotenvLoaded: !!process.env.REVIEWOS_ACTION_FIXTURE_DOTENV,
  workflowValue: process.env.REVIEWOS_ACTION_FIXTURE_WORKFLOW,
}))
`)
  let pending = true
  let logs = ''
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      const body = await request.json().catch(() => ({}))
      if (path.endsWith('/logs')) logs += String(body.content ?? '')
      if (path === '/api/runner/claim') {
        if (!pending) return Response.json({})
        pending = false
        return Response.json({ job: {
          id: 9811, token: 'fixture-job-token', key: 'javascript', checkout: { skip: true },
          env: { REVIEWOS_ACTION_FIXTURE_WORKFLOW: 'workflow-value' },
          steps: [{ uses: './.reviewos/actions/fixture' }],
          run: { id: 1, number: 1, event: 'push', ref: 'refs/heads/main', head_sha: 'abc' },
          repository_full_name: 'acme/widgets',
        } })
      }
      return Response.json({ ok: true, held: true })
    },
  })
  try {
    const outcome = await runOnce({ baseUrl: `http://127.0.0.1:${server.port}`, token: 'fixture-runner', workspaceRoot: root, tools: false })
    expect(outcome?.state, logs).toBe('succeeded')
    expect(existsSync(join(workspace, 'node_modules'))).toBe(false)
    expect(existsSync(join(workspace, 'preload-ran'))).toBe(false)
    expect(JSON.parse(readFileSync(join(workspace, 'result.json'), 'utf8'))).toEqual({ inWorkspace: true, dotenvLoaded: false, workflowValue: 'workflow-value' })
  }
  finally {
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)

test('a JavaScript action gets inputs whose names are not shell identifiers, whatever `bun` is on PATH', async () => {
  // mlugg/setup-zig reads `use-cache` from INPUT_USE-CACHE. Started through
  // pantry's shell launcher for bun, dash dropped that variable on Linux and
  // the action failed on a required input it had been given. The runner now
  // starts actions with its own Bun; a PATH `bun` that cannot run proves it.
  const root = mkdtempSync(join(tmpdir(), 'reviewos-js-inputs-'))
  const workspace = join(root, 'job-9812')
  const action = join(workspace, '.reviewos/actions/fixture')
  const bin = join(root, 'bin')
  mkdirSync(action, { recursive: true })
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'bun'), '#!/bin/sh\necho "not this bun" >&2\nexit 3\n', { mode: 0o755 })
  writeFileSync(join(action, 'action.yml'), 'inputs:\n  use-cache:\n    required: true\n    default: true\n  cache-size-limit:\n    default: 2048\nruns:\n  using: node20\n  main: index.js\n')
  writeFileSync(join(action, 'index.js'), `import { execSync } from 'node:child_process'
await Bun.write('inputs.json', JSON.stringify({
  useCache: process.env['INPUT_USE-CACHE'],
  sizeLimit: process.env['INPUT_CACHE-SIZE-LIMIT'],
  beBun: process.env.BUN_BE_BUN ?? null,
  childBeBun: execSync('env').toString().includes('BUN_BE_BUN'),
}))
`)
  let pending = true
  let logs = ''
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname
      const body = await request.json().catch(() => ({}))
      if (path.endsWith('/logs')) logs += String(body.content ?? '')
      if (path === '/api/runner/claim') {
        if (!pending) return Response.json({})
        pending = false
        return Response.json({ job: {
          id: 9812, token: 'fixture-job-token', key: 'javascript-inputs', checkout: { skip: true },
          env: {},
          steps: [{ uses: './.reviewos/actions/fixture' }],
          run: { id: 1, number: 1, event: 'push', ref: 'refs/heads/main', head_sha: 'abc' },
          repository_full_name: 'acme/widgets',
        } })
      }
      return Response.json({ ok: true, held: true })
    },
  })
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  try {
    const outcome = await runOnce({ baseUrl: `http://127.0.0.1:${server.port}`, token: 'fixture-runner', workspaceRoot: root, tools: false })
    expect(outcome?.state, logs).toBe('succeeded')
    expect(JSON.parse(readFileSync(join(workspace, 'inputs.json'), 'utf8'))).toEqual({ useCache: 'true', sizeLimit: '2048', beBun: null, childBeBun: false })
  }
  finally {
    process.env.PATH = path
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
