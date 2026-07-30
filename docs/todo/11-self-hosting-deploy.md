# 11 - Self-hosting and operations

Running this in production, including running it badly and recovering. Self-hosting is the product
promise, so the operational story is a feature and not an afterthought.

## Deployment

- [ ] Dockerfile that builds and runs the application, and a compose file bringing up Postgres,
      Meilisearch, and the queue worker alongside it
- [ ] Persist repositories and uploads on volumes, and document exactly which paths hold state
- [ ] Health endpoint that checks the database, the queue, and repository storage, rather than only
      returning 200
- [ ] Graceful shutdown: finish in-flight requests, stop accepting new jobs, let running jobs
      complete
- [ ] Run the queue worker as its own process, with its concurrency documented
- [ ] Deployment to a single host, which is what most instances will be
- [ ] Sizing guidance from measurement, not guesses

## Configuration

- [ ] Every environment variable documented with its default and its effect
- [ ] Validate configuration at boot and fail loudly on a bad value, rather than at first use
- [ ] Secrets from the environment or a file, never committed
- [ ] Instance settings that do not warrant a redeploy live in the database and are editable by an
      admin

## Backup and restore

- [ ] Documented backup of Postgres and `storage/repos` together, since a restore needs both from
      the same moment
- [ ] Restore procedure, written after actually performing one on a copy. An untested restore
      procedure is a hope, not a backup.
- [ ] Repository consistency check after restore
- [ ] Retention and offsite guidance

## Operations

- [ ] Structured logs with request ids that follow a request into its jobs
- [ ] Metrics: request rate and latency, queue depth and job durations, git operation timings,
      database pool usage
- [ ] Error reporting hookable to an external service, off by default
- [ ] Admin area: instance stats, user administration, repository administration, queue inspection,
      failed job retry
- [ ] Rate limiting on the API, on git operations, and on authentication attempts
- [ ] Upgrade path: run migrations, what to do when one fails, and how to roll back

## Security

- [ ] Security policy and a disclosure address
- [ ] Dependency scanning through buddy-bot
- [ ] CSRF on state-changing routes, and correct exemptions for token-authenticated API calls
- [ ] Session handling: rotation on privilege change, absolute and idle expiry, sessions listed and
      revocable by the user
- [ ] Audit log for administrative actions
- [ ] A pass with the `stacks-security-audit` skill before the first public instance

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
