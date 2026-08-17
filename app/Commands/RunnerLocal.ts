import type { CLI } from '@stacksjs/types'
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

interface RunnerOptions {
  url?: string
  token?: string
  name?: string
  labels?: string
  once?: boolean
  jobs?: string
  register?: boolean
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
    .action(async (options: RunnerOptions) => {
      if (options.register) {
        await registerRunner(options)
        return
      }

      const token = String(options.token ?? process.env.REVIEWOS_RUNNER_TOKEN ?? '').trim()

      if (!token) {
        console.error('A runner credential is required. Run `buddy runner:local --register` once to make one,')
        console.error('then pass it with --token or in REVIEWOS_RUNNER_TOKEN.')
        process.exitCode = 1
        return
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
      console.log(`  instance:   ${url}`)
      console.log('  isolation:  none - steps run as this user, on this machine')
      console.log('  forks:      refused; an untrusted run needs an isolated runner')
      console.log('')

      const maxJobs = options.once ? 1 : Number(options.jobs ?? 0) || 0

      if (options.once) {
        const outcome = await runOnce({ baseUrl: url, token, say: line => console.log(line) })

        console.log(outcome ? `${outcome.state}: ${outcome.reason}` : 'nothing to run')
        return
      }

      console.log('Waiting for work. Stop with ctrl-c.')

      const outcomes = await runLoop({
        baseUrl: url,
        token,
        maxJobs,
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
async function registerRunner(options: RunnerOptions): Promise<void> {
  const name = String(options.name ?? 'local')
  const labels = String(options.labels ?? 'ubuntu-latest,self-hosted,local')
    .split(',')
    .map(label => label.trim())
    .filter(Boolean)

  const secret = generateToken()

  const existing: any = await db
    .selectFrom('runners')
    .select(['id'])
    .where('name', '=', name)
    .where('scope_type', '=', 'instance')
    .executeTakeFirst()

  if (existing) {
    // Re-registering rotates the credential rather than making a second runner
    // with the same name, which is what somebody re-running this actually
    // wants - and it means a leaked token is fixed by running one command.
    await db
      .updateTable('runners')
      .set({ token_hash: secret.hash, labels: labels.join('\n'), state: 'active' } as any)
      .where('id', '=', Number(existing.id))
      .execute()
  }
  else {
    await db
      .insertInto('runners')
      .values({
        name,
        scope_type: 'instance',
        scope_id: null,
        token_hash: secret.hash,
        labels: labels.join('\n'),
        // `active` or `disabled` are the states a runner has; whether it is
        // busy is a lease on a job, not a column here.
        state: 'active',
        version: '1',
      } as any)
      .execute()
  }

  console.log(`Runner \`${name}\` registered for the whole instance, answering to: ${labels.join(', ')}`)
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
