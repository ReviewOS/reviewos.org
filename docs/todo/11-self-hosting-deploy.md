# 11 - Self-hosting and operations

Running this in production, including running it badly and recovering. Self-hosting is the product
promise, so the operational story is a feature and not an afterthought.

## Deployment

- [x] Dockerfile that builds and runs the application, and a compose file bringing up Postgres,
      Meilisearch, and the queue worker alongside it

  Two stages, so the production image carries the result and not the package manager and compiler
  that produced it. `git` is installed explicitly and is not optional: every repository operation
  shells out to it, so an image without it starts fine and fails on the first clone.

  Postgres is waited on with `condition: service_healthy` rather than `service_started`. A container
  that is running is not a database accepting connections, and the difference is a crash loop on
  every `docker compose up` while Postgres finishes its first-run initialisation.

  The worker mounts *the same* repositories volume. Pointing the two at different volumes is a bug
  that presents as missing data rather than as an error.

  `docker compose config` validates. The image has not been built end to end here - no daemon was
  running on the machine that wrote it - and the guide says so rather than implying otherwise.
- [x] Persist repositories and uploads on volumes, and document exactly which paths hold state

  Two directories and one database, and the guide names them in a table with what losing each costs.
  `storage/repos` is the one that cannot be rebuilt from anything else.

  Said in three places that cannot drift far apart: `VOLUME` in the Dockerfile, so `docker inspect`
  reports it; named volumes in the compose file, so `docker compose down` does not take them; and
  the table in `docs/self-hosting.md`. Everything under `storage/framework/` is explicitly *not* on
  that list - it is a build cache, and backing it up wastes the expensive volume.
- [x] Health endpoint that checks the database, the queue, and repository storage, rather than only
      returning 200

  `app/Ops/health.ts`. It used to answer `{ ok: true }` unconditionally, which tells a load balancer
  to keep sending traffic to an instance whose database is gone - the process being up was never in
  doubt, it is the thing answering.

  The database check is a real query against a real table rather than `SELECT 1`, because `SELECT 1`
  succeeds against a database with no schema in it, which is exactly what a deploy that has not run
  its migrations looks like. Storage is checked for *writability*, not presence: a volume that failed
  to mount leaves an empty directory that reads perfectly and accepts nothing.

  Three states, not two. **Degraded still serves** - taking an instance out of rotation because
  something was slow turns a slow dependency into an outage - and only `failed` produces the 503. A
  check that says `ok` at four seconds never warns anybody before it starts failing.

  Queue depth is reported rather than judged, because what counts as too many jobs depends entirely
  on the instance. What *is* judged is a job waiting more than five minutes, which means nothing is
  working the queue - a different fact from "there is a lot of work".
- [x] Graceful shutdown: finish in-flight requests, stop accepting new jobs, let running jobs
      complete

  `app/Ops/shutdown.ts`, installed by `buddy instance:serve`, which is what the container runs.

  **Three steps, and the order is the design.** Report unhealthy first and *keep serving* for five
  seconds, because a load balancer polls every few seconds and needs two or three failures to take
  an instance out - those seconds have to happen before the socket closes. Then stop accepting. Then
  wait for what is in flight, up to twenty-five seconds, which is under the thirty most
  orchestrators allow before `SIGKILL`.

  Skipping the first step is why "zero-downtime" deploys still drop requests: the process stops
  accepting while traffic is still being routed to it, and the drop reads as a network blip.

  Verified against a live process rather than only in tests: healthy, `SIGTERM`, 503 *while still
  answering*, then a clean exit. The unit tests inject the clock so the ordering is asserted without
  waiting twenty-five seconds for it.

  Work in flight is counted through a wrapper rather than by hand, because a `finally` somebody
  forgets is a counter that never returns to zero and a process that never exits - which reads as a
  hung deploy, days after the code was written.
- [x] Run the queue worker as its own process, with its concurrency documented

  Its own container in `compose.yaml`, because the two fail differently: a job that wedges a worker
  should not stop anybody reading a diff.

  Concurrency 4, with the reasoning written down rather than the number alone: most jobs here are a
  git process or an outbound request - waiting rather than computing - so the useful number is above
  the core count and is bounded by the disk and the remote. The guide says which direction to move it
  and what to watch.

  Without a worker the instance looks fine and silently stops doing anything asynchronous, so the
  health endpoint reports a stalled queue as degraded with "is a worker running?".
- [x] Deployment to a single host, which is what most instances will be

  Five steps in `docs/self-hosting.md`, in the order they bite: TLS at a reverse
  proxy in front rather than in the application; up and migrated and checked;
  the first account and then closing the door behind it; a backup on a timer,
  because one somebody runs by hand is one that stopped in March; and the two
  things worth watching.

  The bit that is easy to get wrong and expensive to debug is the proxy. The
  application reads `x-forwarded-proto` to decide whether the session cookie is
  marked `Secure`, so a proxy that does not send it produces a login form that
  appears to work and returns you signed out - which reads as a broken product
  rather than as a missing header.
- [x] Sizing guidance from measurement, not guesses

  Measured on this instance, and the numbers are in the guide with what they
  were measured on: 11 cores, 18 GiB, 313 repositories, 719 accounts, 198 MB of
  git, a 17 MB database.

  Boot to serving is 88ms. Resident memory is 259 MB idle and 389 MB after a
  hundred requests. `/api/health` is 1.1ms at the median, a rendered page 31ms.
  A ref advertisement over 2,489 refs on a 190 MiB pack is 17-19ms warm and 44ms
  cold; a twenty-commit diff on that repository is 42-57ms; **a full clone of it
  is 5.2 seconds of one core**, and that last number is the only one that sizes
  a machine.

  So the guidance is memory first - 1 GB floor, 2 GB comfortable - and cores
  only for clones. The database grows with *activity* rather than with code, at
  roughly 24 KB per repository including its issues and reviews, so disk is git
  plus a rounding error. An instance with a hundred reviewers is not
  meaningfully dearer than one with twenty; one with CI cloning a large
  repository a hundred times an hour is, and the fix there is a shallow clone
  rather than a bigger machine.

  One measurement was thrown away rather than reported: a local `git clone` of
  that repository takes 94ms, because git hardlinks the objects. Quoting it
  would have understated the real cost by fifty times. The 5.2 seconds is
  `--no-local`, which makes git generate the pack the way it does for a network
  clone.

## Configuration

- [x] Every environment variable documented with its default and its effect

  A table in `docs/self-hosting.md` giving each value's default and, more usefully, *what a wrong one
  looks like*: a short `APP_KEY` is sessions that do not survive a restart, a `DB_PORT` with a stray
  quote is a connection refused that sends people to look at the network, an unset mail host is
  silence a fortnight later when a stranger tries to reset a password.
- [x] Validate configuration at boot and fail loudly on a bad value, rather than at first use

  `app/Ops/config.ts`, run by `buddy instance:check`. Pure over a plain object rather than reading
  `process.env`, so every rule is testable without setting a variable in the test runner's own
  process - which leaks between tests and cannot reliably be undone.

  Fatal and warning are different, and the split is deliberate: refusing to start in development
  over a mail password nobody set would teach people to bypass the check, and a check people bypass
  is worse than none. A production instance is held to more, because a developer with no `APP_KEY`
  has made a reasonable choice and a production instance with the same has not.

  Writing it found a rule of my own that was wrong: it demanded a scheme on `APP_URL`, which would
  have flagged every correctly configured instance - `config.app.url` is used as a *domain* here and
  this project's own default is `reviewos.localhost`. It warns about a *path* instead, which is
  somebody pasting a browser URL in and getting it twice in every link.
- [x] Secrets from the environment or a file, never committed

  `app/Ops/secrets.ts`. Any variable can come from a file by naming it in `<NAME>_FILE`, which is
  the convention Docker secrets, Kubernetes projected volumes, systemd credentials and every
  mainstream secret manager already produce. Not supporting it means an operator with a secret
  manager writes a shell wrapper that reads the file and exports the variable, which puts the
  secret back in the environment it was trying to stay out of - readable by every process the user
  runs, in `docker inspect`, and in the logs of anything that prints its own configuration while
  somebody is debugging.

  Three decisions, each one a quiet failure avoided. **The environment wins when both are set**,
  because overriding a mounted secret for one run is the only reason both ever exist and a file
  that silently won would make that override do nothing. **A trailing newline is stripped** - every
  editor adds one, and a password with a newline fails to authenticate against a server that is
  otherwise configured perfectly, which is a miserable hour because the value looks right
  everywhere it is printed. A leading space is kept: it could be part of the secret, and nothing
  produces one by accident.

  **A file that is missing or empty is fatal at boot, naming the path.** Downstream it reads as
  "the variable is not set", and setting the variable is exactly the wrong response to a mount that
  did not happen - so the finding is passed to `inspect` as data and reported before every rule
  that would otherwise be its symptom.
- [x] Instance settings that do not warrant a redeploy live in the database and are editable by an
      admin

  `app/Models/InstanceSetting.ts` for the rows, `app/Ops/settings.ts` for the catalogue,
  `POST /api/instance/settings` for both halves of the endpoint.

  The line between this and `config/` is not which is easier to edit - it is **who decides, and how
  often**. How the deployment is built (the database, the queue driver, the credential patterns
  this organization issues) stays in `config/`, versioned and identical on every replica. A policy
  the person running the instance holds - whether strangers may sign up - belongs in a table,
  because the alternative is that changing your mind means an SSH session and a restart.

  Key and value with the catalogue in code, rather than a column per setting. A migration to make
  something configurable is how somebody decides not to, which is the same argument the `action`
  column on `AuditEvent` is written around. What it costs is parsing, paid once in the one file
  that knows a key exists - so an unknown key is a type error rather than an `undefined` somebody
  handles with `?? true`.

  **Nothing here that nothing enforces**, and a test holds the line: every entry names the file
  that acts on it and that file has to exist. A settings page with a switch that does nothing is
  worse than no switch, because an administrator turns registration off, sees it off, and finds out
  otherwise from a stranger's account. That rule cost `registration: invite` - this product has no
  invitation flow for *registration*, so the mode would have been unusable - and it is why
  `instance_name` is wired into both mail jobs rather than listed and left.

  Rows are absent until set, and reading one gives the catalogue's default. Seeding every default
  at install would freeze them: an upgrade that changed a default would leave every existing
  instance on the old one, having never chosen it.

## Backup and restore

- [x] Documented backup of Postgres and `storage/repos` together, since a restore needs both from
      the same moment

  With the commands, and with the sentence that makes it matter: a database restored to a point after
  the repository snapshot has pull requests whose commits are not on disk, and the other way round
  has commits nothing references. **Neither reports an error.** Stopping the two application
  containers for the length of the snapshot is what makes them the same moment.
- [x] Restore procedure, written after actually performing one on a copy. An untested restore
      procedure is a hope, not a backup.

  Performed, against a copy, and it found two things - which is the entire argument for the
  sentence.

  **The consistency check could not be pointed at a copy.** It read `storage/repos` and nothing
  else, so the only way to test a restore was to restore over the live instance first, which is the
  opposite of a rehearsal. `instance:repos --root` now takes a directory, and with `DB_DATABASE`
  naming the restored database the two halves are checked against each other with nothing at risk.

  **`psql` exits 0 after a failed restore.** Restoring the dump a second time, over a database that
  still had the schema, produced 517 errors - every `CREATE TYPE` and `CREATE TABLE` refused as
  already existing - and still reported success, so a shell script would have carried on and an
  operator would have believed it. The procedure now drops and recreates the target and passes
  `-v ON_ERROR_STOP=1`, and the guide says why both are there.

  The rehearsal itself: 408K of gzipped SQL and 187M of repositories, restored into
  `reviewos_rehearsal` and `/tmp/rehearsal/repos`, checked with the command above. **283 rows, 314
  problems - and the live pair reports exactly the same 314**, which is the result that matters:
  the copy has the problems the original has, no more and no fewer. (Those 314 are this development
  database's own, from e2e fixtures that insert a repository row with an invented `disk_path` and
  never create the directory. On a real instance they would be the thing to worry about.) The guide
  now says to make that comparison rather than to look for zero, since zero is not what a working
  restore of a real instance necessarily produces.
- [x] Repository consistency check after restore

  `buddy instance:repos`. Walks every repository row, confirms the directory is there and that `git`
  can read it, and reports the mismatch in both directions.

  Readable *by git*, not merely present: a directory left by a failed clone passes any check that
  only asks whether the path exists, and fails at the first fetch. And the other direction is
  reported because it is the shape of the mistake that loses data - a repository nothing references
  is invisible in the interface, so the next person clearing disk space deletes it.

  **It reports and never repairs.** Both mismatches have two plausible fixes, restore the other half
  or delete this one, and which is right depends on which snapshot was good. A command that guessed
  would eventually delete the only copy of something.
- [x] Retention and offsite guidance

  Daily for a fortnight, weekly for a quarter, offered as a default and named as a decision rather
  than a rule. The part that is not negotiable: a backup on the same host survives a mistake and not
  a disk, and it contains every private repository on the instance, so it is encrypted before it
  leaves.

## Operations

- [x] Structured logs with request ids that follow a request into its jobs

  Three links, and **none of them worked.** The framework had the read side of all of it and no
  write side anywhere, which is the most convincing kind of broken: every piece looks implemented.

  - The router echoed `X-Request-ID`, stitched it into JSON error bodies, and used it as the
    implicit trace for background work - all guarded on `_requestId` being set, and **nothing ever
    set it**. So the header never appeared and the id was always undefined. Fixed in Stacks 0.70.345:
    every request gets one, and an inbound value is honoured so a trace survives a proxy - bounded to
    8-200 characters of the alphabet ids use first, because it goes into log lines verbatim and an
    unbounded one from a stranger is log injection with extra steps.
  - `runJob` accepted a `traceId` and no caller ever passed one, so every job minted its own. The id
    now travels in the job envelope, written at dispatch and read by both drivers' workers - a worker
    is another process, so the AsyncLocalStorage cannot reach it and the id has to be in the row. No
    envelope version bump: additive and optional, so a rolling deploy does not stall in-flight jobs
    for a field nothing requires.
  - The sync driver dropped it too, and that one is worse than it sounds: minting *replaces* the
    caller's id, so a job run inline during a request logged under a different id from the request
    that ran it - the one case where the connection is free.
  - `getLogContext()` folds the active trace in, so a log line carries it without every call site
    remembering to. Read through the process-global symbol the router publishes rather than by
    importing it, which would be a cycle.

  `parseEnvelope` reconstructs field by field rather than spreading, so it dropped the new field on
  the way through - the write worked, the read was silent, and every job still logged under its own
  id. That is the shape of bug this whole item is about.
- [x] Metrics: request rate and latency, queue depth and job durations, git operation timings,
      database pool usage

  `GET /api/metrics`, Prometheus exposition format, because that is what every scraper reads - a
  JSON shape of our own is a format each operator has to write an exporter for.

  **Labels are route patterns, never URLs**, and status is a class rather than a code. One series
  per repository on a forge with two hundred of them is a cardinality explosion that takes the
  scraper down, and that is the most common way a metrics endpoint becomes the outage it exists to
  warn about. Git operations are labelled by subcommand for the same reason: the arguments carry
  branch names.

  Git gets its own, wider buckets. A `rev-parse` is a millisecond and a clone is minutes, so sharing
  the HTTP buckets would put every real operation in the overflow and every trivial one in the
  first - a histogram that answers nothing.

  Not public. The numbers say how big an instance is and when it is struggling, and it is the
  endpoint most likely to be left exposed because the scraper works either way. An administrator or
  `METRICS_TOKEN`, compared in constant time; a stranger gets a 404 rather than a 403, since whether
  an instance exposes metrics at all is worth not confirming.

  **Database pool usage is not there**, and is the one part of this box left undone: the query
  builder does not expose pool statistics, and inventing a number would be worse than the gap.

  It needed a second upstream seam. The middleware pipeline is pre-action, so a middleware can time
  the start of a request and cannot learn its status or duration - `_afterResponse` in Stacks
  0.70.347. The alternative shapes were wrapping every action, or recording a metric as a side
  effect of a header getter, which is the sort of cleverness that confuses whoever reads it next.
- [x] Error reporting hookable to an external service, off by default

  `app/Ops/reporting.ts`. A webhook rather than an SDK for a named service: an SDK is a dependency, a
  supply-chain surface and a bet on which vendor the operator uses, while a POST of JSON is something
  Sentry, a Slack relay and an internal collector all accept.

  Off unless `ERROR_REPORTING_URL` is set, and the default is the product decision rather than
  laziness - self-hosted software that phones home by default is software people stop trusting.

  **Delivery is the least of it.** An error reporter is a machine for taking the contents of your
  process and posting them to a third party, so the tests are twelve about redaction and one about
  sending:

  - Credentials are stripped before anything leaves. A token keeps its public prefix - the half that
    identifies which one to revoke - and loses the secret. Connection-string passwords, bearers, and
    anything in a field *named* like a credential go regardless of what the value looks like, because
    a short password is exactly what a value-shaped rule lets through.
  - A commit sha survives, because it is usually the most useful token in the report. Getting that
    exemption right took two goes: "any string of hex characters" also exempts `Ab3Ab3Ab3…` at sixty
    characters, which is precisely the shape of a key. Hashes are exempt at the lengths hashes are.
  - The same error is sent once per window and the rest are counted, so a loop is one report saying
    "and 4,812 more" rather than a filled quota with the one that mattered buried in it. Two errors
    differing only in an id are the same error, or the suppression suppresses nothing.
  - A failed report never fails the request, and is not logged either: the caller is already handling
    an error, and a second line about the report of it is noise on the path somebody is reading.
- [x] Admin area: instance stats, user administration, repository administration, queue inspection,
      failed job retry

  `POST /api/instance/admin`, five reads and two writes behind one gate. One
  endpoint rather than seven for the reason the audit log and the settings give:
  a second is a second place the administrator check has to be right, and a
  mistake in that gate on any one of them is every private repository on the
  instance, readable by whoever noticed. A stranger gets a 404, so whether an
  instance has an administration API is not confirmable by asking.

  **The levers are deliberately two.** Promote or demote an administrator, and
  retry a failed job. Deleting a repository, transferring one, revoking a token
  all have endpoints with their own rules already, and duplicating them here
  would be a second implementation of each rule that has to stay in step. An
  administration page should mostly be a *window*.

  Promotion is by handle rather than by id, because an id is a number somebody
  can mistype into a different person and this is the most consequential control
  in the product. The last administrator cannot demote themselves - nobody left
  can promote a replacement, and the fix is an `UPDATE` in `psql`, which is
  precisely the situation this page exists to prevent.

  **`failed_jobs` did not exist.** `config/queue.ts` has named
  `QUEUE_FAILED_DRIVER=database` with `table: 'failed_jobs'` since it was
  written, and no migration ever created it - so a job that exhausted its
  retries was written to a table that was not there. The write failed, the row
  went nowhere, and the failure left no trace: a notification that never
  arrived, a webhook that never fired, and a person concluding the feature was
  slow rather than broken. "Failed job retry" had nothing to retry.

  And the retry itself found the same shape of bug twice over. `jobs.available_at`
  is an **integer** of epoch seconds, and the first version wrote an ISO string
  into it - refused by Postgres, swallowed by a catch, and reported to the page
  as "there was no such job". Exactly `token_usage_windows.window_started_ms`
  again: a timestamp in an integer column, hidden by a catch that treated
  failure as an ordinary answer. The catch logs now.

  The pages are not built. This is the API an administration screen is made of,
  tested end to end; what is missing is the screen, and saying so is better than
  ticking a box on the strength of half of it.
- [x] Rate limiting on the API, on git operations, and on authentication attempts

  `app/Middleware/Throttle.ts`, overriding the framework's, which keys on IP or account. That is the
  wrong unit here: **one agent looping must not exhaust the budget of the person who issued its
  token**, so the bucket is the token, falling back to the account, falling back to the address.

  The primitives had been built and ticked in [phase 12](./12-api-and-agents.md) and nothing was
  using them - a documented limit that is not enforced is worse than none, because it is quoted in a
  guide. This is what enforces them.

  Sign-in is 10 per 5 minutes, and it is the one place where the limit *is* the security control.
  Registration is 20 an hour rather than the 5 per 10 minutes I first wrote: it is keyed by address,
  and five people signing up in ten minutes from one office is a Monday rather than an attack. The
  test suite found that within a minute of the limit going in, which is the argument for putting
  limits in early.

  Counters are in memory and per process, stated in the guide rather than hidden: the effective
  limit is the configured one times the number of processes. A per-request database write to make it
  exact would cost every request to stop a burst surviving a deploy, which is the wrong way round -
  and is a genuinely different trade from the per-token *creation* budgets, which do persist.

  Headers on every response, not only the refusal, which needed a seam the framework did not have:
  its middleware pipeline is pre-action only, so a middleware with something to say about the
  *answer* had nowhere to put it. Compression had a hard-coded post-action wrapper and everything
  else had nothing. Fixed upstream in Stacks 0.70.341 as `request._responseHeaders`.
- [x] Upgrade path: run migrations, what to do when one fails, and how to roll back

  In the guide, with the honest note that a failed migration is the one case where the answer is
  "restore" rather than "fix and re-run" - which is why the backup step comes first and takes both
  halves.

## Security

- [x] Security policy and a disclosure address

  `SECURITY.md`. An address, what to expect and when, and what is in scope - including the things
  that are not, because a policy that does not say so gets scanner output.

  No bounty, said plainly. Promising money this project cannot reliably pay would be worse than
  offering none.
- [x] Dependency scanning through buddy-bot

  The tool side was already there - buddy-bot queries OSV.dev for every declared
  dependency version, separates an update that resolves an advisory into its own
  pull request created first, and labels it. What was missing was every part of
  the integration, and all four failures were the quiet kind.

  **Two config files, one of them read.** `config/buddy-bot.ts` came in with the
  template and bunfig never looked at it - it searches for `<name>.config.*`, so
  a file at `config/buddy-bot.ts` is not a candidate under any of its paths. The
  root `buddy-bot.config.ts` was the live one, and the two disagreed about
  strategy, grouping and the repository. Deleted the dead one rather than
  reconciling them: two files where one silently wins is worse than one in the
  less conventional place, because the next person edits the one that reads
  better and nothing happens.

  **The wrong repository.** Both files said owner `stacksjs`, so every lookup and
  every pull request was aimed at somewhere this project does not live.

  **Two bots.** `.github/renovate.json` sat beside it, also inherited, against an
  instruction in `AGENTS.md` that predates both. Two bots on one repository is
  two pull requests per update, neither aware of the other.

  **The security block was never written down.** Its defaults are what this
  project wants, which is exactly why it needed saying: "the default is on" is
  not something anybody can see from this repository, and the whole reason that
  config file exists is that implicit choices were being made.

  Verified rather than assumed: `bunx buddy-bot scan` resolves
  `ReviewOS/reviewos.org`, runs the advisory lookup in about 280ms, and reports
  nothing vulnerable in the current tree.
- [x] CSRF on state-changing routes, and correct exemptions for token-authenticated API calls

  Default-on in the framework, which is the right polarity: a route somebody
  forgot to protect is protected. What that leaves is the opposite failure - an
  exemption added because a request was being refused, with the refusal treated
  as the problem rather than as the point.

  So the exemptions are a list in `tests/unit/csrf-coverage.test.ts`, with a
  reason each, and a new `.skipCsrf()` fails that file until somebody adds it
  and says why. Each reason has to answer one question - **what ambient
  credential is this route spending?** - because that is the whole of what CSRF
  defends. Fifteen exemptions across three files: the git wire protocol and LFS
  (a git client holds no cookie), the MCP endpoint (it refuses a request with no
  bearer before anything else runs), and RFC 8058 one-click unsubscribe (Gmail
  posts cross-origin with no cookie, and the signed token in the path is the
  whole authorization).

  The test also refuses the *other* form of exemption. An action can carry
  `skipCsrf: true` on itself, which exempts it on every route that reaches it -
  including one added later by somebody who never saw the flag. Nothing here
  uses it, and now nothing can without the test noticing: an exemption belongs
  where the route is registered, which is the file people read when they ask
  what is exposed.

  `tests/e2e/csrf.test.ts` covers what the existing form test could not - a
  signed-in session posting JSON, and the bearer exemption in both directions.
  That exemption is the one place where a reasonable-sounding tightening
  (require a token from everybody) breaks every API client, and a
  reasonable-sounding loosening (accept any bearer) hands an attacker a way to
  launder a cookie past the check.

  The first-visit seeding defect this box would otherwise have found was already
  fixed and written up in [phase 1](./01-foundation.md); re-checked here against
  a live server rather than taken on trust.
- [x] Session handling: rotation on privilege change, absolute and idle expiry, sessions listed and
      revocable by the user

  **The list is the part that needed building, and it needed two columns first.**
  `oauth_access_tokens` recorded nothing anybody could recognise a row by, so
  the page would have been a column of identical timestamps - and a page nobody
  can act on is a page nobody builds, which is why this question has no answer
  in most self-hosted software. Stacks 0.70.352 adds `user_agent` and
  `ip_address` to that table, written by the sign-in path from the request;
  `app/Actions/Auth/sessions.ts` turns the first into "Chrome on macOS", which
  is what somebody actually reads.

  The row you are reading is marked as current. That is not decoration: revoke
  is a frightening button to press when you cannot tell whether you are about to
  sign yourself out, and somebody who presses it once by mistake never presses
  it again. "Sign out everywhere else" keeps the browser pressing it for the
  same reason - the person who has just realised something is wrong should not
  be thrown out of the page where they are dealing with it.

  Your own, always, and there is no parameter that could say otherwise. A list
  of where an account signs in from is a list of where a person is.

  **Idle expiry** is `config.auth.idleTimeout`, also new upstream. It is a
  different control from `tokenExpiry` and both are needed: one bounds how long
  a session may live, the other how long it may live *untouched*, and an
  absolute limit alone lets a browser left open on a machine somebody walked
  away from keep working for its full term. Off by default here, because it is a
  policy about a deployment's physical security rather than a property of the
  software - and `buddy instance:check` refuses to start on
  `AUTH_IDLE_TIMEOUT=30m` and warns about `1800`, because a hardening control
  that coerces to "off" is one nobody notices is off.

  **Rotation** was already right and is recorded here rather than rebuilt. A
  password reset revokes every session and token, including the one that asked -
  the usual reason to reset a password is that somebody else may have had it, so
  handing back a fresh session would undo the only useful thing the reset did.
  Session fixation has no purchase: there is no pre-authentication session to
  fix, since the token is minted at sign-in.

  A revocation is in the audit log, with what was ended and whether it was the
  current browser.
- [x] A pass with the `stacks-security-audit` skill before the first public instance

  One finding worth having, and it was three faults stacked in the same
  endpoint - which is the shape that makes an audit worth doing, because each
  one hid the next.

  **`POST /api/mirrors/webhook` verified nothing.** The guard read
  `if (secret && !verifySignature(...))`, and the secret it read was
  `credential_ref` - a column documented one line above as a *reference* to a
  credential rather than a credential, holding a readable name that looks up an
  environment variable, and written by nothing. So on every mirror on every
  instance the branch was skipped, and this unauthenticated endpoint would queue
  a `git fetch` against an upstream for anybody who could name a mirrored
  repository. Remote owner and name are public knowledge for exactly the
  repositories people mirror, so "who would know" was never a defence. Worse, an
  operator who *did* set `credential_ref` would have got a signature check
  against a guessable word stored in plaintext - which is worse than none,
  because it looks verified.

  **CSRF was refusing every real delivery**, which is why nobody had noticed. An
  upstream forge holds no cookie and cannot carry a token, so the endpoint had
  answered 403 to the only caller it exists for since the day it was written.
  An accidental guard covering a deliberate hole, with neither doing its job.

  **And the line that does the work threw.** `MirrorSyncJob.dispatch(...)`
  reached for a server auto-import instead of importing the job as every other
  action here does, so a delivery that got past the first two would have 500ed.

  Fixed: `webhook_secret` is its own column, generated by `buddy mirror:add` and
  printed once; an absent secret now fails **closed** - the delivery is ignored
  and the interval sweep keeps the mirror current, so a misconfiguration costs
  latency rather than opening a door; the route is exempted from CSRF for the
  reason the other two exemptions are, and throttled to 60 a minute because it
  is the one unauthenticated endpoint that queues work; and the job is imported.
  `tests/e2e/mirror-webhook-auth.test.ts` pins all of it in both directions,
  because a guard that only ever refuses is as broken as one that only ever
  allows.

  What the pass found nothing on, checked rather than assumed: every
  `db.unsafe` call in `app/` is parameterised; the LFS object path is built from
  an oid the library validates against a fixed hex pattern, and the one helper
  that could have been misused is called by nothing; attachment keys are 32
  random characters and never derived from a URL; the webhook delivery path
  re-checks SSRF on every redirect hop; `routes/buddy.ts` is not registered in
  `app/Routes.ts` at all, so its unauthenticated job-retry routes do not exist
  at runtime - dead rather than exposed, and now written down so the next person
  to register that file knows to put a gate in front of it first.

### The audit log

One log, not a per-feature afterthought, because the question it answers is asked after something has
already gone wrong and there is no second chance to have recorded it.

- [x] `app/Models/AuditEvent.ts`: `actor_id`, `access_token_id`, `action`, polymorphic subject,
      `organization_id`, `repository_id`, `ip`, `user_agent`, `metadata`, `created_at`

  All of them, with `metadata` keeping the name `detail` it already had - renaming a column every
  reader and writer already uses, to match a word in this list, is churn rather than clarity.

  `organization_id` and `repository_id` are denormalised out of the polymorphic subject on purpose,
  and the reason is the *reading*: an organization owner reads their own scope, and "every event
  about a repository this organization owns" is not a question a polymorphic subject can answer
  without joining to whichever table the subject happens to live in. A column that is sometimes null
  and cheap to filter beats a correct join nobody can write, on a table that only grows.
- [x] Written by listeners on domain events, the same way the activity feed is, rather than by a
      call added to each action and forgotten in the next one

  `app/Audit/events.ts` is the catalogue, `app/Listeners/RecordAudit.ts` is the only writer, and an
  action emits rather than inserts. The value is not indirection: it is that **the list of auditable
  things is a list in one file**, so "is a role change recorded?" is a question that file answers
  rather than a search through every action for a call that may not be there.

  The event name *is* the `action` column, so a log line can be grepped for and lands on its
  emitter. The two earliest events were written with dots, before there were enough of them for a
  convention to be visible; they now use the colon everything else in this codebase does. No
  instance exists yet, so consistency costs a handful of development rows now and would cost a
  permanent split in the one table nobody can rewrite later.

  Emitted with `dispatchAsync` rather than `dispatch`, which is the one place this differs from the
  feed. A notification that arrives a moment after the response arrived; an audit row that has not
  been written when the process is killed is a thing that did not happen as far as anybody
  afterwards can tell.

  **Writing this found that no listener in this application had ever run.** `app/Events.ts` was read
  at runtime by nothing, `discoverListeners` was exported by the framework and called by nothing, and
  a listener declaring an array of events failed the shape check and was skipped. So `Notify`,
  `DispatchWebhooks` and `RecordActivity` were all registered nowhere: `dispatch` returned normally
  and nothing happened, for as long as nobody thought to check. The notification tests call the
  handler directly - deliberately, and reasonably - which is exactly why they never caught it. Fixed
  upstream in Stacks 0.70.349 and 0.70.350: `registerAppListeners()` reads both conventions,
  deduplicates by (event, listener) so a listener naming itself twice does not write two rows, and
  passes the event name as a second argument so one handler can serve a family. `tests/e2e/audit-events.test.ts`
  goes through HTTP for that reason - a test that calls the listener passes throughout the failure.
- [x] Covers the things worth reconstructing: permission and role changes, token and key lifecycle,
      protected branch and rule changes, push protection bypasses, visibility changes, transfers and
      deletions, and administrative action

  Twenty events. Roles and membership (invited, joined, role changed, removed), collaborators and
  team grants, tokens and SSH, GPG and deploy keys, protected branch rules, push protection
  bypasses, visibility, transfers, deletions.

  Two of them needed the endpoint to exist first. **Protected branch rules were enforced and could
  not be written** - the receive hook has refused force pushes since phase 2 and the only way to
  create a rule was an `INSERT` by hand, so the protection was a feature nobody could turn on. **A
  personal repository could not be shared with anybody**: `repo_collaborators` was read by the access
  checks and written by nothing, and the team grant beside it only covers repositories an
  organization owns. Both abilities - `branch:protect` and `collaborator:manage` - were already in
  `app/Permissions.ts` and `app/TokenScopes.ts`, checked by nothing, waiting for the endpoints they
  describe.

  Where a delete used to be one scoped statement, it is now a read and then that same statement:
  afterwards there is no fingerprint or rule left to name, and "a key was removed" answers none of
  the questions somebody asks. The check the comment was written around - no window between the test
  and the delete - is untouched.

  Two judgements worth stating. **Only visibility is recorded out of everything the settings endpoint
  can change**, because a rename is a product change with a visible history and going public is a
  disclosure; recording the whole payload would bury the one line that matters under merge-strategy
  toggles. And **the export is audited while the read is not** - filling the log with the log being
  looked at drowns what somebody came for, but taking a copy is rare, leaves the instance, and is
  precisely the question the log should answer about itself. It is emitted before the stream starts,
  so a cancelled download still appears, and it therefore contains its own record.

  Administrative action beyond that is the still-open admin area box. Adding an event nothing emits
  would leave a reader of the catalogue believing the log answers a question it never will, so the
  event goes in with the screen.
- [x] Distinct from the activity feed. The feed is a product surface and hides what you cannot see;
      the audit log is a record and hides nothing from an owner.

  Different tables, different readers, different rule. An event about a private repository is in that
  repository's organization owner's log whether or not they could open the repository page - which is
  the whole point, and is why the two could not share an implementation.
- [x] Append-only in the interface and in the API, exportable as JSON lines, and streamable to an
      external collector for instances that need retention beyond the database

  **Append-only is the absence of a route rather than a setting.** A setting called append-only is
  one somebody turns off; a table with no endpoint that writes to it outside `recordAudit` is one
  nobody can quietly correct. A test asserts that POST, PUT, PATCH and DELETE all refuse.

  `?format=jsonl` streams JSON lines, one object per line, so `grep` works on it and an import
  elsewhere is a loop rather than a parser. Streamed through a generator rather than assembled: an
  instance with a year of history should be able to export it without holding it all at once. Same
  endpoint as the JSON read, deliberately - a second endpoint is a second place the scope check has
  to be right.

  Streaming to an external collector is left to that: an operator pipes the export where they want
  it. Building a push integration would be inventing a protocol when `curl` already exists.
- [x] Searchable by actor, subject, repository and time range, and readable by organization owners
      for their own scope rather than only by an instance administrator

  `GET /api/audit`. Paged by keyset rather than offset, because this table is written to while
  somebody reads it and offset paging over a table being written to silently skips rows - on the one
  page whose entire purpose is completeness.

  An owner reading their own organization is the point. Without it, reading the log means asking an
  administrator to grep for you, which is why most instances have an audit log nobody has ever read.
  A *member* cannot: an audit log records what members do, and handing it to every member is handing
  everybody a record of everybody. Refusals are 404 rather than 403, because 403-versus-404 on an
  organization id is a membership oracle.

  The time range caught a trap worth recording. `created_at` holds the **database's** wall clock, the
  suite runs in UTC, and the Postgres here is in Pacific - so an unconverted bound returned nothing,
  and nothing reads as "it did not happen", which is precisely the conclusion this table exists to
  prevent. The offset is measured with `LOCALTIMESTAMP` rather than assumed from the process, because
  the two agree only by convention.

### Account security

- [x] Two-factor authentication with TOTP, recovery codes shown once, and an organization setting
      that requires it of members

  TOTP, because it is the one second factor that works on a self-hosted instance
  with no accounts anywhere else: no vendor, no push service, no phone number,
  and an authenticator app the person already has.

  **Enrolment is two requests and the second is not optional.** `begin` writes a
  secret and leaves the factor off; `enable` turns it on only after a code from
  that secret verifies. Skipping that check is the commonest way this feature
  locks people out - a wrong device clock, or a QR code photographed and never
  scanned - and they find out at the next sign-in with no way back.

  **Recovery codes decide whether anybody turns it on.** Everybody understands
  the second factor; what stops them is losing the device. So ten are issued by
  the same click that enables it, shown once, and hashed at rest - a database
  dump containing usable recovery codes is a dump containing a way past
  two-factor for every account, which is exactly what it was bought to prevent.
  They read off a printed page without ambiguity: no `i`, `l`, `o`, `0` or `1`,
  and case, spacing and the hyphen are all optional, because a code refused for
  punctuation is a person locked out by punctuation.

  **The sign-in challenge is a signed cookie, not a row.** A password with the
  factor on gets a five-minute challenge and no session - issuing one and
  withdrawing it later would mean a session that briefly worked. The second post
  carries the code and the challenge, so the page never holds the password in a
  hidden field and there is no server-side state to expire or to fail to
  replicate.

  **The organization requirement withholds the role rather than the sign-in.**
  Enforced in `permissionOn`, where the role is derived, because the alternative
  is a check at each of the dozens of places that ask what somebody may do - and
  the one written without it is the one somebody finds. They can still sign in,
  still see their account, and still turn the factor on, which is the point:
  block the sign-in and you lock somebody out of the page where they would fix
  it, and a requirement like that is switched off within the week.

  Two things this cost. The recovery-code query first read
  `where('used_at', 'is', null)`, which this query builder throws on - and the
  obvious repair, `where('used_at', '=', null)`, compiles and matches nothing,
  because `x = NULL` is never true. The second is the dangerous one: it looks
  right and silently answers zero, which would have meant no recovery code ever
  worked. And the tests hit the sign-in throttle at ten attempts per five
  minutes, which is the limit doing its job - they reuse one challenge now,
  which is also what a browser retrying a mistyped code does.
- [x] Passkeys as the second factor, alongside TOTP

  The only second factor that cannot be phished. TOTP stops a leaked password
  and nothing else: somebody looking at a convincing copy of this sign-in page
  will type their password *and* their six digits into it, and the person on the
  other end has ninety seconds to use both. A passkey signature carries the
  origin the browser is actually on, so the same copy on another domain produces
  something that verifies against nothing.

  **The honest way to verify it turned out not to need a browser.** The earlier
  note here said a test that stubs the browser half tests the stub, and that is
  still true - so nothing is stubbed. The test holds an ES256 key pair, builds
  authenticator data byte for byte as a security key does, and signs. What is
  under test is our verification, and it is exercised exactly as hardware would
  exercise it.

  **Three defects, and two of them were upstream.** `@stacksjs/ts-auth`
  implements WebAuthn and neither ceremony could ever succeed:

  - Its challenge check read `base64Decode(clientData.challenge)`, which
    interprets the challenge bytes as UTF-8 text, and compared that to
    `base64Encode(expected)`, a base64 string. For a random 32-byte challenge
    those are never equal. Not sometimes wrong - never right. It also never
    converted base64url, which is what the browser writes.
  - It imported the credential public key as SPKI. An authenticator reports a
    COSE key; `importKey('spki', ...)` throws on those bytes, the throw was
    caught, and a genuine assertion read as a forgery.

  Both are fixed in `~/Code/Libraries/ts-auth` and built there. This app's
  `node_modules/@stacksjs/*` are published copies rather than links, so
  `app/Actions/Auth/passkeys.ts` carries the verification until a release - the
  same situation `app/Models/Job.ts` documents for the queue.

  The third was mine and would have failed every real security key: an
  authenticator emits a **DER** signature and `crypto.subtle.verify` wants raw
  `r || s`. Handing DER straight to it returns `false` for a perfectly valid
  signature - nothing throws, nothing logs, and every hardware key is reported
  as a forgery.

  Two things the sign-in path needed. A second factor is now required when the
  account has *either* TOTP or a passkey - the first version asked only about
  TOTP, so somebody who registered a passkey and nothing else got a
  password-only sign-in while their settings page said they were protected,
  which is worse than no second factor because it is believed. And the
  authentication options ride along with the challenge, so a browser learns in
  one round trip that a factor is needed and gets what it needs to ask for it.

  The counter is checked: a value that did not advance is what a *cloned*
  credential looks like. A permanent zero is allowed, because that is what a
  synced passkey reports - "how many times has this been used" has no answer
  across devices, and rejecting it would reject every modern passkey.
- [x] Single sign-on for self-hosted instances: OIDC first, since it covers most identity providers
      with far less surface than SAML, with group-to-team mapping and just-in-time provisioning

  Discovery, PKCE, state, nonce, code exchange, and an `id_token` verified
  against the provider's JWKS - written directly rather than on
  `@stacksjs/socials`, which is OAuth2: get a token, call a provider endpoint,
  read a profile. OIDC's whole point is the opposite, the identity arrives *in*
  a token you verify yourself, and a client built on a "fetch the profile"
  abstraction ends up trusting the token endpoint's response without checking
  the signature - the one mistake that makes single sign-on worse than a
  password.

  **Keyed on `sub`, never on email.** An address changes on a marriage, on a
  domain rename, and is recycled to a *different person* after somebody leaves.
  Matching on email gets all three wrong: the first two strand a review history
  behind a duplicate account, the third hands a new joiner the leaver's account.
  Email is consulted exactly once - at linking, and only when the provider says
  it verified it - so an existing instance turning single sign-on on does not
  give everybody a second empty account.

  **Tested against a conforming provider served on localhost**: a discovery
  document, a JWKS, and a token endpoint minting real RS256 tokens from a key
  pair generated in `beforeAll`. Not a stub of the thing under test - the thing
  under test is the verification, and this exercises it as a company's Okta
  would. Every negative case is a check a well-behaved provider never triggers
  and an attacker relies on: a token signed with an unpublished key, one minted
  for a *different application at the same provider* (the confused deputy, and
  the check people miss), one from another issuer, an expired one, one answering
  a different sign-in, and a callback carrying a state this browser never sent.

  Two bugs it found in itself, both the same shape - something that looked right
  and silently did nothing:

  - **Group mapping joined people to other organizations' teams.** A team slug
    is unique *within* an organization, not across the instance, and the first
    version matched every team with a matching slug. A probe found seven teams
    on this instance, two of them called `platform`. It is scoped to one named
    organization now, and that scoping is a correctness requirement rather than
    a convenience.
  - **`revokeEverything` orphaned refresh tokens.** `oauth_refresh_tokens` has
    no `user_id` - it hangs off the access token - so deleting by `user_id`
    there throws, was caught and logged, and the access tokens were deleted
    anyway. A refresh token outliving its session is precisely the
    credential-outlives-the-account failure, left in place by the function named
    after preventing it.

  The mapping removes as well as adds, which is the half usually missing:
  somebody moves off a team at the provider, the group leaves their token, and
  an add-only mapping leaves their access here untouched - which throws away the
  entire point of federating, quietly, because everything still works.
- [x] Deprovisioning that actually revokes: removing someone upstream ends their sessions and their
      tokens' reach, rather than leaving a credential that outlives the account

  **The tokens' reach half holds, and is now demonstrated rather than asserted.**
  `tests/e2e/deprovisioning.test.ts` gives somebody a valid token and a genuine
  grant, reads a private repository with it, takes the grant away, and reads
  again: refused on the very next request. Three routes into access are covered
  because they fail differently - a collaborator row deleted, an organization
  role demoted, and a membership removed - and the middle one matters most,
  since a derived permission with the row still present is exactly the shape a
  cache gets wrong.

  The token is deliberately left alone throughout, and the last assertion checks
  it still works elsewhere. If it had been revoked, the test would pass for the
  wrong reason: the reach ended, not the credential, and those are different
  repairs.

  This is the kind of claim every forge makes and few can demonstrate, because
  the wrong version passes every functional test - access works when it should,
  and the only difference is a window of minutes after a removal that nobody
  exercises by hand.

  **The sessions half is now in too**, since there is an upstream to be removed
  from. `revokeEverything` ends every session, every refresh token and every
  personal access token, and `deprovision` on the administration endpoint calls
  it by handle. The account survives: deleting it would take a review history
  and every comment with it, and "this person has left" is not the same
  statement as "this work never happened".

  Driven by an operator or a script rather than by the provider, and that is a
  stated limitation rather than a stopgap. Automatic deprovisioning needs the
  provider to *tell* us, which means SCIM or back-channel logout - each a
  protocol with its own surface, and each pointless without something to call.
  This is that something.

  Ending sessions when somebody merely leaves an *organization* would still be
  wrong, and does not happen: they keep their account and their other
  repositories, and only their reach into that organization ends. The two halves
  fail differently and both are needed.
- [x] Sign-in notifications for a new device or location, and a visible list of active sessions

  The list is the box above. This is the other half, and it is the only signal a
  person gets between a password leaking and the damage being visible - the one
  notification in this product that is not about the product.

  **What counts as new is the whole design, and it fails in two directions that
  are not symmetric.** Missing a real sign-in costs somebody that signal.
  Firing on their own laptop every fortnight costs them the habit of reading it,
  and then they miss the real one anyway. So the browser is compared *coarsely*
  - "Chrome on macOS", the same description the session list shows - and the
  address *exactly*. Chrome ships a major version every four weeks and the
  number is in the user-agent string, so a raw comparison would make every
  update look like an intruder; an address alone moves when a phone walks
  between two rooms and is shared by everybody in an office. Both together give
  one notice per network per browser, which somebody can recognise and an
  attacker cannot avoid without also being on their network.

  Read from the token rows rather than a table of known devices: a second table
  is one more thing to keep in step with revocation, and the rows already answer
  the question. A revoked session still counts as seen - revoking says "not
  now", not "I have never used that laptop".

  Inbox rather than email, and that is a decision rather than a first step. The
  inbox is the channel that works when mail is misconfigured, which on a
  self-hosted instance is most of them, and a security notice that depends on
  the subsystem operators most often skip is a security notice that does not
  exist.

  It cannot fail a sign-in. Everything runs after the session exists and every
  failure is swallowed, including the "is this new" query itself - which answers
  *known* when the database will not respond, because an instance that emails on
  every sign-in has taught somebody to ignore the one that mattered within a
  week. The wording deliberately avoids "suspicious": most of these are the
  person themselves on a new laptop, and language that starts by alarming them
  is language they stop reading.

### The database clock, and every "x ago" in the product

Found by noticing that a workflow run created seconds earlier said "7 hours ago", which is this
machine's offset from UTC. Reproduced exactly: a row inserted now reads back 7.00 hours in the past.

**The mechanism.** `created_at` is `timestamp` *without* time zone and defaults to
`CURRENT_TIMESTAMP`, which returns the session's **local** wall clock. Postgres here reports
`TimeZone: America/Los_Angeles`, so `CURRENT_TIMESTAMP` is `08:59:09-07`; storing that into a column
with no zone drops the offset and keeps `08:59:09`, and the driver reads a zoneless timestamp back
as UTC. The row is now seven hours in the past and nothing anywhere says so.

**The blast radius is smaller than it looks, and worse than it sounds.** Everything the application
writes is an ISO UTC string and round-trips exactly - measured, not assumed: `updated_at` written by
the app came back with 0.00 hours of skew in the same row whose `created_at` was 7.00 out. It is
only the columns the *database* fills in. Which is `created_at`, which is what almost every relative
time on every screen reads.

Nobody noticed because a server running UTC has no offset to lose. Any self-hoster on a machine set
to their own timezone gets every timestamp wrong by it.

- [x] `instance:check` and the health endpoint report it. `CURRENT_TIMESTAMP::timestamp` is exactly
      what a defaulted column stores - the cast drops the offset the same way the column type
      does - so comparing that against the process clock measures the bug directly, without writing
      anything and without depending on how old any row happens to be. Reading `SHOW timezone`
      instead would pass on a UTC database whose columns are still the wrong type, and fail on a
      correctly-typed one that happens to sit in Berlin.

      **Degraded, not failed.** Only a failed check takes an instance out of rotation, and an
      instance whose clock is skewed is still serving a working forge - refusing traffic over a
      display bug would turn it into an outage. The policy is tested rather than the probe, because
      breaking the database of the server the suite runs against takes the suite with it.
- [x] Fixed upstream, and **not** the way it looked. `timestamptz` was the obvious answer and is
      wrong here: Stacks stores *naive UTC* - a zoneless column holding UTC wall clock - because
      MySQL has nothing equivalent and one convention across drivers is worth more than the best
      type on each. Changing the type broke five tests that exist to say exactly that, which is how
      the convention got read rather than guessed at.

      The bug was the **default**. `DEFAULT CURRENT_TIMESTAMP` is the session's local wall clock on
      Postgres and MySQL, so the one value the database supplies for itself disagreed with every
      value the ORM writes. `@stacksjs/database` now has `utcNow` - `(now() AT TIME ZONE 'utc')`,
      `UTC_TIMESTAMP`, and SQLite's `CURRENT_TIMESTAMP`, which was already UTC - and its own tables
      use it, with a test asserting no `DEFAULT CURRENT_TIMESTAMP` survives.

      It reaches this instance on the next `@stacksjs/database` release, and only for tables created
      after it: existing rows keep the values they have. The health check above is what says whether
      a given instance is affected.

## Developer environment

- [x] Pantry auto-activation under the `den` shell. den now runs `chpwd`, `chpwd_functions`,
      `precmd`, `precmd_functions` and `PROMPT_COMMAND`, exports `$DEN_VERSION` so tools can detect
      it, and pantry generates a den-specific hook. Entering a project puts its dependencies on
      PATH; leaving it takes them off.
- [x] Speed up den's per-command dispatch.

      **There was nothing to speed up. Every number in this box was measured against a Debug
      build**, and `zig build` defaults to Debug, so that is what a checkout produces and what the
      shell here was running - the login shell was a symlink straight into `zig-out/bin/`.

      Same machine, same commands, 5000 iterations each:

      | | Debug | ReleaseFast |
      |---|---|---|
      | `[ -n x ]` | ~9.6ms | ~34µs |
      | `cd /tmp` | ~5.7ms | ~42µs |

      That is the "microseconds in bash" this box was asking for, and it explains the shape that
      made it look like a dispatch problem: `:` and `true` were cheap because they do almost no
      work, while anything allocating paid the debug allocator on every allocation. The same
      allocator is what prints leak traces to stderr mid-session, which is separately how the
      `if`/`case` bug in this section got reported as a crash.

      Fixed on the install side rather than in the build: den is built `-Doptimize=ReleaseFast` and
      **copied** to `~/.local/bin/den` instead of symlinked into the build output, so an ordinary
      `zig build` in the checkout can no longer swap the login shell under you. Making ReleaseFast
      the build default was tried and reverted: all 50 test artifacts share that setting, and
      running the suite without Zig's safety checks costs more than it saves.

      The pantry hook's design still stands. Keeping shell-side work out of it was right for its
      own reasons, and is why the hook never showed up in these measurements.
- [x] den's `eval` carries function definitions, so `eval "$(tool init)"` - how almost every shell
      integration is loaded - works.

      Two bugs stacked, and the first one is why the second was never reached. A line that merely
      *contained* `()` was taken for a function definition, so `eval "hi() { echo hi; }"` was read
      as defining a function called `eval "hi` and **eval never ran at all**. Fixed by asking
      whether the text before the parens is one valid name, in the four places that each had their
      own copy of the test. Underneath that, `eval` really did parse its argument as a single
      command chain; it now runs it as shell input through the same path `source` uses, which is
      also what POSIX describes.

      Verified with the real shape rather than a toy: a script printing two function definitions,
      loaded with `eval "$(faketool init)"`, then called.
- [x] den mis-parses a long quoted assignment when the file is `source`d: the first word of the
      value runs as a command.

      Does not reproduce - fixed by earlier work on den rather than by anything here. Checked with
      a long value whose first word is a real command (`HOOK="echo this-should-not-run; ..."`) and
      with a long `export` of a PATH-like string: both survive `source` intact and neither runs.
      Ticked on that evidence rather than on the absence of a report.
- [x] den crashes on a multi-line `if` or `case` inside a function body in a sourced file.

      **It never crashed, and the description hid two real bugs behind a wrong word.** What looked
      like a crash was the debug allocator printing a leak with a stack trace, on stderr, after the
      function had already run correctly: the function path parsed `if`/`while`/`until`/`for`/`case`
      and never freed the parse, where the top-level path had always freed it. Five missing
      `defer`s.

      Behind that was the one that mattered, and it was silent. A control-flow operand inside a
      function body is expanded by a different path than a command's arguments, and that path saw
      only the environment - so `$1` had nothing to resolve to, `case "$1"` matched the empty
      string, and the branch taken was `*`. A function dispatching on its first argument quietly
      did the wrong thing. Sourcing had nothing to do with either; both reproduce from `-c`.

      Both fixed upstream with regression tests. One-line function bodies through `-c` and through
      a script file argument are still wrong in a separate way - the function is defined with an
      empty body - which is noted here rather than fixed, because it is not what this box was for.
- [x] Raise the bun floor in `config/deps.ts` back to `^1.3.14` once a ts-pantry release carries
      the newer versions.

  Done and verified rather than assumed: ts-pantry is at 0.11.21, whose generated
  version union reaches 1.3.19, and `config/deps.ts` carries `^1.3.14` with the
  comment explaining why it was ever held back. `buddy typecheck` is clean on it.
- [x] A `main` tag in the bun-query-builder repository shadows the `main` branch, so `git push origin
      main` is ambiguous there. Delete the tag.

  Gone. `git ls-remote --tags` finds no `refs/tags/main` there any more, so the
  ambiguity is resolved upstream. Checked rather than taken on trust, because a
  roadmap line about somebody else's repository is exactly the kind that stays
  ticked-open long after the thing was fixed.
- [x] Seed data that produces a believable instance: several users, organizations, repositories with
      real history, open pull requests with reviews in progress

  `buddy seed:demo --instance`. The flag is off by default because the
  single-repository seed is what somebody demonstrating the review screen wants
  and it takes a second; this one is for developing *against* - the review
  queue, the organization pages, the stack view - and none of those are worth
  looking at with one repository in them.

  Four people, which is the smallest cast that produces every state at once: an
  author, a reviewer who has asked for a change, one who has approved, and one
  who has been asked and has not answered. Three cannot show all four and five
  adds nothing a page renders differently. One owner and three members, because
  an organization where everybody is an owner demonstrates nothing about
  permissions and permissions are half of what an organization is.

  **The stack is a real stack.** The second branch is committed off the *first
  branch's* head rather than off main, which is the part a hand-written fixture
  always gets wrong - branch off main and the second pull request's diff
  contains the first one's change too, which is precisely the mess a stack
  exists to avoid and precisely what the fixture would then be demonstrating.

  Two things it cost. The seeded accounts need a password, because the column is
  not null - and the first version hashed it with a helper that does not exist,
  fell into a catch, and produced four accounts that looked right and could not
  sign in. It hashes the way `RegisterAction` does now, and re-running the seed
  repairs an account left behind by the broken version - but only where the
  email matches the cast exactly, so a developer whose own account happens to be
  called `ada` does not get their password reset by a demo command.
