/**
 * Reading what a run's jobs printed, from the CLI.
 *
 * Against a fake instance on a loopback port, as cli-runs.test.ts is: the
 * requests are the real HTTP `reviewos logs` sends, and the answers are the
 * shapes the run and log endpoints document.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import process from 'node:process'
import { jobsToRead, runLogs } from '../../app/Cli/runs'

let server: ReturnType<typeof Bun.serve>
let instance = ''
let jobs: any[] = []
const asked: { job: string, after: string }[] = []
/** Each job's output as the instance holds it: numbered chunks, served two to a page. */
const output: Record<string, string[]> = {
  11: ['lint ok\n'],
  12: ['running 3 tests\n', '(fail) reserved usernames\n', ' 2 pass\n 1 fail\n'],
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url)

      if (url.pathname === '/api/repos/workflow-runs/show')
        return Response.json({ workflow_run: { number: Number(url.searchParams.get('number')), state: 'failed', jobs } })

      if (url.pathname === '/api/repos/workflow-runs/log') {
        const job = String(url.searchParams.get('job'))
        const after = Number(url.searchParams.get('after') ?? 0)
        asked.push({ job, after: String(after) })

        if (!output[job])
          return Response.json({ error: 'Not found' }, { status: 404 })

        const chunks = output[job]!.map((content, index) => ({ sequence: index + 1, content })).filter(chunk => chunk.sequence > after).slice(0, 2)

        return Response.json({ chunks, cursor: chunks.at(-1)?.sequence ?? after, state: 'failed', attempt: 1 })
      }

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

beforeEach(() => {
  asked.length = 0
  jobs = [
    { id: 11, job_id: 'lint', name: 'Lint', state: 'succeeded' },
    { id: 12, job_id: 'unit', name: 'Unit suites', state: 'failed', error: 'Run the unit suites exited 1' },
    { id: 13, job_id: 'deploy', name: 'Deploy', state: 'blocked' },
  ]
})

async function read(options: { job?: string } = {}): Promise<{ status: number, text: string }> {
  let text = ''
  const status = await runLogs('4121', { repo: 'stacks/hq.training', instance, ...options, write: (chunk) => { text += chunk } })

  return { status, text }
}

describe('choosing the jobs to read', () => {
  it('reads the job that is named, by its id in the workflow or by its name', () => {
    expect(jobsToRead(jobs, 'lint').map(job => job.id)).toEqual([11])
    expect(jobsToRead(jobs, 'Unit suites').map(job => job.id)).toEqual([12])
    expect(jobsToRead(jobs, 'publish')).toEqual([])
  })

  it('reads the jobs that did not succeed when none is named, and all of them when every one did', () => {
    expect(jobsToRead(jobs).map(job => job.id)).toEqual([12])
    expect(jobsToRead(jobs.map(job => ({ ...job, state: 'succeeded' }))).map(job => job.id)).toEqual([11, 12, 13])
    expect(jobsToRead([])).toEqual([])
  })
})

describe('reading a run\'s output', () => {
  it('prints a failed run\'s failed job from the first chunk to the last, a page at a time', async () => {
    const { status, text } = await read()

    expect(status).toBe(0)
    expect(text).toBe('running 3 tests\n(fail) reserved usernames\n 2 pass\n 1 fail\n')
    // Each page starts after the last chunk the one before it gave, and an empty page ends it.
    expect(asked).toEqual([{ job: '12', after: '0' }, { job: '12', after: '2' }, { job: '12', after: '3' }])
  })

  it('prints the job that is named, with nothing added to its output', async () => {
    const { status, text } = await read({ job: 'lint' })

    expect(status).toBe(0)
    expect(text).toBe('lint ok\n')
    expect(asked.map(page => page.job)).toEqual(['11', '11'])
  })

  it('says which jobs a run has when the one named is not among them', async () => {
    const { status, text } = await read({ job: 'publish' })

    expect(status).toBe(1)
    expect(text).toBe('')
    expect(asked).toEqual([])
  })

  it('stops on an answer the instance refuses rather than printing half a log as a whole one', async () => {
    jobs = [{ id: 99, job_id: 'unit', state: 'failed' }]

    expect((await read()).status).toBe(1)
  })
})
