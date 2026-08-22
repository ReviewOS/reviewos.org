/**
 * Test Setup
 *
 * Runs before every test file. Sets environment variables that must
 * be present before any @stacksjs/* packages are evaluated, then
 * initialises the test environment.
 */

// Env vars that config reads at module-evaluation time
if (!Bun.env.STRIPE_SECRET_KEY)
  Bun.env.STRIPE_SECRET_KEY = 'sk_test_fake_key_for_testing'

/**
 * The public diff viewer, on for the suite.
 *
 * `config/publicdiff.ts` reads this once, when it is first imported - and every
 * test file shares one process, so *whichever file imports it first* decides
 * for all of them. Setting it in one file's `beforeAll` therefore worked when
 * that file ran alone and did nothing at all when a unit test had already
 * pulled the config in: the viewer's endpoints answered 404 and its own
 * end-to-end suite failed, on code that was correct.
 *
 * Here instead, because this file runs before any of them. Nothing asserts the
 * off behaviour through a server; that it is off by default is a property of
 * `config/publicdiff.ts`, which is read there rather than exercised here.
 */
if (!Bun.env.PUBLIC_DIFF_ENABLED)
  Bun.env.PUBLIC_DIFF_ENABLED = 'true'

/**
 * Mail goes nowhere, immediately, and always fails.
 *
 * Not a preference - three tests in `tests/e2e/digest.test.ts` assert the
 * *failure* path, because a sweep that marks rows sent when the send failed
 * loses every notification in the batch. They used to get that failure from the
 * environment: there is no mail server in a checkout, so every send failed.
 *
 * Which was fragile in both directions. `.env` points `MAIL_HOST` at `mailpit`,
 * a hostname that resolves inside a compose file and nowhere else, so each send
 * spent a DNS timeout failing and five tests blew bun's five-second limit. And
 * on a machine that *did* have a mail server, or with the mailer left at its
 * `log` default, sends would start succeeding and the same three tests would
 * fail for the opposite reason.
 *
 * So it is forced here, overriding `.env` rather than deferring to it: loopback
 * on a port nothing can be listening on. `ECONNREFUSED` arrives immediately, it
 * needs no network and no name resolution, and it says the same thing on every
 * machine. To watch mail in a real client, run the thing rather than the suite.
 */
Bun.env.MAIL_MAILER = 'smtp'
Bun.env.MAIL_DRIVER = 'smtp'
Bun.env.MAIL_HOST = '127.0.0.1'
Bun.env.MAIL_PORT = '1'

// A run-local hook secret, when the checkout has not configured one. An empty
// secret deliberately disables the post-receive endpoint (a default secret is
// a published secret), which on a fresh `.env` makes git-http's push-pipeline
// test fail for configuration rather than for code. Random per run, so it is
// never a value anything can come to depend on.
if (!Bun.env.GIT_HOOK_SECRET || Bun.env.GIT_HOOK_SECRET.trim().length < 16)
  Bun.env.GIT_HOOK_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('hex')

/**
 * Jobs run inline under test, whatever `.env` says.
 *
 * The application runs on the `database` driver, which is the point of having a
 * queue: a push is processed, an email is sent, a mirror is fetched, all outside
 * the request that asked for it. Under test there is no worker, so a queued job
 * is a job that never runs - and a test asserting that a push reached the
 * application would be asserting the queue's scheduling instead, and failing.
 *
 * Forced here rather than left to `.env` so the suite says the same thing on
 * every machine. A test that passes or fails depending on a developer's queue
 * driver is worse than one that does not exist.
 *
 * The queue itself is covered by exercising it directly, not by hoping a
 * background worker drains something mid-assertion.
 */
Bun.env.QUEUE_DRIVER = 'sync'


import { afterAll } from 'bun:test'
import { applyRuntimeDirectoryEnv } from '@stacksjs/path'
import { setupTestEnvironment } from '@stacksjs/testing'

setupTestEnvironment()

// The suite does not go through the preloader, so point stx and ts-cloud at
// `storage/` here too. Without it a test that renders a template or touches a
// cloud helper would write to `.stx` / `.ts-cloud` in the project root.
applyRuntimeDirectoryEnv()

/**
 * Skips, said out loud at the end.
 *
 * Most end-to-end suites here open with a `try` that resolves the database and
 * boots the router, and set `available = false` when that fails, so a checkout
 * without Postgres runs the unit tests instead of drowning in connection
 * errors. Every test in such a suite then returns immediately - and is counted
 * as a pass.
 *
 * That is the right behaviour and the wrong reporting. `14 pass` from a suite
 * which asserted nothing looks exactly like `14 pass` from one which asserted
 * everything, and a real defect hid behind it: the `checks` token scope was
 * missing from the model, so its suite could not create a token, skipped
 * itself, and reported green for as long as it took somebody to read the
 * warning.
 *
 * So the warnings are collected and repeated after the summary, where they are
 * the last thing on screen. `TESTS_REQUIRE_ALL=1` turns them into a failing
 * exit code, which is what a machine with a database - CI, or this one -
 * should run.
 */
const skipped: string[] = []
const warn = console.warn.bind(console)

console.warn = (...args: unknown[]) => {
  const first = String(args[0] ?? '')

  // The shape the suites already use: `[name] skipping: reason`.
  if (/^\[[^\]]+\]\s+skipping:/.test(first))
    skipped.push(first)

  warn(...args)
}

/*
 * Reported from an `afterAll` registered here, which the runner applies to
 * every file, rather than from a `process.on('exit')` handler: `bun test` does
 * not fire one, so the summary written that way is never printed. This runs at
 * the end of each file that skipped, which is also where a reader is looking.
 */
afterAll(() => {
  if (skipped.length === 0)
    return

  const lines = skipped.splice(0, skipped.length)

  warn(`\n${lines.length} suite(s) skipped themselves and passed without asserting anything:`)

  for (const line of lines)
    warn(`  ${line}`)

  // Thrown rather than an exit code, so it lands in the summary as a failure
  // with the reason attached.
  if (Bun.env.TESTS_REQUIRE_ALL === '1')
    throw new Error(`TESTS_REQUIRE_ALL=1 and a suite skipped itself: ${lines.join(' / ')}`)
})
