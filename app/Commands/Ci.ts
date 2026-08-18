import type { CLI } from '@stacksjs/types'
import { readFileSync } from 'node:fs'
import process from 'node:process'

/**
 * The pipeline surface from a terminal.
 *
 * **A client of the public API and nothing else.** Not one line here reaches
 * the database, and that is the constraint that makes it worth having: a
 * command that took a shortcut would be a command that works on the instance's
 * own machine and nowhere else, and it would stop being a test of whether the
 * API is actually usable. Every subcommand below is something an operator would
 * otherwise write curl for.
 *
 * The token comes from `--token` or `REVIEWOS_TOKEN`, and the instance from
 * `--url` or `REVIEWOS_URL`. Both default the way somebody running this on the
 * instance's own box would want.
 */

interface CiOptions {
  url?: string
  token?: string
  repository?: string
  number?: string
  job?: string
  scope?: string
  file?: string
  ref?: string
  input?: string[]
  json?: boolean
}

/** Where to talk to, and with what. */
function connection(options: CiOptions): { url: string, token: string } {
  return {
    url: String(options.url ?? process.env.REVIEWOS_URL ?? 'http://localhost:3000').replace(/\/$/, ''),
    token: String(options.token ?? process.env.REVIEWOS_TOKEN ?? ''),
  }
}

/** `owner/repository`, from the flag or from the git remote. */
function repository(options: CiOptions): { owner: string, repo: string } | null {
  const named = String(options.repository ?? process.env.REVIEWOS_REPOSITORY ?? '')
  const [owner, repo] = named.split('/')

  return owner && repo ? { owner, repo } : null
}

/**
 * One call, with the error reporting a person needs.
 *
 * A CLI that prints `{"error":"Not found"}` and exits 1 has told somebody
 * nothing: they cannot tell a wrong repository from a missing token from an
 * instance that is not running. So the failure says which, and the exit status
 * is non-zero either way.
 */
async function call(input: {
  url: string
  token: string
  path: string
  method?: 'GET' | 'POST'
  body?: Record<string, unknown>
}): Promise<any> {
  const headers: Record<string, string> = { 'Accept': 'application/json' }

  if (input.token)
    headers.Authorization = `Bearer ${input.token}`

  if (input.body)
    headers['Content-Type'] = 'application/json'

  let answer: Response

  try {
    answer = await fetch(`${input.url}${input.path}`, {
      method: input.method ?? 'GET',
      headers,
      body: input.body ? JSON.stringify(input.body) : undefined,
    })
  }
  catch (error) {
    // The instance is not answering at all, which is a different problem from
    // anything it could have said.
    console.error(`Could not reach ${input.url}: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }

  const text = await answer.text()
  const body = text ? JSON.parse(text) : null

  if (!answer.ok) {
    if (answer.status === 401)
      console.error('That credential was refused. Set REVIEWOS_TOKEN, or pass --token.')
    else if (answer.status === 404)
      console.error(`Not found: ${body?.error ?? input.path}. A repository you cannot read answers the same way as one that does not exist.`)
    else
      console.error(`${answer.status}: ${body?.error ?? text}`)

    process.exit(1)
  }

  return body
}

export default function (cli: CLI) {
  cli
    .command('ci:validate <file>', 'Check a workflow file without pushing it')
    .action(async (file: string) => {
      /*
       * The one subcommand that needs no instance and no credential: parsing is
       * this repository's own code, and asking somebody to push a broken file
       * to find out it is broken is the loop this removes.
       */
      const { parseWorkflow } = await import('../Actions/Workflow/parse')

      const result = parseWorkflow(readFileSync(file, 'utf8'), file)

      for (const error of result.errors)
        console.error(`${file}:${error.line}  ${error.message}\n    ${error.fix}`)

      /*
       * A warning here is a key this instance reads differently from Actions,
       * or one it does not implement - the conformance table's own words. It
       * names the key rather than a line, because the divergence is about the
       * key rather than about where it was written.
       */
      for (const warning of result.warnings ?? [])
        console.warn(`${file}  ${warning.key}: ${warning.message}`)

      if (result.errors.length > 0)
        process.exit(1)

      const jobs = result.workflow?.jobs ?? []

      console.log(`${file}: ${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'}, no problems.`)
    })

  cli
    .command('ci:runs', 'List a repository\'s recent workflow runs')
    .option('--url <url>', 'Where the instance is')
    .option('--token <token>', 'A credential that may read the repository')
    .option('--repository <owner/repo>', 'Which repository')
    .option('--json', 'Print the answer as it came, for a script', { default: false })
    .action(async (options: CiOptions) => {
      const where = repository(options)

      if (!where)
        return fail('Say which repository: --repository owner/name')

      const { url, token } = connection(options)
      const body = await call({ url, token, path: `/api/repos/workflow-runs?owner=${where.owner}&repo=${where.repo}` })

      if (options.json)
        return console.log(JSON.stringify(body, null, 2))

      for (const run of body.workflow_runs ?? []) {
        console.log(`#${run.number}  ${String(run.state).padEnd(10)}  ${run.event ?? ''}  ${String(run.head_sha ?? '').slice(0, 8)}`)
      }
    })

  cli
    .command('ci:run <number>', 'Show one run, its jobs and their states')
    .option('--url <url>', 'Where the instance is')
    .option('--token <token>', 'A credential that may read the repository')
    .option('--repository <owner/repo>', 'Which repository')
    .option('--json', 'Print the answer as it came, for a script', { default: false })
    .action(async (number: string, options: CiOptions) => {
      const where = repository(options)

      if (!where)
        return fail('Say which repository: --repository owner/name')

      const { url, token } = connection(options)

      const body = await call({
        url,
        token,
        path: `/api/repos/workflow-runs/show?owner=${where.owner}&repo=${where.repo}&number=${Number(number)}`,
      })

      if (options.json)
        return console.log(JSON.stringify(body, null, 2))

      const run = body.workflow_run

      console.log(`#${run.number}  ${run.state}  ${run.workflow?.name ?? ''}`)

      for (const job of run.jobs ?? []) {
        const waited = job.queued_at && job.started_at
          ? ` (waited ${Math.round((Date.parse(job.started_at) - Date.parse(job.queued_at)) / 1000)}s)`
          : ''

        console.log(`  ${String(job.state).padEnd(10)} ${job.name ?? job.job_id}${waited}`)
      }
    })

  cli
    .command('ci:logs <number> <job>', 'Print one job\'s output, following it while it runs')
    .option('--url <url>', 'Where the instance is')
    .option('--token <token>', 'A credential that may read the repository')
    .option('--repository <owner/repo>', 'Which repository')
    .option('--follow', 'Keep printing until the job finishes', { default: false })
    .action(async (number: string, job: string, options: CiOptions & { follow?: boolean }) => {
      const where = repository(options)

      if (!where)
        return fail('Say which repository: --repository owner/name')

      const { url, token } = connection(options)

      /*
       * The log endpoint takes a job id, and a person has a job name. Resolving
       * it here is the whole difference between a command somebody can use and
       * one that needs them to look a number up first.
       */
      const run = await call({
        url,
        token,
        path: `/api/repos/workflow-runs/show?owner=${where.owner}&repo=${where.repo}&number=${Number(number)}`,
      })

      const found = (run.workflow_run?.jobs ?? []).find((one: { job_id?: unknown, name?: unknown }) =>
        String(one.job_id) === job || String(one.name ?? '') === job)

      if (!found) {
        const names = (run.workflow_run?.jobs ?? []).map((one: { job_id?: unknown }) => String(one.job_id)).join(', ')

        // Naming what is there, because the usual cause is a job id that reads
        // differently from the name on the screen.
        return fail(`Run #${number} has no job called ${job}. It has: ${names}`)
      }

      let after = 0

      for (;;) {
        const page = await call({
          url,
          token,
          path: `/api/repos/workflow-runs/log?owner=${where.owner}&repo=${where.repo}&job=${Number(found.id)}&after=${after}`,
        })

        for (const chunk of page.chunks ?? []) {
          // Straight to stdout with nothing added, so `| grep` behaves and a
          // redirect is the log rather than a transcript of this program.
          process.stdout.write(String(chunk.content ?? ''))
          after = Math.max(after, Number(chunk.sequence ?? 0))
        }

        const finished = ['succeeded', 'failed', 'cancelled', 'skipped'].includes(String(page.state ?? ''))

        if (!options.follow || finished)
          break

        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    })

  cli
    .command('ci:dispatch <workflow>', 'Start a run of a workflow')
    .option('--url <url>', 'Where the instance is')
    .option('--token <token>', 'A credential that may dispatch')
    .option('--repository <owner/repo>', 'Which repository')
    .option('--ref <ref>', 'Which branch or tag')
    .option('--input <key=value>', 'A dispatch input. Repeatable.')
    .action(async (workflow: string, options: CiOptions) => {
      const where = repository(options)

      if (!where)
        return fail('Say which repository: --repository owner/name')

      const { url, token } = connection(options)

      // `--input a=1 --input b=2`, which is what every CLI that takes inputs
      // does, rather than a JSON string somebody has to quote for a shell.
      const inputs: Record<string, string> = {}

      for (const one of [options.input ?? []].flat()) {
        const at = String(one).indexOf('=')

        if (at > 0)
          inputs[String(one).slice(0, at)] = String(one).slice(at + 1)
      }

      const body = await call({
        url,
        token,
        method: 'POST',
        path: '/api/repos/workflow-dispatch',
        body: {
          owner: where.owner,
          repo: where.repo,
          workflow,
          ref: options.ref ?? undefined,
          inputs,
        },
      })

      console.log(`started run #${body.workflow_run?.number ?? '?'}`)
    })

  cli
    .command('ci:unblock <number> <job>', 'Open a gate somebody is waiting on')
    .option('--url <url>', 'Where the instance is')
    .option('--token <token>', 'A credential that may approve')
    .option('--repository <owner/repo>', 'Which repository')
    .option('--input <key=value>', 'An answer to one of the gate\'s fields. Repeatable.')
    .action(async (number: string, job: string, options: CiOptions) => {
      const where = repository(options)

      if (!where)
        return fail('Say which repository: --repository owner/name')

      const { url, token } = connection(options)
      const answers: Record<string, string> = {}

      for (const one of [options.input ?? []].flat()) {
        const at = String(one).indexOf('=')

        if (at > 0)
          answers[String(one).slice(0, at)] = String(one).slice(at + 1)
      }

      await call({
        url,
        token,
        method: 'POST',
        path: '/api/repos/workflow-runs/approve',
        body: { owner: where.owner, repo: where.repo, number: Number(number), job, fields: answers },
      })

      // Who opened it is recorded by the endpoint, from the credential. A CLI
      // that sent a name would be a CLI that could send somebody else's.
      console.log(`opened ${job} on run #${number}`)
    })

  cli
    .command('ci:cancel <number>', 'Stop a run, or one job of it')
    .option('--url <url>', 'Where the instance is')
    .option('--token <token>', 'A credential that may cancel')
    .option('--repository <owner/repo>', 'Which repository')
    .option('--job <job>', 'Stop only this job')
    .action(async (number: string, options: CiOptions) => {
      const where = repository(options)

      if (!where)
        return fail('Say which repository: --repository owner/name')

      const { url, token } = connection(options)

      const body = await call({
        url,
        token,
        method: 'POST',
        path: options.job ? '/api/repos/workflow-runs/cancel-job' : '/api/repos/workflow-runs/cancel',
        body: {
          owner: where.owner,
          repo: where.repo,
          number: Number(number),
          job: options.job,
          reason: 'Cancelled from the command line',
        },
      })

      console.log(options.job
        ? `${body.cancelled ? 'stopping' : 'already finished'}: ${options.job}`
        : `${body.cancelled ? 'stopping' : 'already finished'}: run #${number}`)
    })

  cli
    .command('ci:rerun <number>', 'Run a finished run again')
    .option('--url <url>', 'Where the instance is')
    .option('--token <token>', 'A credential that may cancel')
    .option('--repository <owner/repo>', 'Which repository')
    .option('--scope <scope>', 'all, failed (the default), or job', { default: 'failed' })
    .option('--job <job>', 'Which job, with --scope job')
    .action(async (number: string, options: CiOptions) => {
      const where = repository(options)

      if (!where)
        return fail('Say which repository: --repository owner/name')

      const { url, token } = connection(options)

      const body = await call({
        url,
        token,
        method: 'POST',
        path: '/api/repos/workflow-runs/rerun',
        body: {
          owner: where.owner,
          repo: where.repo,
          number: Number(number),
          scope: options.scope ?? 'failed',
          job: options.job,
        },
      })

      console.log(`run #${number} is on attempt ${body.workflow_run?.attempt ?? '?'}, ${body.jobs} ${body.jobs === 1 ? 'job' : 'jobs'} running again`)
    })
}

/** Say what is missing and stop. A usage error is not a stack trace. */
function fail(message: string): void {
  console.error(message)
  process.exit(1)
}
