/**
 * Starting and following workflow runs from the CLI.
 *
 * Against a fake instance on a loopback port, so the requests are the real
 * HTTP the commands send and the answers are the shapes the API documents.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import process from 'node:process'
import { describeJobs, describeRun, jobsToRead, lastLines, listRuns, parseInputs, resolveTarget, runLogs, runUrl, runWorkflow, watchRun } from '../../app/Cli/runs'

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

      // A red run with two jobs, and the failed one's output in three pages.
      if (url.pathname === '/api/repos/workflow-runs/show' && url.searchParams.get('number') === '4242') {
        return Response.json({ workflow_run: { number: 4242, state: 'failed', jobs: [
          { id: 11, name: 'lint', job_id: 'lint', state: 'succeeded' },
          { id: 12, name: 'Unit', job_id: 'unit', state: 'failed', error: 'Run the unit suites exited 1' },
        ] } })
      }

      if (url.pathname === '/api/repos/workflow-runs/log') {
        const after = Number(url.searchParams.get('after') ?? 0)
        if (url.searchParams.get('job') === '99')
          return Response.json({ error: 'No such job' }, { status: 404 })
        const pages: Record<string, Array<{ sequence: number, content: string }>> = {
          11: [{ sequence: 1, content: 'Linted\n' }],
          12: [{ sequence: 1, content: 'bun test\n' }, { sequence: 2, content: '(fail) answers a check-in\n' }, { sequence: 3, content: ' 1 fail\n' }],
        }
        // Two chunks a page, so the command has to follow the cursor.
        const chunks = (pages[String(url.searchParams.get('job'))] ?? []).filter(chunk => chunk.sequence > after).slice(0, 2)
        return Response.json({ chunks, cursor: chunks.at(-1)?.sequence ?? after, state: 'failed', attempt: Number(url.searchParams.get('attempt') ?? 1) })
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

  it('names the jobs a finished run failed on and what each stopped on', () => {
    const jobs = [
      { name: 'unit', state: 'failed', error: 'Run database and unit regression suites exited 1' },
      { name: 'api-e2e', state: 'cancelled', error: 'Stopped because the run had already failed' },
      { name: 'lint', state: 'succeeded' },
      { name: 'deploy', state: 'skipped' },
    ]
    expect(describeRun('3815', { state: 'failed', jobs })).toEqual([
      '#3815 failed',
      '  unit: failed (Run database and unit regression suites exited 1)',
      '  api-e2e: cancelled (Stopped because the run had already failed)',
    ])
    // A run cancelled as a whole says why, and a run that succeeded lists nothing.
    expect(describeRun('3820', { state: 'cancelled', reason: 'Skipped: a newer commit arrived before this run started.', jobs: [] })).toEqual(['#3820 cancelled: Skipped: a newer commit arrived before this run started.'])
    expect(describeRun('7', { state: 'succeeded', jobs })).toEqual(['#7 succeeded'])
    expect(describeRun('8', { state: 'running', jobs: [{ job_id: 'publish', state: 'queued', waiting: { summary: 'every matching runner is busy' } }] })).toEqual(['#8 running', '  publish: queued (every matching runner is busy)'])
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

describe('reading a run\'s output', () => {
  const said = async (work: () => Promise<number>): Promise<{ code: number, out: string[], err: string[] }> => {
    const out: string[] = []
    const err: string[] = []
    const log = console.log
    const error = console.error
    console.log = (...parts: unknown[]) => { out.push(parts.join(' ')) }
    console.error = (...parts: unknown[]) => { err.push(parts.join(' ')) }
    try { return { code: await work(), out, err } }
    finally { console.log = log; console.error = error }
  }

  it('prints what the failed job printed, following the cursor to the end', async () => {
    seen.length = 0
    const result = await said(() => runLogs('4242', target()))
    expect(result.code).toBe(0)
    expect(result.out).toEqual([
      '━━━ Unit: failed (Run the unit suites exited 1) ━━━',
      'bun test\n(fail) answers a check-in\n 1 fail',
      `${instance}/stacks/hq.training/run/4242`,
    ])
    // Only the failed job was read, a page at a time until nothing came back.
    const reads = seen.filter(row => row.path === '/api/repos/workflow-runs/log')
    expect(reads.map(row => [row.query.job, row.query.after])).toEqual([['12', '0'], ['12', '2'], ['12', '3']])
    expect(reads.every(row => row.auth === 'Bearer test-token' && row.query.owner === 'stacks' && row.query.repo === 'hq.training')).toBe(true)
  })

  it('reads the job that is named, every job when asked, and only the end when asked', async () => {
    expect((await said(() => runLogs('4242', { ...target(), job: 'LINT' }))).out.slice(0, 2)).toEqual(['━━━ lint: succeeded ━━━', 'Linted'])
    const all = await said(() => runLogs('4242', { ...target(), all: true, tail: 1 }))
    expect(all.out).toEqual(['━━━ lint: succeeded ━━━', 'Linted', '━━━ Unit: failed (Run the unit suites exited 1) ━━━', ' 1 fail', `${instance}/stacks/hq.training/run/4242`])
    seen.length = 0
    await said(() => runLogs('4242', { ...target(), attempt: 2 }))
    expect(seen.filter(row => row.path === '/api/repos/workflow-runs/log')[0]!.query.attempt).toBe('2')
  })

  it('says which jobs there are when the one named is not among them', async () => {
    const result = await said(() => runLogs('4242', { ...target(), job: 'deploy' }))
    expect(result.code).toBe(1)
    expect(result.err).toEqual(['No job "deploy" in this run. It has: lint, Unit'])
    expect(result.out).toEqual([])
  })

  it('chooses the failed jobs, or all of them when none failed', () => {
    const jobs = [{ id: 1, name: 'lint', state: 'succeeded' }, { id: 2, name: 'unit', state: 'failed' }, { id: 3, job_id: 'e2e', state: 'failed' }]
    expect(jobsToRead(jobs)).toEqual([jobs[1], jobs[2]])
    expect(jobsToRead(jobs, { all: true })).toEqual(jobs)
    expect(jobsToRead([jobs[0]!, { id: 4, name: 'deploy', state: 'running' }])).toHaveLength(2)
    expect(jobsToRead(jobs, { job: 'e2e' })).toEqual([jobs[2]])
    expect(jobsToRead([], {})).toEqual([])
    expect(jobsToRead([], { job: 'unit' })).toEqual({ error: 'No job "unit" in this run. It has: none' })
  })

  it('keeps the last lines of an output', () => {
    expect(lastLines('a\nb\nc\n', 2)).toBe('b\nc')
    expect(lastLines('a\nb\nc\n')).toBe('a\nb\nc')
    expect(lastLines('a\nb', 5)).toBe('a\nb')
    expect(lastLines('', 3)).toBe('')
  })
})
