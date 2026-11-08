/**
 * Starting and following workflow runs from the CLI.
 *
 * Against a fake instance on a loopback port, so the requests are the real
 * HTTP the commands send and the answers are the shapes the API documents.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import process from 'node:process'
import { describeJobs, listRuns, parseInputs, resolveTarget, runUrl, runWorkflow, watchRun } from '../../app/Cli/runs'

let server: ReturnType<typeof Bun.serve>
let instance = ''
const seen: { method: string, path: string, query: Record<string, string>, body: any, auth: string | null }[] = []
let showStates: string[] = []

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = request.method === 'POST' ? await request.json() : null
      seen.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, auth: request.headers.get('authorization') })

      if (url.pathname === '/api/repos/workflows/dispatch') {
        if (body.workflow === 'push-only.yml')
          return Response.json({ error: 'This workflow does not accept workflow_dispatch' }, { status: 409 })
        return Response.json({ workflow_run: { number: 42, state: 'queued', event: 'workflow_dispatch', inputs: body.inputs ?? {} } }, { status: 201 })
      }

      if (url.pathname === '/api/repos/workflow-runs/show') {
        const state = showStates.shift() ?? 'succeeded'
        return Response.json({ workflow_run: { number: Number(url.searchParams.get('number')), state, jobs: [{ job_id: 'publish', state: state === 'queued' ? 'queued' : state, waiting: state === 'queued' ? { kind: 'busy', summary: 'every matching runner is busy' } : null }] } })
      }

      if (url.pathname === '/api/repos/workflow-runs')
        return Response.json({ workflow_runs: [{ number: 7, state: 'running', event: 'push', ref: 'refs/heads/main', head_sha: '806d0644460901ca', reason: null }], next: null })

      return new Response('not found', { status: 404 })
    },
  })
  instance = `http://127.0.0.1:${server.port}`
  process.env.REVIEWOS_TOKEN = 'test-token'
})

afterAll(() => {
  server.stop(true)
  delete process.env.REVIEWOS_TOKEN
})

const target = () => ({ repo: 'stacks/hq.training', instance })

describe('naming the repository', () => {
  it('takes --repo over the checkout, for a mirror whose remote is its upstream', async () => {
    expect(await resolveTarget({ repo: 'stacks/hq.training', instance: 'https://reviewos.org' }, {})).toEqual({ instance: 'https://reviewos.org', owner: 'stacks', repository: 'hq.training' })
  })

  it('reads REVIEWOS_REPOSITORY and REVIEWOS_URL the same way', async () => {
    expect(await resolveTarget({}, { REVIEWOS_REPOSITORY: 'stacks/hq.training', REVIEWOS_URL: 'https://reviewos.org/' })).toEqual({ instance: 'https://reviewos.org', owner: 'stacks', repository: 'hq.training' })
  })

  it('refuses a repository that is not owner/name', async () => {
    expect(await resolveTarget({ repo: 'hq.training', instance: 'https://reviewos.org' }, {})).toEqual({ error: '--repo takes owner/name, not "hq.training"' })
  })

  it('links a run where the interface shows it', () => {
    expect(runUrl({ instance: 'https://reviewos.org', owner: 'stacks', repository: 'hq.training' }, 3631)).toBe('https://reviewos.org/stacks/hq.training/run/3631')
  })
})

describe('inputs', () => {
  it('turns key=value pairs into the dispatch object, keeping = in values', () => {
    expect(parseInputs(['ref=origin/main', 'note=a=b'])).toEqual({ ref: 'origin/main', note: 'a=b' })
  })

  it('refuses a pair with no key', () => {
    expect(parseInputs(['=x'])).toEqual({ error: '--input takes key=value, not "=x"' })
  })
})

describe('running a workflow', () => {
  it('dispatches with the owner, repository, ref and inputs, using the token', async () => {
    seen.length = 0
    expect(await runWorkflow('platform-kit.yml', { ...target(), ref: 'main', inputs: ['ref=806d06444'] })).toBe(0)
    expect(seen[0]).toMatchObject({ method: 'POST', path: '/api/repos/workflows/dispatch', auth: 'Bearer test-token', body: { owner: 'stacks', repo: 'hq.training', workflow: 'platform-kit.yml', ref: 'main', inputs: { ref: '806d06444' } } })
  })

  it('reports a workflow that does not accept dispatch, with a failing exit code', async () => {
    expect(await runWorkflow('push-only.yml', target())).toBe(1)
  })

  it('follows the run it started until it succeeds', async () => {
    showStates = ['queued', 'running', 'succeeded']
    seen.length = 0
    expect(await runWorkflow('platform-kit.yml', { ...target(), watch: true, intervalMs: 0, sleep: async () => {} })).toBe(0)
    expect(seen.filter(row => row.path === '/api/repos/workflow-runs/show').map(row => row.query.number)).toEqual(['42', '42', '42'])
  })
})

describe('watching a run', () => {
  it('exits 1 for a failed run, so a script can chain on it', async () => {
    showStates = ['running', 'failed']
    expect(await watchRun('9', { ...target(), intervalMs: 0, sleep: async () => {} })).toBe(1)
  })

  it('stops at the deadline and leaves the run alone', async () => {
    showStates = ['queued', 'queued', 'queued']
    expect(await watchRun('9', { ...target(), intervalMs: 0, timeoutMs: 0, sleep: async () => {} })).toBe(1)
  })

  it('says why a queued job is still queued', () => {
    expect(describeJobs([{ job_id: 'publish', state: 'queued', waiting: { kind: 'busy', summary: 'every matching runner is busy' } }, { job_id: 'lint', state: 'succeeded' }])).toEqual(['  publish: queued (every matching runner is busy)'])
  })
})

describe('listing runs', () => {
  it('asks for the repository\'s runs with the filters given', async () => {
    seen.length = 0
    expect(await listRuns({ ...target(), state: 'running', limit: 5 })).toBe(0)
    expect(seen[0]).toMatchObject({ method: 'GET', path: '/api/repos/workflow-runs', query: { owner: 'stacks', repo: 'hq.training', state: 'running', per_page: '5' } })
  })
})
