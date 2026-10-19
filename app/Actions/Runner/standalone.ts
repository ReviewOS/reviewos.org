/**
 * The runner, as a program you can copy to a machine.
 *
 * This is the entry point that `buddy build:runner` compiles into a single
 * binary. It is the *same* executor the local runner uses - not a second
 * implementation that drifts - and the whole reason it can be compiled is that
 * nothing in its executor imports the control plane or a database. Portable
 * Stacks storage and validation helpers supply its shared primitives. A runner that
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
import { defaultPolicy } from './actionRef'
import { containerRuntime } from './container'
import { maintainRunnerWorkspaces } from './workspaceMaintenance'
import { PROTOCOL_HEADER, RUNNER_PROTOCOL } from './protocol'

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
  cleanWorkspaces: boolean
  runnerId: number
  journalRoot: string
  ownerUid?: number
  temporaryRoot?: string
  apply: boolean
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
    cleanWorkspaces: false,
    runnerId: 0,
    journalRoot: '',
    apply: false,
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
    else if (argument === '--clean-workspaces')
      options.cleanWorkspaces = true
    else if (argument === '--runner-id')
      options.runnerId = Number(argv[++index])
    else if (argument === '--journal-root')
      options.journalRoot = String(argv[++index] ?? '')
    else if (argument === '--owner-uid')
      options.ownerUid = Number(argv[++index])
    else if (argument === '--temporary-root')
      options.temporaryRoot = String(argv[++index] ?? '')
    else if (argument === '--apply')
      options.apply = true
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
  --clean-workspaces
            Preview controller-confirmed terminal workspace retirement and exit.
            Uses REVIEWOS_RUNNER_TOKEN; never registers another runner.
  --runner-id ID --journal-root PATH
            The registered runner and its private workspace-journals directory.
  --owner-uid UID
            Existing journal owner; only root can maintain another user.
  --temporary-root PATH
            The runner's original temporary root if different from this user's.
  --apply   Retire verified workspaces; the default is a read-only preview.

Set REVIEWOS_RUNNER_MIN_FREE_DISK_MB on the runner to require free MiB on both
workspace and temp filesystems before claiming. Zero disables the floor; choose
a floor that includes checkout/build growth and host headroom. A held runner
still receives stop requests. Deploy a protocol 2 controller before this runner.

Set REVIEWOS_RUNNER_MAX_LOAD_PER_CPU to also hold admission above that one-minute
load per available logical CPU. Zero disables it. An explicit ceiling refuses
work if the host cannot report load; Windows does not provide this measurement.
Both admission settings belong to the operator, outside a job's environment.

Where actions may come from is set here, in the environment, and the default is
closed - local actions and nothing else:

  REVIEWOS_ACTION_HOSTS         Hosts whose actions may run, comma separated.
                                \`*\` allows any, which is what github.com's own
                                runners do and is a decision rather than a
                                default.
  REVIEWOS_ACTION_DEFAULT_HOST  Where an unqualified \`actions/checkout@v4\`
                                comes from. Unset, such a reference is refused
                                rather than guessed at github.com.
  REVIEWOS_ACTION_PINNED        Set to require a full commit sha, so a tag
                                cannot be repointed after a review read it.
  REVIEWOS_ALLOW_CONTAINERS     Set to run \`uses: docker://image\` steps.
  REVIEWOS_CONTAINER_RUNTIME    Which runtime to use. Otherwise docker, then
                                podman, whichever is on PATH.

This is not a security boundary. A step runs as the user who started this, on
this machine, with this user's files and network. A container step is isolated
by the runtime and nothing more: it mounts the workspace and can reach the
network. A fork's pull request is refused outright.
`

/** An environment flag: set to anything but `0`, `false` or empty. */
function truthy(value: string | undefined): boolean {
  const text = String(value ?? '').trim().toLowerCase()

  return text !== '' && text !== '0' && text !== 'false' && text !== 'no'
}

/*
 * Nothing below runs unless this file *is* the program.
 *
 * Without the guard, importing it executes it - and everything that walks
 * `app/Actions/` imports every file it finds. A CLI command that happened to
 * load this one printed the runner's usage and exited zero, so `buddy
 * docs:reference` silently did nothing and the pages it generates went stale
 * with no error to explain why.
 */
if (import.meta.main) {
  const options = parse(process.argv.slice(2))

  if (options.cleanWorkspaces) {
    const result = await maintainRunnerWorkspaces({ baseUrl: options.url, token: options.token, runnerId: options.runnerId, journalRoot: options.journalRoot, ownerUid: options.ownerUid, temporaryRoot: options.temporaryRoot, apply: options.apply })
    console.log(JSON.stringify({ mode: options.apply ? 'apply' : 'preview', ...result }))
    process.exit(0)
  }

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
        [PROTOCOL_HEADER]: String(RUNNER_PROTOCOL.current),
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

  /*
   * Where actions may come from, decided by the operator of *this machine*.
   *
   * The default is closed - local actions and nothing else - and stays that
   * way: an action is code from somewhere else that a repository's workflow
   * runs here, and turning that on is a decision somebody should have to make
   * rather than one a default makes for them. Read from the environment
   * because a runner in an autoscaling group is configured by userdata, and a
   * flag nobody can set from there is a flag that gets worked around.
   */
  const policy = {
    ...defaultPolicy(),
    allowedHosts: String(process.env.REVIEWOS_ACTION_HOSTS ?? '').split(',').map(one => one.trim()).filter(Boolean),
    defaultHost: String(process.env.REVIEWOS_ACTION_DEFAULT_HOST ?? '').trim() || null,
    requirePinnedSha: truthy(process.env.REVIEWOS_ACTION_PINNED),
    allowContainers: truthy(process.env.REVIEWOS_ALLOW_CONTAINERS),
  }

  if (policy.allowContainers)
    console.log(`  containers: ${(await containerRuntime()) ?? 'enabled, but no docker or podman on PATH'}`)

  if (options.once) {
    const outcome = await runOnce({
      baseUrl: url,
      token,
      workspaceRoot,
      policy,
      say: line => console.log(line),
    })

    console.log(outcome ? `${outcome.state}: ${outcome.reason}` : 'nothing to run')
    process.exit(0)
  }

  console.log('Waiting for work. Stop with ctrl-c.')

  const outcomes = await runLoop({
    baseUrl: url,
    token,
    policy,
    maxJobs: options.jobs,
    idleTimeoutMs: options.idleTimeout * 1000,
    workspaceRoot,
    say: line => console.log(line),
  })

  console.log(`Ran ${outcomes.length} ${outcomes.length === 1 ? 'job' : 'jobs'}.`)
}
