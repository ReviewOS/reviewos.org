import type { CLI } from '@stacksjs/types'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

/**
 * Run the tests and send the results to an instance.
 *
 * The first-party collector, and it is deliberately thin: Bun already emits
 * JUnit XML, so a collector that reimplemented the reporting would be a second
 * thing to keep working. What this adds is the four facts a report needs and a
 * test runner does not know - which repository, which commit, which branch, and
 * an idempotency key - plus the retry that every collector eventually grows.
 *
 * **It exits with the runner's status, not the endpoint's.** Reporting is a
 * side effect of running tests; a network failure while reporting must not turn
 * a passing suite into a red build, and a *failing* suite must stay red even if
 * the report never arrives. The one deliberate exception is `--use-verdict`,
 * where the instance's answer decides - which is how a muted test stops failing
 * the build.
 */

interface ReportOptions {
  url?: string
  token?: string
  repository?: string
  suite?: string
  sha?: string
  branch?: string
  key?: string
  useVerdict?: boolean
  filter?: string
}

/** The environment variables every CI sets, so a person does not have to. */
function guess(): { sha: string, branch: string, key: string } {
  const env = process.env

  return {
    sha: String(env.GITHUB_SHA ?? env.REVIEWOS_SHA ?? env.CI_COMMIT_SHA ?? env.BUILDKITE_COMMIT ?? ''),
    branch: String(
      env.GITHUB_REF_NAME ?? env.REVIEWOS_REF_NAME ?? env.CI_COMMIT_REF_NAME ?? env.BUILDKITE_BRANCH ?? '',
    ),
    /*
     * The run *and the attempt*, because a rerun is a different report of the
     * same commit. Keying on the run alone would make the second attempt look
     * like a duplicate of the first and drop the results that show the flake.
     */
    key: String(
      env.GITHUB_RUN_ID
        ? `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT ?? '1'}`
        : env.BUILDKITE_BUILD_ID ?? env.CI_JOB_ID ?? '',
    ),
  }
}

export default function (cli: CLI) {
  cli
    .command('tests:report', 'Run the tests and report the results to a ReviewOS instance')
    .option('--url <url>', 'The instance, e.g. https://reviewos.example')
    .option('--token <token>', 'A credential that may report checks. Defaults to $REVIEWOS_TOKEN')
    .option('--repository <owner/name>', 'Which repository these results are for')
    .option('--suite <name>', 'The suite name, so several suites do not merge into one', { default: 'default' })
    .option('--sha <sha>', 'The commit. Read from the CI environment when not given')
    .option('--branch <branch>', 'The branch. Read from the CI environment when not given')
    .option('--key <key>', 'Idempotency key. Read from the CI environment when not given')
    .option('--use-verdict', 'Exit non-zero on the instance\'s verdict rather than the runner\'s, so a muted test stops failing the build')
    .option('--filter <pattern>', 'Run only tests matching this path, the way `bun test <pattern>` does')
    .action(async (options: ReportOptions) => {
      const url = String(options.url ?? process.env.REVIEWOS_URL ?? '').replace(/\/$/, '')
      const token = String(options.token ?? process.env.REVIEWOS_TOKEN ?? '')
      const repository = String(options.repository ?? process.env.REVIEWOS_REPOSITORY ?? '')
      const [owner, name] = repository.split('/')

      if (!url || !token || !owner || !name) {
        console.error('Needs --url, --token (or $REVIEWOS_TOKEN), and --repository owner/name.')
        process.exitCode = 1
        return
      }

      const found = guess()
      const sha = String(options.sha ?? found.sha)

      if (!sha) {
        console.error('Which commit did these tests run against? Pass --sha, or run this where $GITHUB_SHA is set.')
        process.exitCode = 1
        return
      }

      const report = join(tmpdir(), `reviewos-tests-${process.pid}.xml`)

      /*
       * Bun's own JUnit reporter, rather than a wrapper that parses console
       * output. The format is the one every framework emits and the one the
       * endpoint reads, so this command stays a courier.
       */
      const filter = String(options.filter ?? '').trim()

      const child = Bun.spawn([
        'bun',
        'test',
        ...(filter ? [filter] : []),
        '--reporter=junit',
        `--reporter-outfile=${report}`,
      ], {
        stdout: 'inherit',
        stderr: 'inherit',
      })

      const status = await child.exited

      let xml = ''

      try {
        xml = readFileSync(report, 'utf8')
      }
      catch {
        // No report at all means the runner died before writing one - a
        // compile error, a missing dependency. The build is already failing on
        // its own status, and inventing an empty report would record a suite
        // that passed with no tests.
        console.error('No JUnit report was written, so nothing was reported.')
        process.exitCode = status
        return
      }
      finally {
        rmSync(report, { force: true })
      }

      const body = {
        owner,
        repo: name,
        suite: String(options.suite ?? 'default'),
        sha,
        branch: String(options.branch ?? found.branch),
        key: String(options.key ?? found.key),
        format: 'junit',
        report: xml,
      }

      /*
       * Three attempts, then give up quietly.
       *
       * Every collector grows a retry eventually; the part worth writing down
       * is that giving up does not change the build's status. Test results are
       * evidence about the commit, and losing the evidence is not the same as
       * the commit being wrong.
       */
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const answer = await fetch(`${url}/api/repos/tests/ingest`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json',
              'Accept': 'application/json',
            },
            body: JSON.stringify(body),
          })

          const payload: any = await answer.json().catch(() => null)

          if (!answer.ok) {
            console.error(`Reporting failed (${answer.status}): ${payload?.reason ?? payload?.error ?? 'no reason given'}`)
            break
          }

          const counts = payload?.counts ?? {}

          console.log(
            `Reported ${counts.passed ?? 0} passed, ${counts.failed ?? 0} failed`
            + `${counts.muted_failures ? `, ${counts.muted_failures} muted failing` : ''}`
            + `${payload?.duplicate ? ' (already recorded)' : ''}.`,
          )

          for (const flaky of payload?.newly_flaky ?? [])
            console.log(`Newly flaky: ${flaky}`)

          if (options.useVerdict) {
            // The instance decides, which is the whole point of asking: a
            // muted test failing here should not fail the build.
            process.exitCode = payload?.verdict === 'failed' ? 1 : 0
            return
          }

          break
        }
        catch (error) {
          if (attempt === 3)
            console.error(`Could not report results: ${error instanceof Error ? error.message : String(error)}`)
          else
            await Bun.sleep(attempt * 1000)
        }
      }

      // The runner's status, deliberately. A network failure while reporting
      // must not turn a passing suite red, and a failing suite must stay red
      // when the report never arrives.
      process.exitCode = status
    })
}
