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
