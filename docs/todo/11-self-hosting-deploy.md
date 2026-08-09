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
- [ ] Deployment to a single host, which is what most instances will be
- [ ] Sizing guidance from measurement, not guesses

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
- [ ] Secrets from the environment or a file, never committed
- [ ] Instance settings that do not warrant a redeploy live in the database and are editable by an
      admin

## Backup and restore

- [x] Documented backup of Postgres and `storage/repos` together, since a restore needs both from
      the same moment

  With the commands, and with the sentence that makes it matter: a database restored to a point after
  the repository snapshot has pull requests whose commits are not on disk, and the other way round
  has commits nothing references. **Neither reports an error.** Stopping the two application
  containers for the length of the snapshot is what makes them the same moment.
- [ ] Restore procedure, written after actually performing one on a copy. An untested restore
      procedure is a hope, not a backup.

  The procedure is written down and the consistency check it ends with is built and tested. The box
  stays open on its own terms: nobody has yet run it end to end against a copy, and the whole point
  of the sentence is that writing one is not the same as having done one.
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
- [ ] Admin area: instance stats, user administration, repository administration, queue inspection,
      failed job retry
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
- [ ] Dependency scanning through buddy-bot
- [ ] CSRF on state-changing routes, and correct exemptions for token-authenticated API calls
- [ ] Session handling: rotation on privilege change, absolute and idle expiry, sessions listed and
      revocable by the user
- [ ] A pass with the `stacks-security-audit` skill before the first public instance

### The audit log

One log, not a per-feature afterthought, because the question it answers is asked after something has
already gone wrong and there is no second chance to have recorded it.

- [ ] `app/Models/AuditEvent.ts`: `actor_id`, `access_token_id`, `action`, polymorphic subject,
      `organization_id`, `repository_id`, `ip`, `user_agent`, `metadata`, `created_at`
- [ ] Written by listeners on domain events, the same way the activity feed is, rather than by a
      call added to each action and forgotten in the next one
- [ ] Covers the things worth reconstructing: permission and role changes, token and key lifecycle,
      protected branch and rule changes, push protection bypasses, visibility changes, transfers and
      deletions, and administrative action
- [ ] Distinct from the activity feed. The feed is a product surface and hides what you cannot see;
      the audit log is a record and hides nothing from an owner.
- [ ] Append-only in the interface and in the API, exportable as JSON lines, and streamable to an
      external collector for instances that need retention beyond the database
- [ ] Searchable by actor, subject, repository and time range, and readable by organization owners
      for their own scope rather than only by an instance administrator

### Account security

- [ ] Two-factor authentication with TOTP and passkeys, recovery codes shown once, and an
      organization setting that requires it of members
- [ ] Single sign-on for self-hosted instances: OIDC first, since it covers most identity providers
      with far less surface than SAML, with group-to-team mapping and just-in-time provisioning
- [ ] Deprovisioning that actually revokes: removing someone upstream ends their sessions and their
      tokens' reach, rather than leaving a credential that outlives the account
- [ ] Sign-in notifications for a new device or location, and a visible list of active sessions

## Developer environment

- [x] Pantry auto-activation under the `den` shell. den now runs `chpwd`, `chpwd_functions`,
      `precmd`, `precmd_functions` and `PROMPT_COMMAND`, exports `$DEN_VERSION` so tools can detect
      it, and pantry generates a den-specific hook. Entering a project puts its dependencies on
      PATH; leaving it takes them off.
- [ ] Speed up den's per-command dispatch. A `[` test costs about 5ms and a function call about
      6ms, against microseconds in bash, which is why the den hook has to avoid shell-side work and
      let the binary walk the tree. A `cd` currently costs ~14ms inside a project and ~22ms outside,
      almost all of it that floor rather than the hook. `:` and `true` cost ~0.8ms, so the cost is
      specific to some commands rather than dispatch as a whole, and is worth profiling.
- [ ] den's `eval` parses its argument as a command chain, which has no representation for a
      function definition, so `eval "$(tool init)"` defines nothing and reports nothing. That is how
      almost every shell integration is loaded. The pantry hook is sourced from a file instead,
      which works, but `eval` should carry function definitions.
- [ ] den mis-parses a long quoted assignment when the file is `source`d: the first word of the
      value runs as a command. The current hook has no such line, so nothing is broken today.
- [ ] den crashes on a multi-line `if` or `case` inside a function body in a sourced file. The
      one-line forms work, which is what the pantry hook is written to, but the crash should not
      happen.
- [ ] Raise the bun floor in `config/deps.ts` back to `^1.3.14` once a ts-pantry release carries
      the newer versions. Its generated version union is a snapshot that stopped at 1.3.11, so the
      exact floor does not typecheck even though pantry installs 1.3.14. The fix is committed
      upstream and needs a release.
- [ ] A `main` tag in the bun-query-builder repository shadows the `main` branch, so `git push origin
      main` is ambiguous there. Delete the tag.
- [ ] Seed data that produces a believable instance: several users, organizations, repositories with
      real history, open pull requests with reviews in progress
