/**
 * The runner, as a program you can copy to a machine.
 *
 * This is the entry point that `buddy build:runner` compiles into a single
 * binary. It is the *same* executor the local runner uses - not a second
 * implementation that drifts - and the whole reason it can be compiled is that
 * nothing under `Runner/` touches the framework or the database. A runner that
 * needed a database connection would be a runner you could only run next to the
 * control plane, which is the opposite of a fleet.
 *
 * Two differences from `./buddy runner:local`, both because this runs on a
 * machine that is not the instance's:
 *
 * - **It clones over HTTP** rather than from a bare repository on disk. There
 *   is no `storage/repos` here.
 * - **It has no database to register itself in.** The credential is made on the
 *   instance and carried over, which is what a registration token is for.
 *
 * Everything else - the lease, the job token, the file protocol, masking,
 * `if:`, job outputs, timeouts - is the code the tests already cover, because
 * it is the same code.
 */

import process from 'node:process'
import { runLoop, runOnce } from './localExecutor'

interface Options {
  url: string
  token: string
  /** A pool's registration credential, exchanged for this machine's own. */
  registrationToken: string
  once: boolean
  jobs: number
  labels: string
  /** `key=value` facts about this machine, for a job's `agents:` query. */
  tags: string
  name: string
  idleTimeout: number
}

function parse(argv: readonly string[]): Options {
  const options: Options = {
    url: process.env.REVIEWOS_URL ?? '',
    token: process.env.REVIEWOS_RUNNER_TOKEN ?? '',
    registrationToken: process.env.REVIEWOS_REGISTRATION_TOKEN ?? '',
    once: false,
    jobs: 0,
    labels: 'ubuntu-latest,self-hosted',
    tags: '',
    name: '',
    idleTimeout: 0,
  }

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]

    if (argument === '--url')
      options.url = String(argv[++index] ?? '')
    else if (argument === '--token')
      options.token = String(argv[++index] ?? '')
    else if (argument === '--once')
      options.once = true
    else if (argument === '--jobs')
      options.jobs = Number(argv[++index] ?? 0) || 0
    else if (argument === '--labels')
      options.labels = String(argv[++index] ?? '')
    else if (argument === '--idle-timeout')
      options.idleTimeout = Number(argv[++index] ?? 0) || 0
    else if (argument === '--registration-token')
      options.registrationToken = String(argv[++index] ?? '')
    else if (argument === '--tags')
      options.tags = String(argv[++index] ?? '')
    else if (argument === '--name')
      options.name = String(argv[++index] ?? '')
  }

  return options
}

const USAGE = `reviewos-runner - run a ReviewOS instance's jobs on this machine

  reviewos-runner --url https://reviewos.example --token <credential>

  --url     Where the instance is. REVIEWOS_URL also works.
  --token   The runner credential, made on the instance with
            \`buddy runner:local --register\`. REVIEWOS_RUNNER_TOKEN also works.
  --registration-token <token>
            A pool's registration credential, used once to add this machine to
            the fleet and then exchanged for its own. This is what an
            autoscaler's userdata should carry: it can add a machine to one
            pool and nothing else, where an administrator's token can read every
            repository on the instance. REVIEWOS_REGISTRATION_TOKEN also works.
  --labels  What this machine answers to (default ubuntu-latest,self-hosted).
  --tags    \`key=value\` facts about this machine, for a job's \`agents:\` query -
            \`--tags gpu=a100,region=ash\`. Set them from whatever knows.
  --name    What to call this machine in the fleet.
  --once    Claim and run at most one job, then stop.
  --jobs N  Stop after N jobs. Useful for an ephemeral runner in an
            autoscaling group: one job, then exit, then a fresh machine.
  --idle-timeout S
            Stop after S seconds with nothing to do. The other half of an
            ephemeral runner: a machine that shuts itself down when the queue
            is empty costs nothing between builds, and it knows whether it is
            mid-job where a scaler outside it has to guess.

This is not a security boundary. A step runs as the user who started this, on
this machine, with this user's files and network. A fork's pull request is
refused outright.
`

const options = parse(process.argv.slice(2))

if (!options.url || (!options.token && !options.registrationToken)) {
  console.error(USAGE)
  process.exit(options.url || options.token || options.registrationToken ? 1 : 0)
}

const url = options.url.replace(/\/$/, '')

/*
 * Register first, when that is how this machine was started.
 *
 * The registration credential is used once and then dropped: everything after
 * this authenticates as *this machine*, which is what keeps the threat model's
 * promise that a registration credential never reaches a job environment.
 */
let token = options.token

if (!token && options.registrationToken) {
  const answer = await fetch(`${url}/api/runner/register`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${options.registrationToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Runner-Protocol': '1',
    },
    body: JSON.stringify({
      name: options.name || `runner-${process.pid}`,
      labels: options.labels,
      tags: options.tags,
    }),
  })

  const body: any = await answer.json().catch(() => null)

  if (!answer.ok || !body?.runner?.token) {
    console.error(`Could not register with this instance: ${body?.error ?? answer.status}`)
    process.exit(1)
  }

  token = String(body.runner.token)

  console.log(`Registered as \`${String(body.runner.name)}\` (#${Number(body.runner.id)}).`)
}

console.log('ReviewOS runner')
console.log(`  instance:   ${url}`)
console.log(`  platform:   ${process.platform} ${process.arch}`)
console.log('  isolation:  none - steps run as this user, on this machine')
console.log('  forks:      refused; an untrusted run needs an isolated runner')
console.log('')

/*
 * A workspace under this process's own directory rather than a temporary one.
 *
 * On a fleet machine the temporary directory is often small or on a tmpfs, and
 * a checkout of a large repository is the first thing that fills it. Somewhere
 * predictable also means an operator can look at what a failed job left.
 */
const workspaceRoot = process.env.REVIEWOS_WORKSPACE ?? undefined

if (options.once) {
  const outcome = await runOnce({
    baseUrl: url,
    token,
    workspaceRoot,
    say: line => console.log(line),
  })

  console.log(outcome ? `${outcome.state}: ${outcome.reason}` : 'nothing to run')
  process.exit(0)
}

console.log('Waiting for work. Stop with ctrl-c.')

const outcomes = await runLoop({
  baseUrl: url,
  token,
  maxJobs: options.jobs,
  idleTimeoutMs: options.idleTimeout * 1000,
  workspaceRoot,
  say: line => console.log(line),
})

console.log(`Ran ${outcomes.length} ${outcomes.length === 1 ? 'job' : 'jobs'}.`)
