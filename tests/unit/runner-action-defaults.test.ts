import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOnce } from '../../app/Actions/Runner/localExecutor'

for (const nested of [false, true]) {
  test(`action defaults resolve the caller context${nested ? ' through a composite wrapper' : ''} without evaluating supplied input twice`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'reviewos-action-defaults-'))
    const workspace = join(root, 'job-9812')
    const action = join(workspace, '.reviewos/actions/fixture')
    mkdirSync(action, { recursive: true })
    writeFileSync(join(action, 'action.yml'), `inputs:
  repository:
    default: \${{ github.repository }}
  token:
    default: \${{ github.token }}
  caller:
    default: \${{ env.CALLER_VALUE }}
  supplied:
    default: unused
runs:
  using: node20
  main: index.js
`)
    writeFileSync(join(action, 'index.js'), `await Bun.write('result.json', JSON.stringify({ repository: process.env.INPUT_REPOSITORY, tokenMatches: process.env.INPUT_TOKEN === 'synthetic-scoped-job-token', caller: process.env.INPUT_CALLER, supplied: process.env.INPUT_SUPPLIED }))`)
    if (nested) {
      const wrapper = join(workspace, '.reviewos/actions/wrapper')
      mkdirSync(wrapper, { recursive: true })
      writeFileSync(join(wrapper, 'action.yml'), `inputs:
  literal:
    default: unused
runs:
  using: composite
  steps:
    - uses: ./.reviewos/actions/fixture
      with:
        supplied: \${{ inputs.literal }}
`)
    }
    let pending = true
    let logs = ''
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const path = new URL(request.url).pathname
      const body = await request.json().catch(() => ({}))
      if (path.endsWith('/logs')) logs += String(body.content ?? '')
      if (path !== '/api/runner/claim' || !pending) return Response.json({ ok: true, held: true })
      pending = false
      return Response.json({ job: {
        id: 9812, token: 'synthetic-protocol-token', key: 'defaults', checkout: { skip: true },
        env: { CALLER_VALUE: 'workflow-value' },
        secrets: { GITHUB_TOKEN: 'synthetic-scoped-job-token' },
        event: { inputs: { literal: '${{ github.token }}' } },
        steps: [{ uses: nested ? './.reviewos/actions/wrapper' : './.reviewos/actions/fixture', with: { [nested ? 'literal' : 'supplied']: '${{ inputs.literal }}' } }],
        run: { id: 1, number: 1, event: 'push', ref: 'refs/heads/main', head_sha: 'abc' },
        repository_full_name: 'acme/widgets',
      } })
    } })
    try {
      const outcome = await runOnce({ baseUrl: `http://127.0.0.1:${server.port}`, token: 'synthetic-runner', workspaceRoot: root, tools: false })
      expect(outcome?.state, logs).toBe('succeeded')
      expect(JSON.parse(readFileSync(join(workspace, 'result.json'), 'utf8'))).toEqual({ repository: 'acme/widgets', tokenMatches: true, caller: 'workflow-value', supplied: '${{ github.token }}' })
      expect(logs).not.toContain('synthetic-scoped-job-token')
    }
    finally { server.stop(true); rmSync(root, { recursive: true, force: true }) }
  }, 30_000)
}
