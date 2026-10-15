import type { CLI } from '@stacksjs/types'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import process from 'node:process'

// Imported rather than relied on as a global: `db` is a server auto-import, and
// a buddy command does not run through the preloader that injects those.
import { db } from '@stacksjs/database'
import { runLoop, runOnce } from '../Actions/Runner/localExecutor'
import { generateToken } from '../Actions/Tokens/secret'

/**
 * Run this instance's jobs on this host.
 *
 * The single-tenant answer to "nothing executes my workflows". One team, one
 * box, code they wrote: for that shape, a runner on the same host is the honest
 * default, and standing up a fleet to run three test suites a day is not.
 *
 * **Off unless somebody runs this.** That is the safety argument, and it is a
 * command rather than a setting on purpose - by [the threat
 * model](../../docs/ci-threat-model.md) this instance does not execute
 * repository code unless an operator has provided somewhere for it to happen,
 * and typing this is an operator saying "here, on this machine".
 *
 * It is not a security boundary and the command says so on every start. A step
 * runs as the user who started it, with that user's files and network. Fork
 * pull requests are refused outright: untrusted code on the control plane's own
 * host is the one combination that turns CI into somebody else's shell.
 */

/**
 * Where this host keeps the credential it registered for itself.
 *
 * Under `storage/framework/runtime/`, which is machine-local and gitignored
 * along with everything else there. Written `0600`: it is a credential that can
 * claim any job on the instance, and a file anybody on the box can read is a
 * runner anybody on the box can impersonate.
 */
const CREDENTIAL_FILE = 'storage/framework/runtime/runner-local.token'

interface RunnerOptions {
  idleTimeout?: string
  url?: string
  token?: string
  name?: string
  labels?: string
  once?: boolean
  jobs?: string
  register?: boolean
  /** Where this machine's own hooks live. See `docs/runner-hooks.md`. */
  hooks?: string
  /** With `--register`: a runner for this one repository rather than the instance. */
  repository?: string
}

export default function (cli: CLI) {
  cli
    .command('runner:local', 'Run this instance\'s queued jobs on this host (single-tenant installs)')
    .option('--url <url>', 'Where this instance is', { default: 'http://localhost:3000' })
    .option('--token <token>', 'A runner credential. Omit with --register to make one')
    .option('--register', 'Register a runner for this host and print its credential', { default: false })
    .option('--name <name>', 'What to call this runner', { default: 'local' })
    .option('--labels <labels>', 'Comma-separated labels it answers to', { default: 'ubuntu-latest,self-hosted,local' })
    .option('--once', 'Claim and run at most one job, then stop', { default: false })
    .option('--jobs <count>', 'Stop after this many jobs', { default: '0' })
    .option('--idle-timeout <seconds>', 'Stop after this long with nothing to do', { default: '0' })
    .option('--hooks <directory>', 'Where this machine\'s hooks live, outside repository control')
    .option('--repository <owner/name>', 'With --register: a runner for this repository alone, not the whole instance')
    .action(async (options: RunnerOptions) => {
      if (options.register) {
        try {
          await registerRunner(options, { print: true })
        }
        catch (error) {
          // A repository that is not here, or an owner/name that is not one:
          // said in a line, not as an uncaught exception's stack.
          console.error(`Could not register the runner: ${error instanceof Error ? error.message : String(error)}`)
          process.exit(1)
        }
        return
      }

      /*
       * The credential, found or made.
       *
       * This used to be two commands - register, copy the token out of the
       * output, start with it - and the second step was friction with no
       * safety behind it: the same operator, at the same shell, on the
       * instance's own machine. The argument that matters is that **this
       * instance runs nothing until somebody types this**, and typing it is
       * that. So `./buddy runner:local` is the whole of the first run now.
       *
       * An explicit `--token` still wins, which is how a runner on a *second*
       * machine works: register there, carry the credential over, pass it in.
       */
      let token = String(options.token ?? process.env.REVIEWOS_RUNNER_TOKEN ?? '').trim()
      let registered = false

      if (!token)
        token = readCredential()

      if (!token) {
        token = await registerRunner(options, { print: false })
        writeCredential(token)
        registered = true
      }

      const url = String(options.url ?? 'http://localhost:3000').replace(/\/$/, '')

      /*
       * Said every time, not once in the documentation.
       *
       * Somebody starting this in a terminal is the only person who will ever
       * see it, and "I did not realise it ran on the host" is the sentence this
       * paragraph exists to prevent.
       */
      console.log('ReviewOS local runner')

      if (registered)
        console.log(`  registered: \`${String(options.name ?? 'local')}\`, credential kept in ${CREDENTIAL_FILE}`)

      console.log(`  instance:   ${url}`)
      console.log(`  labels:     ${labelsOf(options).join(', ')}`)
      console.log('  isolation:  none - steps run as this user, on this machine')
      console.log('  forks:      refused; an untrusted run needs an isolated runner')
      console.log('')

      const maxJobs = options.once ? 1 : Number(options.jobs ?? 0) || 0

      if (options.once) {
        const outcome = await runOnce({
          baseUrl: url,
          token,
          hooksDirectory: options.hooks,
          say: line => console.log(line),
        })

        console.log(outcome ? `${outcome.state}: ${outcome.reason}` : 'nothing to run')
        return
      }

      console.log('Waiting for work. Stop with ctrl-c.')

      const outcomes = await runLoop({
        baseUrl: url,
        token,
        maxJobs,
        // An ephemeral runner: stops itself when the queue has been empty for
        // a while, which is what makes an autoscaling group safe to write.
        idleTimeoutMs: (Number(options.idleTimeout ?? 0) || 0) * 1000,
        // The machine's own scripts, which a repository cannot reach. See
        // `docs/runner-hooks.md`.
        hooksDirectory: options.hooks,
        say: line => console.log(line),
      })

      console.log(`Ran ${outcomes.length} ${outcomes.length === 1 ? 'job' : 'jobs'}.`)
    })
}

/**
 * Register a runner for this host and print its credential once.
 *
 * Written straight to the database rather than through an API, because this is
 * an operator at a shell on the instance's own machine - the one caller for
 * whom "authenticate first" means "you already have the database". Anybody
 * else registering a runner does it through the admin interface.
 */
async function registerRunner(options: RunnerOptions, output: { print: boolean }): Promise<string> {
  const name = String(options.name ?? 'local')
  const labels = labelsOf(options)
  const scope = await scopeOf(options)

  const secret = generateToken()

  let lookup = db
    .selectFrom('runners')
    .select(['id'])
    .where('name', '=', name)
    .where('scope_type', '=', scope.type)

  if (scope.id !== null)
    lookup = lookup.where('scope_id', '=', scope.id)

  const existing = await lookup.executeTakeFirst()

  if (existing) {
    // Re-registering rotates the credential rather than making a second runner
    // with the same name, which is what somebody re-running this actually
    // wants - and it means a leaked token is fixed by running one command.
    await db
      .updateTable('runners')
      .set({ token_hash: secret.hash, labels: labels.join('\n'), state: 'active' })
      .where('id', '=', Number(existing.id))
      .execute()
  }
  else {
    await db
      .insertInto('runners')
      .values({
        name,
        scope_type: scope.type,
        scope_id: scope.id,
        token_hash: secret.hash,
        labels: labels.join('\n'),
        // `active` or `disabled` are the states a runner has; whether it is
        // busy is a lease on a job, not a column here.
        state: 'active',
        version: '1',
      })
      .execute()
  }

  if (output.print) {
    console.log(`Runner \`${name}\` registered for ${scope.label}, answering to: ${labels.join(', ')}`)
    console.log('')
    console.log('Its credential, shown once:')
    console.log('')
    console.log(`  ${secret.token}`)
    console.log('')
    console.log('Start it with:')
    console.log('')
    console.log(`  ./buddy runner:local --token ${secret.token}`)
    console.log('')
    console.log('Steps run as this user, on this machine, with no isolation. Fork pull requests are refused.')
  }

  return secret.token
}

/**
 * What a new runner may take work from: the whole instance, or one repository.
 *
 * One repository is the scope for a machine somebody provides for their own
 * project's CI. An instance-wide runner takes any repository's jobs, including
 * a repository somebody else created here five minutes ago with a workflow that
 * runs whatever it likes - and it runs it as this machine's user, with no
 * isolation. Scoping is what keeps a machine bought for one project from
 * becoming everybody's shell. `claim.ts` narrows to it in SQL and
 * `runnerReaches` checks it again, so a runner registered here cannot be handed
 * anything else.
 */
async function scopeOf(options: RunnerOptions): Promise<{ type: 'instance' | 'repository', id: number | null, label: string }> {
  const wanted = String(options.repository ?? '').trim()
  if (!wanted)
    return { type: 'instance', id: null, label: 'the whole instance' }

  const [ownerHandle, name] = wanted.split('/')
  if (!ownerHandle || !name)
    throw new Error('--repository must be owner/name')

  const org = await db.selectFrom('organizations').select(['id']).where('handle', '=', ownerHandle).executeTakeFirst()
  const user = org ? null : await db.selectFrom('users').select(['id']).where('handle', '=', ownerHandle).executeTakeFirst()
  const owner = org ? { type: 'organization', id: Number(org.id) } : user ? { type: 'user', id: Number(user.id) } : null

  if (!owner)
    throw new Error(`No organization or user is called ${ownerHandle}`)

  const repository = await db
    .selectFrom('repositories')
    .select(['id'])
    .where('owner_type', '=', owner.type)
    .where('owner_id', '=', owner.id)
    .where('name', '=', name)
    .executeTakeFirst()

  if (!repository)
    throw new Error(`${wanted} is not a repository on this instance`)

  return { type: 'repository', id: Number(repository.id), label: wanted }
}

/**
 * The labels this runner answers to.
 *
 * `ubuntu-latest` is in the default set deliberately: it is what every workflow
 * copied from Actions says, and a new instance where the first `runs-on:`
 * anybody writes matches nothing is an instance where CI appears to be broken.
 * Naming it here is a claim about *what the label means* - "the machine the
 * instance is on" - which is the honest reading for a single-tenant install and
 * is stated on every start rather than assumed.
 */
function labelsOf(options: RunnerOptions): string[] {
  return String(options.labels ?? 'ubuntu-latest,self-hosted,local')
    .split(',')
    .map(label => label.trim())
    .filter(Boolean)
}

/** The credential this host wrote for itself, if it has one. */
function readCredential(): string {
  const path = resolve(CREDENTIAL_FILE)

  if (!existsSync(path))
    return ''

  try {
    return readFileSync(path, 'utf8').trim()
  }
  catch {
    /*
     * Unreadable is treated as absent rather than fatal. The recovery is to
     * register again, which rotates the credential - and a runner that refuses
     * to start because of a file permission is a runner nobody can fix at
     * three in the morning.
     */
    return ''
  }
}

function writeCredential(token: string): void {
  const path = resolve(CREDENTIAL_FILE)

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${token}\n`)
  // Before anybody else can read it. A credential that can claim any job on
  // the instance is not a world-readable file.
  chmodSync(path, 0o600)
}
