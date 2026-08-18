# 16 - Single-node hardening

Before anything scales out, the one box has to stop being killable by one large repository. This
phase was written after reading Cursor's
[Git at any scale](https://cursor.com/blog/git-at-any-scale) and then auditing this codebase for
the failure modes that post takes for granted are already handled: unbounded buffers, missing
backpressure, uncoordinated maintenance, and processes nobody counts. Phases 17 and 18 build the
scale-out story; this phase makes the current architecture survive the load it already accepts.

The audit found the streaming diff path is the part that was built right: `diffStream.ts` sets
`utf8` encoding, caps stderr at 64KB, applies real backpressure with for-await, and kills git when
the reader walks away. `DiffManifestAction` pulls one record per `pull()`. Everything in this phase
is spreading that discipline to the code that predates it.

Nothing here changes the storage layout, and nothing here touches wire-protocol argument handling,
which is the historically dangerous area (see "Ask which one, not whether it worked" in the
[index](./index.md)). The milestones are ordered by severity times cheapness, and each one ships on
its own.

## M0 - Correctness bugs that look like scalability bugs

Four bugs that read as "it falls over under load" and are actually just wrong.

- [x] Fix the mirror import clone. `app/Jobs/ImportRepositoryJob.ts` routes `git clone --mirror`
      through `runGit`, which prepends `--git-dir <parent>` - exactly what the doc comment on
      `cloneBare` (`app/Actions/Git/git.ts`) says must never be done for a clone - and it inherits
      the default 30 second timeout, so any non-trivial import is SIGKILLed and the half-written
      directory removed. Add a `mirrorClone(from, to)` helper next to `cloneBare` with its own
      spawn shape, a long timeout (the mirror fetch path already uses 15 minutes), and stderr
      capped at 64KB. Keep the remove-on-failure cleanup. `app/Commands/ImportGit.ts` had the
      same bug and now uses the same helper.
- [x] Test the clone fix: mirror-clone a local fixture repository, assert refs and tags arrive,
      assert a failed clone leaves no directory, and assert the argv never contains `--git-dir`
      (`tests/unit/mirror-clone.test.ts`).
- [x] Drop `--prune=now` from repository maintenance. `RepositoryMaintenanceJob` runs
      `git gc --prune=now` with no coordination against in-flight pushes, and its comment claiming
      nothing can hold a reference to an unreachable object is wrong for a push sitting between
      quarantine merge and ref update. Plain `git gc` keeps the two-week mtime grace period, which
      is the coordination mechanism. Rewrite the comment to say so, and extract the argument list
      into a pure function so a test can assert it without spawning git (`packArguments` in
      `app/Actions/Repo/retention.ts`).
- [x] Stop running the push pipeline inline. `QUEUE_DRIVER` defaults to `sync`, so
      `ProcessPushJob` runs inside the post-receive request unless someone sets it. Document
      `QUEUE_DRIVER=database` in `.env.example` and `docs/self-hosting.md` as the deployment
      default.
- [x] Reconcile the stale compose file with reality. `compose.yaml` ships Meilisearch and sets a
      `SEARCH_HOST` variable nothing reads, while `config/search-engine.ts` is deliberately
      Typesense - so a compose deployment has no working search at all. Brought to parity:
      Typesense with the `TYPESENSE_*` variables the config reads, and a header saying the
      canonical path is pantry (see M6) with this file as the kept-at-parity convenience.

## M1 - Bounded runGit

`runGit` buffers stdout into a JavaScript string with no byte cap - the only bound is the timeout,
and a fast git fills memory long before a slow one hits it. Every unbounded caller is one large
repository away from taking the process down.

- [x] Add a `maxBytes` option to `runGit` (default 10 MiB). Track accumulated length, SIGKILL the
      child on breach, resolve with `truncated: true` on the result. Early kill, never
      slice-after-allocation. `ok` stays true on a breach: the caller asked for at most that much
      and got it, and a budget read as failure would make every bounded caller drop the bytes it
      budgeted for.
- [x] Set `utf8` encoding on stdout and stderr in `runGit`. Today each 64KB chunk is coerced to a
      string independently, so a multibyte character spanning a chunk boundary becomes replacement
      characters. `diffStream.ts` is the precedent.
- [x] Cap stderr at 64KB unconditionally, same rationale and same constant as `diffStream.ts`.
- [x] Secret scanning (`app/Actions/Git/scan.ts`): pass the existing 4 MiB `SCAN_BYTE_LIMIT` as
      `maxBytes` instead of buffering the whole `git log --patch` and slicing afterwards. This is
      on the push path, so it is the highest-value single cap.
- [x] Code search (`app/Actions/Browse/SearchCodeAction.ts` and `search.ts`): add per-file
      `--max-count` to the grep arguments and a 2 MiB `maxBytes`; today `MAX_RESULTS` trims the
      string after git has printed everything it could in ten seconds.
- [x] `MeasureLanguagesJob`: a finite budget on the full `ls-tree -r --long` (the comment already
      claims the output is bounded; make the claim true - the `runGit` default 10 MiB cap is now
      real, and the comment says what a cut means for a percentage breakdown).
- [x] `app/Actions/Browse/load.ts`: budgets on `listTree` and on the compare path's `--numstat`
      and `--name-status` calls, with a `truncated` flag surfaced so views can say a listing was
      cut rather than silently rendering a partial answer. A cut `-z` record is trimmed to the
      last complete one, because a clipped filename parses as a real entry by the wrong name.
- [x] `app/Actions/Pull/load.ts`: budgets on `changedPathsFor` and `commitsOnBranch`, with any
      partial trailing line dropped rather than returned clipped.
- [x] Tests: a fixture blob larger than a small `maxBytes` override resolves promptly with
      `truncated: true` and no zombie child; a file of tens of thousands of multibyte characters
      round-trips through `runGit` with no replacement characters
      (`tests/unit/run-git-bounded.test.ts`).

## M2 - The SSR pull request page stops loading whole patches

The API diff path streams with an 8 MiB rendered-rows budget and pathspec-based refetch. The
server-rendered pull request page does not: it calls `pullRequestDiff`, which is `runGit` returning
the entire patch as one string, then parses all of it, then runs cross-file move detection over the
result. This is the main way a large diff kills the box, and the bounded infrastructure it should
use already exists.

- [x] Rebuild `pullRequestDiff` and `commitDiff` (`app/Actions/Pull/load.ts`) on
      `streamMergeBaseDiff` / `streamCommitDiff`, consuming the iterable under a byte budget
      matching the streamed path's 8 MiB, cancelling on breach, returning
      `{ text, truncated }`. `diffStream.ts` learned `ignoreWhitespace` so the whitespace
      preference survives the move rather than being dropped as a casualty of it.
- [x] When truncated, the pull request page renders a banner naming the size and linking the
      reader to the virtualized diff view, which handles arbitrary sizes by design. Both the
      whole-diff and commit-by-commit modes have one.
- [x] Tests: a diff larger than a small test budget returns truncated and well-formed partial
      text; a normal diff is byte-identical to the old output
      (`tests/unit/pull-diff-bounded.test.ts`, asserting against the old argv run buffered).

## M3 - A ceiling on concurrent git processes

There is no limit on how many git processes this app will spawn - the only backpressure is a
throttle on three wire-protocol routes, counted per credential. Clone storms are phase 15's normal
operating condition, and `upload-pack` is the most expensive thing this server runs.

- [x] A counting semaphore (`app/Actions/Git/semaphore.ts`) with three classes and env-tunable
      limits: `interactive` (default for `runGit`, ~32), `heavy` (upload-pack, receive-pack,
      archive, ~8), `background` (gc, languages, scans, imports, ~4). FIFO, with an acquire
      timeout (`GIT_SEMAPHORE_INTERACTIVE` / `_HEAVY` / `_BACKGROUND` / `_ACQUIRE_MS`).
- [x] `runGit` acquires its class before spawning; a `spawnGitLimited` wrapper does the same for
      the streaming spawns. Wire-protocol saturation answers 503 with `Retry-After`, which git
      clients honor politely. The diff stream builders went async for it (seven call sites); the
      SSH transport holds a `heavy` slot too, refusing on the channel where HTTP answers 503.
- [x] Keep the classes structurally deadlock-free: a holder of one class must never acquire the
      same class again while holding it. The audit found no nested `runGit` today; the rule keeps
      it that way, is written on the semaphore, and `RawFileAction`'s two sequential spawns note
      why they are sequential.
- [x] Tests: limits honored per class, FIFO order, release on rejection, and a saturated
      wire-protocol request answering 503 (`tests/unit/git-semaphore.test.ts`, and the 503
      through the real route in `tests/e2e/git-http.test.ts`).

## M4 - Backpressure on every stream

Three response streams enqueue every chunk the moment git produces it, so a slow client downloading
a multi-gigabyte archive buffers the whole difference in process memory. The stdin side has the
mirror image: `child.stdin.write()` return values are ignored, so a push arriving faster than git
indexes it buffers unboundedly.

- [x] A shared pull-based `stdoutStream(child)` helper - one chunk per `pull()`, kill on
      `cancel()` - replacing the `start()` plus `on('data')` bodies in the wire-protocol
      `streamService` (`routes/git.ts`), `ArchiveAction`, and `RawFileAction`.
- [x] The receive-pack pump awaits `drain` when `write()` returns false. Verified real on this
      runtime: a 100MB write against a child that sleeps three seconds before reading was held to
      the child's pace, `write()` answering false throughout, RSS flat.
- [x] The SSH path (`app/Actions/Git/ssh.ts`) does the same, pausing the channel if the library
      exposes it, else buffering under a hard watermark and terminating on breach. ts-ssh exposes
      no pause, so it is the watermark: 32 MiB on `stdin.writableLength`, terminate with a message.
- [x] Tests: a fake child proves one-chunk-per-pull and kill-on-cancel
      (`tests/unit/git-stream.test.ts`); existing smart HTTP and download suites confirm normal
      transfers unchanged. The manual memory check is the next box's story.
- [ ] **The download direction needs a Bun fix, and until it lands the memory-flat guarantee is
      structural rather than actual.** Measured on Bun 1.3.14 while closing the boxes above: the
      runtime drains a spawned child's stdout into process memory eagerly no matter how slowly the
      consumer reads - a 50MB writer finished in one second against a paused reader, the buffered
      bytes invisible to `readableLength`, and the same through `pause()`, the async iterator, and
      `Bun.spawn`'s native stream. On Node the same code blocks the child at the pipe. The write
      direction is honest (that is why the two boxes above could tick). So every pull-based stream
      here bounds parsing and delivery but not the runtime's own buffer, and `diffStream.ts` has
      carried the same latent gap since it was written. Adjacent, not identical, upstream reports:
      oven-sh/bun#18239 (stdin buffered whole), #14693, #5319. The fix is a Bun issue plus a
      regression test here when it lands; a FIFO-per-request detour was considered and rejected as
      exactly the workaround-that-hides-the-bug this codebase refuses.

## M5 - More than one process on one host

Everything multi-process-unsafe today is config, not architecture: the cache driver is in-process
memory, so pull request presence dies with the process; the websocket broadcast is single-node; the
queue is fine (database driver) once M0 makes it the default. The framework already carries Redis
support in all three configs, unused.

- [x] Declare `redis.io` or `valkey.io` in `config/deps.ts` as an optional pantry-managed service
      (both are in pantry's package set; record the pick and why). Memory stays the zero-dependency
      default. The pick is valkey: Redis 7.4 moved to RSALv2/SSPL, neither OSI-approved, and the
      BSD-3 fork is protocol-identical - the reasoning is on the declaration.
- [x] Env-switchable `CACHE_DRIVER` with the Redis connection settings plumbed through
      `config/cache.ts`. Presence in `LiveStateAction` already rides the cache facade and already
      degrades when the cache is gone, so it becomes cross-process with no code change. The
      connection reads the same `REDIS_*` variables the queue does, so it is configured once.
- [x] Document `BROADCAST_REDIS_ENABLED` as the requirement for running more than one app process,
      and a "running more than one process" section in `docs/self-hosting.md`: queue on database,
      cache on redis, broadcast on redis, all env-switched - plus the one thing that cannot move
      by env switch, the shared repository filesystem.

## M6 - Pantry everywhere

All system dependencies come from pantry, and where pantry cannot do something this deployment
needs, pantry gets extended rather than worked around - the same fix-the-tool rule as stx and
bun-query-builder. The CI runner already lives this way: job toolchains via `pantry env --install`
and job services via `pantry start` (`app/Actions/Runner/localExecutor.ts`). The rest of the
infrastructure converges on that pattern, and the container path stops being the deployment story.

- [ ] Complete the declared inventory in `config/deps.ts`: add `openssh` (mirror pushes over ssh
      remotes need a client; today only the Dockerfile installs one, and bare-metal installs get
      whatever the OS has). Every binary this app spawns - git, gpg, and what git itself invokes -
      traces to a pantry declaration.
- [ ] Fix `pantry install gnupg.org` upstream. On pantry 0.11.12 it reports 28 packages installed
      while installing nothing: no binary on PATH, nothing in `pantry list`. This is the documented
      blocker for the entire commit signature verification feature (`app/Actions/Git/verify.ts`
      names it, and `app/Actions/Keys/gpg.ts` spawns gpg directly for key imports). Check whether
      the 0.11.18 checkout already fixed it, upgrade the installed pantry, add a regression test
      upstream, then unblock the verify routes here.
- [ ] Fix `pantry start --port` upstream. The launchd agent it writes still runs the default port,
      documented as a known lie in `config/deps.ts`, and per-project Typesense depends on it.
- [ ] Extend pantry to manage project-level processes as services: the app server and the queue
      worker as KeepAlive launchd/systemd agents, the same mechanism pantry already uses for
      Postgres and Typesense. A production box becomes pantry plus a `.env`, with no container
      runtime required.
- [ ] Production provisioning follows the same line: ts-cloud provisions the box
      (`config/cloud.ts` already targets Hetzner server mode), pantry installs every system
      dependency and runs every service. The Dockerfile's `apt-get install git ca-certificates
      openssh-client` duplication goes away when the compose path is demoted (M0).
