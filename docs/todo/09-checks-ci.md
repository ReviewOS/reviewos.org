# 09 - Checks and CI

There are three separate products here, and they land in this order:

1. Accept commit statuses and check runs from CI systems that already exist.
2. Provide the workflow control plane: definitions, triggers, durable run state, APIs, logs, and
   provider-neutral runner dispatch.
3. Execute untrusted repository code, only after the isolation and secret boundaries have passed a
   security review.

The first two do not require this instance to run somebody else's code. A self-hosted runner or an
external execution provider can consume jobs from the control plane, which makes the useful review
surface available without quietly turning the web server into a shell service.

This phase is the machinery. [Phase 15](./15-pipelines.md) is the product it has to add up
to, written against Buildkite, and it holds the step model, the runner fleet, the run surface, and
test intelligence. Where the two touch, phase 9 wins on the state machine and the protocol and phase
15 wins on what the thing is called and what it looks like. The vocabulary table is in phase 15.

## What we are taking from Cloudflare

Cloudflare's August 2026 article,
[its CI Workflows announcement](https://blog.cloudflare.com/ci-workflows/),
is the reference for this expansion. The useful idea is not its choice of Workers, R2, Artifacts, or
Cloudflare-specific bindings. It is the separation between a durable workflow control plane and an
isolated execution plane, with the same run controllable through code, an API, a CLI, and a visual
interface.

ReviewOS should carry the product capabilities that transfer to a self-hosted forge:

- Push-triggered workflows with repository, branch, tag, and path filters
- Repository-owned workflows and owner-managed reusable workflows, able to run together
- An immutable workflow version and step graph attached to every run
- Sequential and parallel steps, conditional execution, retries, timeouts, and restart from a step
- Isolated jobs, dependency caches, artifacts, secrets, and explicit resource limits
- Step-by-step logs, attempts, inputs, outputs, timing, and a visual dependency graph
- Lifecycle APIs to create, inspect, pause, resume, cancel, retry, and send an event to a run
- Conditional preview and deployment steps after checks pass
- Opt-in repair agents that propose a fix on a branch without turning the failed run green

### Where they run the workflow, and where we have to

The paragraph that used to sit here left the code-first question open, with a condition attached: we
copy Cloudflare's composability only if a repository's workflow can be parsed, versioned, and
executed inside the isolation boundary, and only if an organization-wide workflow never has to
evaluate code from every repository it covers. That condition is answerable, and the answer decides
the architecture, so it is written down here rather than deferred again.

**Cloudflare can evaluate workflow code in their control plane because their control plane is a
Workers isolate.** Running untrusted code is what it is for. `CIWorkflow` is a Worker; it calls out
to sandboxes for the commands and orchestrates them with ordinary TypeScript, including `Promise.all`
as a barrier. That is why their authoring model can be a program rather than a document.

Ours is a Bun process holding the database, the session keys, and every bare repository on disk.
**Evaluating a repository's TypeScript inside it is not a tradeoff, it is the same class of bug as
[phase 2's `--git-dir`](./02-git-hosting.md), where a check passed against one repository while a
different one was handed over.** So the decision:

- [x] **The workflow program runs as a job, not in the control plane.** A code-first workflow is
      dispatched to a runner like any other untrusted work, holding a lease. Its `step()` calls are
      authenticated API calls back to the control plane, which schedules the real work and returns
      the result. The control plane never imports, transpiles, or evaluates repository code.
- [x] A static workflow document needs no orchestrator job at all: the graph is known before
      dispatch. The orchestrator exists only for definitions whose graph is decided at runtime.
- [x] Both forms normalize to the same `WorkflowRun` and step rows, so the interface, API, logs, and
      restart-from-step behave identically whichever way a workflow was written. If a screen can tell
      which authoring form produced a run, the normalization is wrong.
- [x] An organization-wide workflow runs as its own orchestrator with its own trust level, and the
      repositories it covers supply data, not code. This is the condition the old paragraph set, and
      it is the reason the orchestrator is per-run rather than per-repository.

      Both halves hold now that owner-wide workflows exist. The orchestrator is a job of the run, so
      an organization's program gets its own - per run, at the owner's trust level - rather than one
      shared with whatever the repository is doing. And the trust level is enforced where it can be:
      an owner-defined run is given the owner's secrets and none scoped to the repository or its
      environments, so what the repository supplies is a checkout, changed paths and metadata.

The authoring form exists: a `.ts` file in `.reviewos/workflows` whose triggers are declared in a
front matter block. `app/Actions/Workflow/program.ts` reads that block **as text** and translates it
into an ordinary workflow document with one job, so everything downstream - the parser, the version
rows, the trigger filters, the dispatch, the claim - is the code that already exists. The program
below the block is never parsed, imported, or evaluated on this side of the boundary; it is bytes on
their way to a machine, exactly like a `run:` script.

The front matter is not a convenience. A workflow's triggers have to be readable *before* it runs,
or the only way to find out whether a program wanted to run on this push is to run it - which is the
thing that must not happen. That is why the block is required and why a file without one is refused
with a sentence naming what is missing, rather than ignored.

On the runner, `app/Actions/Runner/orchestrate.ts` imports the file and drives it, and the executor
intercepts `reviewos/orchestrate@v1` the same way it intercepts `actions/cache`. A program that
suspends is `suspended`, not `failed`: it reports nothing and hands its machine back, because a
workflow waiting for an approval must not put a red cross on somebody's commit.

A program has two ways to ask for work, and the distinction is the normalization:

- **`job(name, spec)`** writes a `workflow_jobs` row with a `workflow_steps` row under it, queued
  immediately because there is no graph above it - what it waited for was the program, and the
  program has already decided by asking. A runner claims it through the ordinary claim and reports it
  through the ordinary report, so the run screen, the logs, the artifacts and restart-from-step are
  the ones that already exist. The spec vocabulary is deliberately the same as a step's - `run`,
  `uses`, `with`, `env`, `runs-on` - because the moment the two forms can express different things,
  the normalization is a promise nobody can keep.
- **`step(name, fn)`** is the glue a job would be absurd for: reading a file, deciding a list,
  shaping a value between two jobs. It runs in the program's own process and is journaled all the
  same.

The program **suspends while a job runs**, and `reportJob` wakes it when the job finishes - in the
report path rather than in a sweep, because the result is already in hand and waiting for the next
tick of a timer would add a minute to every step of every code-first workflow. A failed job resolves
the call as a failure the program can catch, rather than leaving it pending and hanging the run on
work that is already over.

`job_id` is keyed by the journal position rather than the name, because a loop calling
`job('publish', ...)` twelve times is twelve jobs, `needs:` and the API address a job by that key,
and naming cannot tell them apart.

### Durable execution

"Durable" is the load-bearing word in Cloudflare's announcement and it is not a synonym for
"retried". It means the run survives the death of whatever was executing it, resumes without
repeating completed work, and can be restarted from a named step hours later. Getting that from an
orchestrator that is itself a killable job requires a journal, and this is the Temporal and DBOS
pattern rather than something to invent.

- [x] Every `step()` call is journaled by the control plane with a deterministic sequence identity
      **before** the work is dispatched, and its result recorded when it completes. The journal, not
      the orchestrator's memory, is the run.
- [x] On restart the orchestrator replays: calls up to the journal head return their recorded results
      immediately without re-executing, and the first uncommitted call resumes real work. A run whose
      orchestrator was killed at step 40 does not repeat steps 1 to 39.
- [x] Determinism rules for orchestrator code, documented and enforced rather than requested: no
      wall-clock reads, no randomness, no direct network or filesystem access. Each has an injected
      equivalent that is journaled, so a replay sees the same values it saw the first time.

      Three layers, and the third was the one missing. **The types** hand the author a builder and
      nothing else, so most of the rule is not reachable. **`checkDeterminism`** reads the source and
      names what it found with the line and what to do instead. **And it now runs on the path a
      program actually takes to become a version**, not only in the CLI - which is what "enforced
      rather than requested" has to mean, because a check somebody has to remember to run is a
      request.

      Refused rather than warned. A clock read in a program is not a style problem: the graph
      differs between two builds of one commit, the replay asks the journal for a call it does not
      hold, and what follows is not a crash but a run that quietly did the wrong thing. The push
      fails with the line, which is the moment it is still cheap to fix.

      The injected equivalents were already there and are journaled like any other call: `now` and
      `random` are resolved by the control plane and recorded, so a replay sees the timestamp it saw
      the first time. Network and filesystem have no injected form on purpose - their equivalent is
      `step()`, which is journaled, runs on the machine, and shows on the run as something that
      happened.
- [x] A replay that diverges from the journal, a call arriving in a different order or with different
      arguments, **fails the run loudly and names the divergence**. Silent divergence is the failure
      mode of every durable-execution system, and this repository has a written history of exactly
      that shape of bug going unnoticed for months.
- [x] Sleeps and waits suspend the orchestrator and release its runner. A workflow waiting three days
      for an approval must not hold a lease for three days; the control plane wakes it by replay when
      the timer fires or the event arrives.
- [x] The orchestrator's credential is scoped to its own run: it can create steps, read its own
      outputs, and nothing else. It is not a repository token and cannot outlive the run.
- [x] An orchestrator that exceeds its own wall-time, step-count, or journal-size budget is
      terminated with a stated reason, so a runaway loop in a workflow file is bounded by the control
      plane rather than by whoever notices the bill
- [x] Tests: kill the orchestrator mid-run and assert no completed step re-executes; a non-deterministic
      workflow detected on replay; a sleep that outlives the runner that started it; a restart from a
      named step whose inputs changed; and two orchestrators for one run, where the second is refused.

The journal is built: `WorkflowJournalEntry`, `app/Actions/Workflow/journal.ts`, and the two halves
of a call, `POST /api/runner/orchestrator` and `POST /api/runner/orchestrator/result`. The client for
them is `app/Actions/Runner/orchestratorClient.ts`, which is what a workflow program actually calls.

All five test cases are covered. `tests/e2e/workflow-journal.test.ts` runs them against the real
table; `tests/unit/runner-orchestrator-client.test.ts` runs the same claims from the program's side,
against a journal in memory, because what a `try` around a failed step does on replay is not a
question about HTTP.

Two rules worth naming, because both are places the obvious implementation is wrong:

- **A sleep ends on the control plane's clock.** `record` ends a slept call whose time has come and
  answers `replay`, so a runner that woke early - or whose clock is minutes out - gets the same
  answer as one that woke on time.
- **A suspended run holds nothing, so something has to be watching it.** `sleeping` is a fourth job
  state because what resolves it is a clock, where `blocked` is resolved by the graph, `paused` by a
  person and `queued` by the next free machine - leaving it queued would let a runner claim a
  workflow that asked to wait three days, immediately. `WakeSleepingRuns` sweeps every minute and
  only requeues; whether the sleep is *over* stays in the journal, because two places deciding one
  thing eventually disagree. A wait on a **name** rather than a time is the same mechanism:
  `deliverEvent` resolves the call with the event's payload and requeues, so `await
  context.waitFor('approval')` returns who approved it.
- **Restart-from-step forgets rather than diverges.** `forgetFrom` deletes the named step and
  everything after it, which is the only reading of "restart from step 12" that does not replay step
  12. A person restarting a deploy against a new image is deliberately asking for different work, so
  it must not be refused as the drift that divergence detection exists to catch.

What is **not** built yet, so that the unticked boxes above say what they mean:

- **The orchestrator job.** The protocol and its client are complete; nothing dispatches a program
  that uses them yet. Until it does, the code-first authoring form does not exist and neither does
  the normalization between it and the static one.
- **Enforced determinism.** `now` and `random` are injected and journaled, so the rule is
  *followable*. Nothing stops a program calling `Date.now()` directly; that needs the execution
  boundary, which is the section this phase gates behind a security review.

### Step results are data

Cloudflare's dashboard shows per-step inputs, outputs, wall time, and CPU time, and that is what
makes restart-from-step meaningful rather than decorative: a step can only be skipped on restart if
its result was recorded as a value.

- [x] Steps record typed inputs and outputs as rows, not as text scraped from a log. A later step
      reading an earlier step's output is reading the database.
- [x] Wall time and active execution time are recorded separately per step, plus queue time. A step
      that took nine minutes of which eight were queueing is a different problem from one that took
      nine minutes of work, and one number cannot say which.
- [x] Cached and reused results are labelled as such in the interface and the API, with a link to the
      attempt that actually produced them

      `reused_from_attempt` on the step row, set by the restart that kept the result and carried
      forward across later ones - so a value produced on attempt one still says one after surviving
      attempts two and three. The run screen says "kept from attempt 1" and links to that attempt's
      log, which the log endpoint now serves: `readLog` had taken an attempt all along and nothing
      passed one, so the only readable log was the newest. A number nobody can trace is worse than
      no number.
- [x] Tests: a restart reusing outputs, a restart refusing to reuse them because the workflow version
      changed, and an output too large for the value store handled explicitly rather than truncated

      `tests/e2e/workflow-restart-step.test.ts`, against the real tables and the real endpoint. The
      third case is where the column had to grow a distinction: a database has one way to say empty,
      and "this step produced no outputs" and "this step's answer was lost" are opposite answers to
      whether it may be skipped. The dropped value is a marker, so it survives the round trip the
      missing value does not, and `recordedOutputs` is the one place that reads the difference.

`WorkflowStep` now carries `outputs`, `queued_ms` and `active_ms`, and a runner sends all three with
its conclusion - one report rather than a request per step, because nothing reads a step's recorded
result until its job is over. Wall time is `finished_at` minus `started_at` and is deliberately
**not** stored: a third number that is the subtraction of two others is a number that can disagree
with them. `queued_ms` is the gap after the step before it, which for the first step is everything
the runner did to get ready - the checkout, the cache restore, the container pull - and leaving that
out of every number is how a job that takes nine minutes reports four. `active_ms` is timed around
the command alone, so a step whose command took two seconds inside a forty-second iteration reads as
the setup problem it is.

Every write is guarded to the reporting job's own steps. The runner chooses the positions, and a
position is the one thing in that payload it could get wrong or lie about.

Dispatch now copies a definition's steps onto every job it creates, which is what gives those results
somewhere to land. Before that a run had no step rows at all - the claim read the version tables
directly, which works right up until somebody asks what a step *did*, and then there is nowhere to
write the answer. Copied rather than referenced, following the rule the job row already follows for
`fail_fast` and `needs`: a finished run has to stay readable after its workflow file is edited or
deleted.

Step positions are **zero-based everywhere**, because `job.steps.entries()` is what numbered them
when the workflow was stored. The report path briefly counted from one, which would have landed every
result one row away from the step that produced it - caught by a test that found no row rather than
by a test that found the wrong one, which is the luckier of the two ways to notice.

`ClaimJobAction` still falls back to the version tables when a job has no rows of its own. That is a
ramp for runs dispatched before this change, not a design, and it should go once no such run can be
claimed - two answers to "what does this job run" is one more than there should be.

An output too large for the store is now **dropped with a marker rather than truncated**, which is
the third of the test cases above. Truncating looks like it works: the row holds a string, the screen
shows a string, and the job reading `needs.build.outputs.manifest` gets a JSON document with no
closing brace and fails somewhere else entirely, on a line with nothing to do with the cause. The
marker says the size and where the value belongs instead. Measured in bytes, because a limit counted
in characters lets a value of CJK text through at three times the size the column was sized for.

The decision half of restart-reuse is written and tested: `app/Actions/Workflow/reuse.ts` says which
recorded results a restart keeps. Pure, like `rerunPlan` beside it, because it is the part people
will argue about and an argument settled by reading a test is shorter than one settled by running a
build twice.

The rule is that a result survives when **the step is unchanged, every step before it is unchanged,
and it succeeded**. The middle clause is the one that gets forgotten and the one that makes this
safe: a step reads the workspace its predecessors left behind, so reusing step 7's output after step
3 was edited hands a later job a value produced from a world that no longer exists. So the walk stops
at the first step it cannot keep - a set of reusable steps with a hole in it is not a set of reusable
steps.

Two smaller decisions worth knowing: a **renamed** step is the same step, since refusing to reuse it
would re-run a twenty-minute build because a label got clearer; and a step whose result was **lost**
- reported by a runner too old to send it, or dropped for being too large - is re-run rather than
skipped with nothing, because skipping would hand later steps an empty value they would read as the
answer.

What remains is the wiring, and it is the whole of both open boxes: `rerun.ts` plans at job
granularity, so nothing yet asks `reusePlan` what to skip, no `reused_from_step_id` links a kept
result to the attempt that produced it, and neither the interface nor the API says a result was
reused rather than produced.

### Snapshot caching

Their dependency cache is a snapshot of the workspace after `install`, restored into later steps,
rather than a keyed archive of a named directory. It is the better primitive for the common case,
because it needs no author to know which paths a package manager writes to.

Built. `cacheScope.ts` decides who may read and write, `cacheKey.ts` derives the key, `cache.ts`
and `WorkflowCacheEntry` store it through the phase 18 blob store, two runner endpoints carry it,
and `snapshot.ts` with `cacheClient.ts` make and unpack the archive. The restore happens after the
checkout and before the first step; the save happens at the end of a job that succeeded and whose
restore was not an exact hit. `cacheCollect.ts` and `buddy ci:caches` are the collection half.

One difference from the wording below: the snapshot is taken per **job**, not per step. Steps of a
job already share a workspace, so a per-step snapshot would store the same tree several times to
answer a question - "what did this step leave behind" - that nothing asks. Across jobs, which is
where the sharing actually happens, this is exactly what the line describes.

- [x] Snapshot a step's workspace on completion, content-addressed, and restore it as the starting
      state of dependent steps
- [x] The snapshot key is derived from declared inputs (lockfile digest, runtime version,
      architecture, image), so a lockfile change invalidates it without anyone maintaining a key
      expression
- [x] Keyed path caching also exists, because `actions/cache` is what a migrating workflow already
      uses and it must keep working
- [x] Cache restore permissions prevent a fork or a lower-trust branch from writing a snapshot a
      protected branch would restore. This is listed in the execution-plane section too, and it is
      the one cache property that is a security boundary rather than an optimization.
- [x] Snapshots are garbage collected by size and age with the policy visible before it deletes
      anything
- [x] Tests: a snapshot restored into a parallel fan-out, an invalidated key, a poisoning attempt
      from a fork, and a restore whose base image no longer exists

## Commit status and checks API

This much makes ReviewOS usable with any existing CI. Ship it independently of the workflow engine.

- [x] `app/Models/CommitStatus.ts`: `repository_id`, `sha`, `context`, `state` (pending, success,
      failure, error), `target_url`, `description`, `creator_id`

  Both APIs exist because dropping either costs adoption: a forge that accepts
  only check runs cannot be used with the twenty-year-old script somebody has
  posting statuses, and one that accepts only statuses cannot show a failing
  line in a diff. `error` stays distinct from `failure` - a failure is "your
  code is wrong" and an error is "the check could not run", which look the same
  on a dot and mean opposite things to whoever has to act.

  Appended rather than updated, so "did this always pass, or did somebody re-run
  it until it did" stays a question the history can answer.
- [x] `app/Models/CheckRun.ts`: one named run against a commit, with queued, in-progress, and
      completed states, conclusions, timestamps, a details URL, and a summary
- [x] Extend check runs with the reporter, a provider and external run id, an idempotency key,
      output title and text, and stable ordering for repeated attempts

  The idempotency key is unique **in the database** rather than checked before
  inserting: two workers retrying at the same moment both find nothing and both
  insert, and the second run sits `queued` forever blocking a merge on a check
  that no longer exists anywhere.

  `attempt` is what "latest" means for a re-run. Ordering by id would usually
  agree and would stop agreeing exactly when two systems report out of order,
  which is when somebody is already confused.
- [x] `app/Models/CheckAnnotation.ts`: one row per file and line range with level, title, message,
      and optional raw details. Annotations are relations, not a JSON array on the run.

  Rows, and the reason is worth stating: annotations are queried by file and
  line when a diff renders, so a JSON column means loading every annotation of
  every check on the commit to find the three on the file somebody is looking
  at - with no index, no partial update, and no way to count them without
  parsing.

  `side` is on the row because a check can be about a deleted line: coverage on
  removed code, or a linter complaining about what a change took away. Forced
  onto the right, that annotation lands on an unrelated line of the new file.
- [x] `app/Actions/Checks/CreateStatusAction.ts`, `CreateCheckRunAction.ts`, and
      `UpdateCheckRunAction.ts`, with field-level validation and stable error codes

  One action rather than three, and that is a deliberate departure from the line
  above. A reporter has one question - "here is my verdict" - and three
  endpoints means three places the permission check, the idempotency and the
  out-of-order rules have to be right. Create and update are the same call
  keyed on the idempotency key or the run id, which is also what a reporter
  that lost our id needs.
- [x] `GET` endpoints for statuses and check runs by commit, and by pull request head, returning the
      latest attempt per name plus the combined state

  By number as well as by sha, because somebody asking "can this merge" knows
  the pull request and not its head. Doing it in two requests has a race: the
  head can move between them and the caller gets checks for a commit that is no
  longer the head without being told. The response names the sha it answered
  about, so a client can tell "green" from "green for a commit somebody has
  already replaced".
- [x] Statuses roll up per commit and per pull request head. A failed check wins, an unfinished check
      is pending, and a commit with no reports is neutral rather than green.

  `app/Actions/Checks/rollup.ts`, pure and tested on its own, because this rule
  is what a merge button reads and it is expensive wrong in both directions.

  **Neutral rather than green is the one people get wrong.** A commit nothing
  has looked at is green in most forges, which means a repository whose CI is
  misconfigured looks exactly like one whose tests all pass - and the difference
  is noticed after something ships.

  Two more that are easy to get backwards: an unfinished run is pending whatever
  its conclusion field says, because a conclusion on a run that has not
  completed is a value nobody should be reading; and `cancelled` is not a pass,
  because nothing looked - a cancelled check counting as success is how a
  superseded run unblocks a commit nobody verified.
- [x] Fine-grained token permission for reporting checks, separate from permission to push code or
      administer a repository

  `check:report`, mapping to the `checks` scope. A CI token that could push is a
  CI token whose compromise is a supply chain incident, and CI credentials live
  in more places than any other an organization has. Asserted both ways: a token
  with the scope reports, a token with only `contents:read` is refused.
- [x] Idempotency on create and safe compare-and-update semantics so a late queued report cannot
      replace a completed attempt

  The transition is compared before it is applied. A `queued` arriving after a
  `completed` is a delivery that overtook itself, and applying it reopens a
  check that has already reported - blocking a merge that had passed, or
  unblocking one that had not, depending which way round.

  Answered with the row as it stands rather than an error, because from the
  reporter's side nothing is wrong: it sent what it had.
- [x] The check API is represented in generated OpenAPI, including request bodies, response bodies,
      error codes, pagination, and rate-limit headers

  The missing half was a framework gap, and it is filled upstream rather than
  worked around here. `@stacksjs/api` derived an operation's *inputs* from the
  action's `validations` - the same object the validator uses, so they cannot
  drift - and could derive nothing about its outputs, so all 704 paths in the
  document claimed a 200 of `{"type": "object"}` and knew of no failure but 422
  and 500. A client generated from that has no branch for the 404 a private
  repository answers, which is the one it meets first.

  Stacks 0.70.369 gives an action `responses` and `responseHeaders`, merged over
  those defaults rather than replacing them, and this repository uses them: the
  checks endpoints, the run list, the run, the job log and the cancel all
  document what they answer with, what they refuse with, and the
  `X-RateLimit-*` headers every throttled response carries. Rate limits are on
  the response rather than in it, so a document that omits them describes an API
  that appears to have no limits until a client meets one.

  Kept honest by two tests rather than by care. A unit test refuses a documented
  status with no sentence, an endpoint that forgets its 401 or 404, and a header
  name that is not one `app/Api/rate-limit.ts` actually sends - documenting a
  header the API does not send is worse than documenting nothing, because a
  client reads `undefined` and treats it as zero. And an end-to-end test asks
  the endpoint what it really answers with and compares that against what the
  action claims, which is the only way the prose stays true.

  Pagination is documented where it exists - the run list's cursor, and `next`
  being null on the last page rather than a cursor that returns nothing. The
  checks endpoints do not paginate: a commit's checks are a handful of rows, and
  the one unbounded list is capped with its true total beside the sample.

  The note that stood here said the missing half was "not ours to write". It
  was ours to write - one repository over, in
  `storage/framework/core/api/src/generate-openapi.ts`, which is where a fix
  helps every Stacks application rather than these two endpoints. Reaching for
  a workaround here would have left the document wrong for all 704 paths and
  right for six.
- [x] Required checks are enforced by protected branches and the merge action
- [x] Annotations render inline in the diff on the lines they refer to. An annotation shown only in
      a log is a link nobody clicks.

  `app/Actions/Pull/annotations.ts`, hung on the diff through an
  `annotationsAt` slot beside the one review threads already use - a separate
  slot rather than a shared one, because they are different things: a thread is
  a person talking and stays until somebody resolves it, an annotation is a fact
  a tool reported and disappears the next time the tool runs without it. They
  render in that order, the machine's finding first.

  The placement rule is the threads' rule, for the threads' reason: a right-side
  annotation matches the new line number and a left-side one matches the old,
  and matching on both prints a finding about a deleted line under the line that
  replaced it. A finding spanning five lines is placed once, on its last line -
  repeating it would turn one warning into five, and a reviewer counting them
  would get a number the tool never reported.

  Only annotations from runs against the current head are hung: one from a
  superseded run points at lines that may not exist any more.
- [x] Checks tab on a pull request: rollup, attempts, duration, details link, annotations, and the
      difference between missing, queued, running, failed, cancelled, and stale

  The tab existed and listed the *required* names only, so a repository with no
  branch rule was told "no checks are required on this branch" while six of them
  were reporting. It lists every check now, from both reporting APIs, through
  `app/Actions/Checks/panel.ts`.

  The distinctions are the point of the screen. Cancelled is not failed, though
  both block: telling somebody their check failed when a newer push cancelled it
  sends them to read a log that says nothing. A completed run with no conclusion
  says so rather than being read as anything. A required check that has never
  reported says *that*, because it is the case a branch rule exists for. And a
  report against an earlier commit is labelled with the commit it was about -
  every forge shows that tick somewhere, and the tick is about code nobody is
  merging.

  **The page and the merge button now compute the verdict the same way, and
  finding that out fixed a real one.** Required checks were matched against
  `check_runs` alone, so a repository whose CI posts *commit statuses* - the
  older API, and what most existing integrations use - waited forever on a check
  that had already reported, while the page said it had never reported at all.
  `statusAsRun` maps a status onto the same shape, and both merge actions read
  both tables.
- [x] Webhook events for status and check transitions, with redelivery through phase 5

  `check:reported` and `status:reported`, emitted from the reporting endpoint
  after the write. One event per transition rather than three, with `queued`,
  `in_progress` and `completed` travelling in `action`: a receiver that only
  wants finished checks reads one field, and a receiver that wants to know a
  build *started* would otherwise have to subscribe to an event that did not
  exist. It is what a deployment gate, a dashboard and a merge queue all wait
  on, and until now the only way to find out was to poll.

  The two reporting APIs stay separate events, because a check run carries
  attempts and output where a status carries neither, and a receiver that has to
  test for the presence of half a dozen keys to learn which kind arrived is one
  that gets it wrong. Both carry a `check` object with the name, the full sha,
  the status, the conclusion, the attempt and the details URL; `subject` stays
  the repository, so nothing routing on `subject.type` has to learn a fourth
  value.

  Webhook-only, deliberately: a repository with six checks and a busy morning
  would put a hundred entries in an inbox nobody would read afterwards.
  Redelivery, signing and the delivery log come from phase 5 unchanged. A
  backward transition - a `queued` that overtook a `completed` - is silent,
  because it changed nothing and a webhook saying a finished check is queued
  again would have a merge queue reopen a gate that had already closed.
- [x] Tests: a required check that never reports blocks the merge, and reporting late unblocks it
- [x] API tests: permission isolation, idempotent retry, out-of-order updates, pagination, a stale
      pull request head, and annotations on both sides of a diff

  `tests/e2e/checks-api.test.ts`. Permission isolation, the retried create, the
  report that overtakes itself, a completed run with no conclusion, a branch
  name where a sha belongs, annotations on both sides, and a re-run replacing
  its annotations rather than piling up - a reporter sends what it currently
  has, and merging into what is stored leaves a fixed error on the diff forever.

  Pagination is not covered because these endpoints do not paginate: a commit's
  checks are a handful of rows, and the one unbounded list - annotations - is
  capped per run with its true total reported beside the sample rather than the
  sample being passed off as everything.

  **And for a while none of it ran.** The scope vocabulary in
  `app/TokenScopes.ts` gained `checks`; the model behind the column did not, and
  the column is a Postgres enum generated from the model. So every attempt to
  grant the scope failed at the insert - which meant the two boxes above were
  true of code nobody had executed, and this file's suite caught the failure in
  its setup, set `available = false`, and reported fourteen passes.

  Fixed in three places, because one of them was the reporting: the model lists
  the scope, a unit test in `tests/unit/token-scopes.test.ts` fails if the
  vocabulary and the column ever disagree again, and `tests/setup.ts` repeats
  every suite's skip after the summary - with `TESTS_REQUIRE_ALL=1` turning it
  into a failure, which is what a machine with a database should run. A suite
  that skips itself and a suite that passes should not look the same.

## Workflow definitions and triggers

The workflow is a versioned resource, not whatever happens to be in the default branch when an old
run is inspected.

- [x] The authoring contract is **both**, and the decision is now made rather than pending.
      [Phase 15](./15-pipelines.md) makes GitHub Actions-compatible YAML canonical, because the
      ecosystem is the product and a format nobody can leave with is a format nobody adopts. The
      constrained TypeScript API is the second front door for graphs that are decided at runtime,
      and it runs as an orchestrator job under the rules above. Both normalize to the same rows.

      Built and shipped, both of them. A `.github/workflows/*.yml` file is the canonical form; a
      `.reviewos/workflows/*.ts` program declares its triggers in front matter, is translated to an
      ordinary document, and runs as an orchestrator job whose `step()` calls are journaled. The
      program below the front matter is never parsed or evaluated on this side of the boundary - it
      is bytes on their way to a machine, like a `run:` script.
- [x] Neither front door can express something the other cannot represent in the run. A capability
      reachable only from the SDK becomes a screen that renders differently depending on how a
      workflow was written, which is how two products grow inside one.

      Guaranteed by construction rather than by discipline: **the SDK emits YAML**. It does not
      produce rows, or a second document format, or a normalized graph of its own - it produces a
      file a person could have written by hand, which then meets the same parser, the same
      extension rules and the same refusals. So a capability the typed surface has and the file
      format does not is not something to guard against; it is something that cannot be built
      without noticing.

      `tests/unit/workflow-two-front-doors.test.ts` is what turns that from an argument into a
      check: every field the typed surface has, said at once, read back through the server's parser
      with no errors, and compared against the same graph written by hand. The dispatch inputs get
      their own case because they are the one part of a trigger that is validated later - a choice
      that lost its options in translation would become a dispatch that accepts anything.
- [x] `Workflow` and immutable `WorkflowVersion` models: owner, repository scope, source commit and
      path, content digest, trigger policy, state, and the normalized step graph

      Two models rather than one because a run points at a *version*, so inspecting a run from six
      months ago shows the workflow as it ran instead of whatever is in the default branch today.
      The content digest is what keeps that cheap: a push that does not touch the file produces the
      same digest and reuses the version, where per-commit versions would give a repository with a
      daily push a version a day, all identical.

      `repository_id` is nullable, because an owner-wide workflow carries no repository - that is
      the case the column exists for. It is still declared as a `belongsTo` purely for the cascade:
      without the relation the generator emits a bare `REFERENCES` with no `ON DELETE`, and then a
      repository that once had a workflow cannot be deleted at all.

      Regenerating after that change produced an `ALTER` rather than the tables, because
      `storage/framework/database/model-snapshot.postgres.json` had already recorded them from the
      first run. The snapshot is the generator's idea of the current schema, and deleting migration
      files does not move it - restoring it and regenerating gives the four `CREATE`s.
- [x] Normalize jobs, steps, dependencies, triggers, and input declarations into related rows. A
      workflow-sized JSON blob would make querying, authorization, and migrations harder.

      `WorkflowVersionJob` and `WorkflowVersionStep`, named apart from the run-side `WorkflowJob`
      and `WorkflowStep` further down this phase. The two pairs describe different things - what a
      job *would* be, and one that *happened* - and collapsing them is how a finished run starts
      showing steps it never executed.

      Triggers are columns on the version rather than the parsed YAML, because dispatch reads them
      on every push and a blob would mean parsing every workflow in the repository to find out
      whether any of them cared. `on_pull_request_target` is its own column for the reason given
      above: it is the same event with the opposite trust, and folding it into `on_pull_request`
      hides the dangerous one at the point where it is being decided.

      `command` and `uses` are inert text, and the model says so on the column rather than only in
      the parser - a column called `command` invites somebody downstream to be helpful with it.
- [x] Validate a definition without running it, returning errors with a file location and a concrete
      fix. Invalid workflow code must never reach a runner.

      `app/Actions/Workflow/parse.ts`. Source text in, a normalized graph or a list of errors out,
      and **nothing in it executes, resolves or fetches**: a `run:` body is a string going in and a
      string coming out, and `uses:` is a reference it records rather than goes and looks up. That
      is what makes it safe to run against a fork's pull request, which is the only way a forge can
      tell a contributor their workflow is broken instead of running it to find out.

      Every problem is reported in one pass rather than the first one thrown, because somebody
      fixing a workflow file wants the list - a validator that reveals one problem per push is one
      people work around by pushing. Errors carry a line and a fix: `runs_on` is reported as not a
      job key *and* as a missing runner, with "hyphenated, not camel case", because that is the
      typo, not a schema violation to look up.

      Line numbers are found textually rather than by carrying a second YAML parser for positions,
      and `lineOf` says so: a key repeated at two nesting levels can match the outer one, so it is a
      pointer into a file the author has open rather than a claim about the document tree.

      **Checked against this repository's own eight workflows, which is what caught the first
      version being wrong.** It rejected `pull_request_target` and `workflow_call` as unknown
      triggers - both valid Actions, one a reusable workflow that no event starts and the other the
      most security-sensitive trigger there is. Recognised is now the bar rather than dispatched: an
      event this instance does not run yet is recorded and the workflow stands, because refusing a
      valid file is exactly how the format stops being one a repository can arrive with. A
      misspelled event is still an error.

      `pull_request_target` is kept apart from `pull_request` in the normalized triggers rather than
      folded into it. It is the same event with the opposite trust - the workflow comes from the
      base branch and runs with the base repository's secrets against a fork's code - and that is
      the one fact the fork policy in [the threat model](../ci-threat-model.md) needs.
- [x] Triggers for push, pull request, tag, schedule, manual/API dispatch, and repository events,
      each with repository, ref, and path filters

      The push half is decided by `app/Actions/Workflow/triggers.ts`, over data the caller already
      has - a ref, the changed paths, the stored filters - so it touches neither git nor the
      database. Pull request, schedule and dispatch are recorded on the version and dispatch for
      them is not wired yet.

      Every rule here is one whose wrong answer is **silent**, which is why they are tested one at a
      time. A filter that matches too little produces no run, and a run that does not exist leaves
      nothing on screen: the bug arrives weeks later as "CI didn't run", from somebody who assumed
      they had configured it wrong.

      - `*` stops at a separator and `**` crosses one, so `docs/*` does not match `docs/api/x.md`.
        Getting that backwards is the most common CI filter bug and it fails towards skipping.
      - **No filter means every ref.** Reading an empty `branches:` as "matches nothing" would
        disable every workflow that never named one, which is most of them.
      - An empty *path filter* and an empty *change set* look alike and are opposites: the first is
        a workflow that does not filter by path, the second is a push that touched nothing it
        watches.
      - Tags are opted into. A workflow naming branches and not tags is asking for branches;
        the other reading sends every release tag through a workflow written for `main`.
      - An exclusion beats an inclusion, which is Actions' precedence.

      Where the changed paths are unknown and the workflow filters on them, it runs. A missed run on
      a push that did touch them is a broken product; an extra run on one that did not is a wasted
      minute - and it is *visible*, which the missed one never is.

      Every refusal carries a reason, for the same asymmetry: "no workflow matched this push" with
      no explanation is a support question this product would otherwise generate forever.
- [x] Push triggers consume the same `push:received` event emitted by phase 2. There is no second
      receive pipeline just for CI.

      `app/Listeners/SyncWorkflows.ts`, a fourth listener beside the ones that notify, deliver
      webhooks and record activity. **`push:received` had no listeners at all before this** - it was
      dispatched by `ProcessPushJob` and nobody was on the other end.

      Only the default branch. The definition comes from the trusted ref, so syncing from whatever
      branch happened to move would let anybody with push access to any branch replace the
      definitions the instance holds. It registers and starts nothing: the run models do not exist
      yet, and half-implementing dispatch is exactly where a missing run becomes invisible.

      Two things had to be found by running it rather than by reading it, and both fail the same
      silent way. Discovery scans `app/Listeners` for a default export of `{ listensTo, handle }` and
      **skips anything else** - a bare exported function registers nothing and looks identical to a
      listener that is wired and does nothing. And `repositories.disk_path` is not one shape:
      `mirror:add` stores an absolute path while the checkout path stores one relative to the
      repository root, so handing the column to git works for some repositories and finds nothing
      for others. Nothing for others, because a missing directory is also how git says "this commit
      has no `.github/workflows`", which is the ordinary answer. The owner and name are the source
      of truth now, as the diff actions already treat them.

      The end-to-end test polls rather than asserting immediately, because `dispatch` is
      fire-and-forget and must be: a push is answered when the refs move, not when everything
      downstream has finished thinking about it.
- [x] Owner-managed reusable workflows can target many repositories, while a repository may also
      define its own workflows. Both are visible in the resulting run.

      Both kinds go through one list in `currentVersions`, so the trigger filters, the dispatch, the
      run rows and the restart treat them identically - a push to a covered repository that also has
      its own file produces two runs, side by side in the same list, and nothing downstream knows
      which is which. A second code path would have been a second place for the trigger rules to be
      subtly wrong.
- [x] A workflow can be **owned entirely by the organization and carried by no repository at all**,
      matching every repository under an owner or a selector over them. Cloudflare gets this by
      omitting `repoName` from an event binding; the value is that a security scan or a licence check
      lands on two hundred repositories without two hundred commits, and cannot be removed by editing
      a file in one of them.

      `workflows.repository_id` is null and `selector` says who it covers. The selector syntax is
      the one this codebase already uses for branches - comma or newline separated patterns, `*` for
      any run of characters, a leading `!` to exclude - because a second pattern language is a
      second thing to be wrong about. `visibility:private` is the one term that is not a name, since
      "every private repository" is the second thing anybody asks for and naming them defeats the
      point.

      A selector is stored as written, so a repository created tomorrow is covered by the same rule
      rather than by a list somebody expanded once. An archived repository is covered by nothing -
      not a rule about selectors but a rule about archives, since a nightly scan that keeps starting
      runs on a finished repository is a promise broken by a feature that was not thinking about it.

      This is what `ownerTemplates.ts` cannot do and should not: a template writes a commit, and a
      commit is a thing the repository can revert.
- [x] Such a workflow declares what it needs from each repository it covers (checkout, changed paths,
      metadata) and gets nothing else. It runs at the owner's trust level over the repository's data,
      never at the repository's trust level, which is what makes it safe to give it a secret.

      **The trust inversion, enforced where the secrets are chosen.** An owner-defined run is given
      owner, instance and pool secrets and *none* scoped to the repository or to one of its
      environments. Without that rule a repository admin could declare a secret with the
      organization's key name and read whatever the licence scan was handed - which would make
      giving one a credential the opposite of safe.

      What it gets instead is the data: a checkout, the changed paths, the run metadata, and a job
      token that defaults to `contents: read` like every other workflow that declares nothing. An
      owner-wide workflow *may* ask for more, and that is the owner's call over repositories the
      owner administers; the direction that had to be closed is the repository granting itself
      something.

      The run screen says so, because everything else about such a run looks like a run of a file in
      this repository and there is no such file - so the first thing anybody does is go looking for
      it.
- [x] A typed event API can start a run directly, so a workflow is reachable from a webhook, another
      run, a scheduler, or an external system without a synthetic push

      Four ways in, none of them a fake push. `POST /repos/repository-dispatch` names an event type
      and a payload and nothing else - not the ref, not the workflow, not which repository the
      payload claims to be about - which is what makes it safe to hand to a program with a narrow
      token. `on: workflow_run` reaches it from another run, `schedules` from a clock, and
      `POST /repos/workflow-runs/event` from anything that has something to tell a run already
      waiting.
- [x] Trigger policy records which source revision supplied the workflow. A pull request from a fork
      cannot replace a trusted workflow and gain secrets.

      Two commits on the run, kept apart: `head_sha` is the code under test and `definition_sha` is
      where the instructions came from. They are the same for a push and different for a pull
      request, and a reader who cannot see the difference cannot tell a run of their code from a run
      of their code by somebody else's workflow. The run screen and the API both say which.

      The definition comes from `currentVersions` - what this repository has registered - so a fork
      cannot supply one at all: there is no path by which a pull request's tree becomes a version
      row. `tests/e2e/ci-security.test.ts` pins both halves, the definition and the trust flag, and
      the claim test beside it pins what the flag buys: no secrets, and no identity token.
- [x] Monorepository support: changed-path matching, working directory, shared setup jobs, and more
      than one deployable application per repository

      Four things rather than a feature, and all four are here.

      **Changed-path matching** at two levels, because they answer different questions: `paths:` and
      `paths-ignore:` decide whether a *workflow* runs at all, and `reviewos.if-changed:` decides
      whether one *job* does. The second is the monorepository primitive - one workflow, one job per
      package, each running only when its own directory moved - and the run records
      `changed_paths` so a job's condition can ask what the push touched rather than re-deriving it
      from the commit.

      **Working directory** resolves workflow → job → step, so a monorepository sets it once per
      job instead of on forty steps. **Shared setup** is `needs:` for a job every package waits on,
      `uses:` for a workflow several repositories call, and the dependency cache underneath both.

      **More than one deployable application** falls out of environments being named rather than
      enumerated: `api-staging` and `web-staging` are two environments with their own protection
      rules, their own secrets and their own deployment history, in one repository.
- [x] Deduplicate trigger delivery so replaying a push webhook does not create a second run

      A unique index on (version, ref, head, event), not a check-then-insert: two deliveries
      arriving together would both pass a check and both insert. The insert is attempted and a
      collision is read as "somebody else already made this run", which is the right answer whether
      the somebody else is a redelivery, a retried job, or a second scheduler.

      Not cosmetic. Two runs for one commit are two builds competing to report a status for it, and
      the one that lands last wins regardless of which was right.
- [x] Tests: branch and path filters, tag pushes, fork policy, reusable plus local workflows, an
      invalid graph, and the same event delivered twice

      All six, and worth writing down where, because a list like this is otherwise a claim nobody
      can check:

      | Named case | Where |
      |---|---|
      | branch and path filters | `workflow-triggers.test.ts` - including the negative ones, which are the half that silently does nothing when it is forgotten |
      | tag pushes | `workflow-triggers.test.ts`: a tag does not run a workflow that filters branches, and does run one that asks for tags |
      | fork policy | `ci-security.test.ts` - the definition comes from the base branch, the run is untrusted, and the claim hands it no secrets and no identity token |
      | reusable plus local workflows | `workflow-call-graph.test.ts`: the called workflow's jobs land in the caller's run, under the caller's name, with `needs` resolving across the join |
      | an invalid graph | `workflow-parse.test.ts` - a `needs:` cycle is refused with the cycle named, rather than dispatched and hung |
      | the same event delivered twice | `workflow-dispatch.test.ts`: the second delivery creates nothing and the run count does not move |

      The fork one landed this phase; the rest were written beside their features. The pattern worth
      keeping is that each asserts the *refusal* as well as the acceptance - a filter that matches
      everything passes every test that only checks what should run.

## Durable runs and the control API

The database is the source of truth for orchestration. A runner may disappear after accepting work;
the run must remain inspectable and resumable without trusting runner memory.

- [x] `WorkflowRun`, `WorkflowJob`, `WorkflowStep`, and `WorkflowStepAttempt` models, tied to one
      workflow version, repository, commit, trigger, actor or token, and optional pull request

      `head_sha` and `definition_sha` are separate columns. They are the same commit for a push and
      deliberately not for a fork's pull request, where the workflow is the base branch's - and
      `trusted` is written at creation from that, rather than re-derived by whatever asks at
      injection time. One place to look beats a rule every caller re-implements.

      An attempt is a row rather than a counter, because a step that succeeded on its third try is
      a different fact from a step that succeeded, and a counter cannot tell them apart. That
      distinction is where phase 15's flaky-test verdicts come from, so the history has to exist
      before anything can measure it.
- [x] Explicit run states: queued, running, waiting, paused, cancelling, cancelled, failed, and
      succeeded, with terminal states that cannot move backwards

      The backwards rule is the one that matters, and it is not theoretical. The runner is somebody
      else's machine executing hostile code by design, so the control plane cannot kill it - a late
      message from a lapsed lease *will* arrive, and the only question is whether it is refused or
      quietly believed. **A cancelled run turning green satisfies a branch protection rule with a
      check nobody ran**, and it is silent: the row simply says something else than it did.

      `cancelling` keeps its way out to *every* terminal state rather than only to `cancelled`,
      because cancellation is cooperative first and a job that finished in the moment between the
      request and the acknowledgement really did finish. Forcing it would be the control plane
      overwriting something that happened.

      A run's state is derived from its jobs rather than accumulated, so a control plane that
      restarted mid-run reaches the same answer as one that watched every transition. A failure
      while other jobs are still running is still `running`: the rest may be cancelled by policy,
      and "failed" now is a verdict the run has not reached.
- [x] A dependency graph supports sequential jobs, fan-out, fan-in, conditional edges, and failure
      policies without encoding orchestration in queue timing

      `blocked` is a state rather than an absence, which is what keeps the graph out of the queue: a
      job waiting on `needs:` is not queued and nothing should hand it out. Modelling it as "queued
      but ignored" is exactly how orchestration ends up living in dispatch order.

      `unreachableJobs` exists for the other half. A job whose dependency failed can never run, and
      leaving it `blocked` forever means the run never reaches a terminal state - a run that never
      finishes is one holding a pull request's checks open with nothing to show. A dependency that
      is not in the run at all counts as failed rather than as satisfied, so "the graph is missing a
      job" cannot become "run it anyway".
- [x] Each step persists its inputs, output metadata, attempt count, timestamps, timeout, retry
      policy, and error before the next step becomes eligible

      "Before the next step" is the part that was missing, and restart-from-step is what made it
      matter: results travelled only with the conclusion, so **a runner that died at step nine had
      reported nothing at all** - the rows said the job never began, and a restart had nothing to
      keep. They ride the heartbeat now, which is a request the runner has to make anyway.

      Which it was not making. Nothing on the local runner ever renewed a lease, so a job whose
      first step was a ten-minute build lapsed at sixty seconds, was swept back into the queue, and
      ran a second time on another machine while the first was still working. The timer that fixes
      that is the same one that carries the results.

      The attempt count is stated by the runner rather than counted here, which is what makes a
      repeat harmless: delivery is at-least-once, so a column this end incremented would climb every
      time an answer was lost. Each try is also a `workflow_step_attempts` row, keyed on the attempt
      number so the repeat updates rather than doubles - that table is where phase 15 measures
      flakiness from, and it held only job-level errors before this. The step's `error` is beside
      its exit status: a number says a command refused and a sentence says which one.
- [x] Retry policies support limits, delay, and constant, linear, or exponential backoff

`app/Actions/Workflow/retryPolicy.ts`, pure and read from the `retry:` stanza the parser already
accepts. Jitter spreads downward only, so a matrix of twenty jobs failing against one flaky
dependency does not retry in lockstep and does not push itself past a timeout set against the stated
delay. The scheduler still has to call `delayFor` when it requeues - the policy is decided, the
requeue is not yet reading it.
- [x] Restart a whole run or restart from one named step and attempt. Earlier successful step results
      are reused only when their inputs and workflow version still match.

      `scope: 'step'` on the re-run action, and it is the only scope that skips anything. The other
      three start every job they touch from the top on purpose: a re-run lands on a fresh machine
      with none of the workspace the earlier attempt left behind, so skipping a checkout there hands
      the next step an empty directory. Only somebody naming a step is saying they know that.

      How far it may skip is `reusePlan`'s answer rather than the caller's: the recorded rows are
      compared against what the definition says, and the first step that changed, failed, or lost
      its result is where the restart begins. A request to start further in is honoured as far as it
      can be and the answer says why - silently starting eight steps earlier looks like the feature
      not working. The runner is handed a number and a flag per step rather than a rule, plus the
      kept steps' outputs, because `steps.build.outputs` is what the step being restarted reads.

      Re-running also resets the step rows, which it never did: the job went back to queued and its
      steps kept the last attempt's states, so the screen showed a queued job made of succeeded
      steps. "One named attempt" is the half not built - the rows hold the latest attempt's results
      and nothing older, so a restart reuses those or none.
- [x] Waiting steps can sleep until a time or wait for a typed external event, with a timeout. This
      is the primitive for approvals, webhooks, and other human-in-the-loop gates.

      `reviewos.await:` - `30m`, `until: <instant>`, or `event: deploy-approved` with a `timeout:`.
      One kind rather than two, because "a job that is waiting" is one thing and the difference is
      only what ends it. It is the control plane's own work like a barrier and a gate, so a run
      waiting three days costs three days of a row rather than of a machine - which is also why it
      needs a sweep, since a run that holds nothing is a run nothing is looking at.

      A wait that nothing could ever end is refused at parse time rather than defaulted. That
      failure appears days later on somebody else's screen: a job nobody can end holds a pull
      request's checks open forever, and by then the workflow file is three commits old.

      An event that times out **fails** the job, and that is the default rather than the choice: a
      run that goes green on "nobody replied" is a green check for a deployment nobody approved.
      `on-timeout: continue` is there for the wait whose whole point is "give it a minute".
- [x] Cancellation is cooperative first and forceful after a deadline, with the runner lease
      revoked so a disconnected worker cannot publish a late success

      All three halves, and the third one was a hole in the first two. Cancelling revokes every
      lease **at the moment of the request** and leaves running jobs in `cancelling` - asked to
      stop, not known to have. That is the honest state and it was also a state nothing ever left:
      the run never reached a terminal one, so a pull request's checks stayed open on work that had
      stopped minutes earlier.

      So the runner that behaves can now say so. One report survives a revoked lease and only one -
      `cancelled` - because the credential still proves it is the holder, and "I stopped" cannot
      fabricate a verdict the way "I succeeded" can. A success on a revoked lease is refused exactly
      as it was, which is the case the revocation exists for: a green check for a run somebody
      stopped satisfies a branch protection rule.

      And when nobody says anything, the sweep says it for them after two lease periods. The clock
      is the revoked lease itself, which cancelling set to the instant it was requested - a column
      whose only content would be that same instant is a column that eventually disagrees with it.
      A job that finished successfully in between keeps that result: the work really did happen, and
      overwriting it would be the control plane inventing an outcome. A job asked to stop is never
      returned to the queue, either, which would have a second machine run what somebody cancelled.
- [x] Optimistic locking or transitions in one transaction prevent two schedulers from dispatching
      the same step

      Optimistic, everywhere, and the same shape each time: read the row, write it back conditioned
      on what was read. The claim is the sharp one - `state = 'queued' AND runner_id IS NULL` for a
      free job, and `runner_id = <the stale holder> AND lease_expires_at = <the lapsed value>` for
      one being recovered - so two runners asking in the same instant produce one winner and one
      update that matches nothing, and the loser moves to the next candidate rather than to an
      error. `tests/e2e/runner-claim.test.ts` runs both halves of that race.

      The settler's transitions are guarded the same way, on the state each row was read at, which
      is what stops a report arriving mid-settle from having a staler verdict overwrite a newer one.
      A run that has reached a conclusion is never moved again by anything.

      A workflow program has the one case optimism cannot cover, and it uses a unique index instead:
      whoever wins the insert on `(run, sequence)` owns the right to dispatch that call. Two
      orchestrators for one run - which is what a lapsed lease produces - both try, one loses, and
      the loser is told rather than quietly running everything twice.

      No transaction spans a dispatch, deliberately. A transaction held across the work would be a
      lock held while a machine builds something, and the failure mode of that is a control plane
      that stops answering when a runner goes quiet.
- [x] Recovery sweep for expired runner leases and control-plane restarts

      `ReclaimLapsedLeasesJob`, every minute - a sweep slower than the sixty-second lease is a job
      sitting in `running` with nobody coming for it. Until it existed the only thing that freed one
      was another runner *happening to poll*, which never happens on the instance where it matters
      most: the one whose fleet is busy elsewhere. A repository whose only runner crashed had a
      pull request whose checks stayed pending on a machine that was gone.

      **Returned to `queued`, not failed.** A lapsed lease means the control plane stopped hearing
      from a runner, which is not the same as the work having failed - it may even have succeeded
      with the report lost on the way back. Requeuing risks running it twice, failing it reports a
      verdict nobody reached, and at-least-once is the promise the protocol already makes.

      A running job holding no lease at all is reclaimed too: that is a row which lost its holder,
      and skipping it would leave the one case that cannot recover itself. Each write is guarded on
      the state and holder it was read at, so a runner that heartbeated in between keeps its
      job - taking work from a machine that is alive is the direction that does damage. A finished
      run is never reopened by a lease expiring underneath it.

### REST API

- [x] Canonical route families under a repository: `/workflows`, `/workflows/{workflow}/versions`,
      `/workflow-runs`, `/workflow-runs/{run}/jobs`, `/logs`, `/events`, and lifecycle actions. Route
      names use `repository` and `workflow run`, not provider-specific vocabulary.

      The families are `/repos/workflows` and `/repos/workflow-runs`, with the subject in the query
      rather than in the path - which is this API's shape everywhere, not a decision taken here, and
      changing it for one family would leave two ways to address a repository. The vocabulary is the
      substance of the line and it holds: **repository** and **workflow run**, no provider's word
      for either, and lifecycle actions read as verbs on the run they act on.
- [x] List workflows, get one workflow, list versions, get one version, and return its normalized
      graph

      `GET /repos/workflows` and `GET /repos/workflows/show`. The listing was the hole in every
      other question this API could answer: runs were filterable by workflow with nothing to say
      which workflows existed, so a client had to start from a run to learn the shape of a
      repository's CI - and an empty repository had nothing to show at all. Each row carries the
      version it would run today, because that is the question immediately after and a request per
      row turns a page of twenty into twenty-one.

      **The graph is normalized rather than the file re-served.** Handing back YAML would make every
      client parse a format whose meaning lives here - the `needs:` a barrier inserts, the kind a
      `reviewos:` key decides, the matrix that turns one job into four - and two parsers is how a
      client's picture of a run stops matching the run. The triggers travel as flags for the same
      reason: `on: [push]` and `on: { push: { branches: [main] } }` have already been decided.
- [x] Dispatch a workflow with caller-supplied inputs and an idempotency key

      The inputs were already checked against what the workflow declared. The key is new, and it
      opts one request out of the thing a dispatch otherwise is: `workflow_dispatch` is a repeatable
      event by design - a nightly job runs at the same ref every night, and pressing the button
      twice on purpose is the feature - so it carries no redelivery key of its own. A caller that
      names one is saying something narrower: *this* request, however many times the network makes
      them send it.

      It goes into the same column the redelivery index is already on, namespaced by repository. A
      second column would be a second index to keep true, and a bare key would let one repository's
      dispatch collide with another's - turning somebody else's retry into a run that never happens
      here. A repeat gets the run rather than a conflict, because a client retrying a request it did
      not hear the answer to wants the answer.
- [x] List runs by repository, workflow, commit, pull request, status, trigger, and time using cursor
      pagination with stable ordering

      Through the same cursor helpers every other list endpoint uses, rather than a second idea of
      "after" written here - two definitions of it is how a cursor skips a row in one endpoint and
      repeats it in another, and the bug reads as a database problem. Ordered by `created_at` with
      the id as tiebreaker, because two runs from one push share a timestamp to the second and
      without the id they straddle a page boundary with one never returned.

      A branch is accepted as `main` as well as `refs/heads/main`: the first is what somebody types,
      the second is what a link built from an event carries.
- [x] Get a run with its jobs, steps, attempts, check rollup, trigger, workflow version, and timing

      Whole, rather than as three endpoints a client stitches. A run is tens of jobs and tens of
      steps, the screen that shows one needs all of it, and three round trips buy nothing but a
      chance for the three to disagree about what state the run was in. Steps come back in one
      query for the whole run rather than one per job.

      Addressed by the run's **number** - what a person says out loud and what a link carries -
      rather than by its database id. The workflow version is included so a reader can tell which
      definition ran, and whether it is the one in the branch today.

      Attempts and the check rollup are not in the response yet: nothing produces attempts until
      something executes a step, and there is no rollup to report. Listed here rather than
      pretended.
- [x] Read logs incrementally from a cursor, with plain text and structured event representations

      `/api/repos/workflow-runs/log?job=&after=`, chunk-sequenced. The cursor is a chunk sequence
      rather than a byte offset, because a byte offset into a log that is still being written means
      something different a second later.

      **Reading is the repository's permission, not the runner's.** A log is the repository's data,
      and somebody who cannot see the code cannot see what building it printed - which matters more
      than it sounds, because build output routinely carries paths, hostnames and the occasional
      thing somebody echoed by mistake. The job id is checked against the repository too: it is a
      number anybody can increment, and without that check it is a way to read another repository's
      output.

      Structured event representations are not done; this is the plain-text half.

      The run screen renders it too, server-side rather than fetched: a log that arrives after the
      page is one somebody watches appear, and the run is usually over by the time anybody opens it.
      Closed by default, because a run with six jobs is otherwise a page of scrollback and the
      reader came for the one that failed. `pre` and nothing else - the text came off a machine
      running somebody's build, so it is escaped and shown, never interpreted.

      **Opening the screen found two things the API could not.** The runs pages had no tab pointing
      at them, so they existed and were unreachable by navigation - the same failure the `RepoTabs`
      comment warns about, with the arrow the other way round. And `var(--border)` is used in eight
      files and **defined nowhere**: an undefined custom property makes the declaration invalid at
      computed-value time, so every one of those borders fell back to `currentColor` and rendered at
      full text contrast. In dark mode the tab underline was drawn in near-white against a hairline
      elsewhere on the same screen. The token is `--line`; all eight now use it.
- [x] Pause, resume, cancel, retry from the start, and retry from a named step

      **All five.** Retrying from the start and from a named step are `scope: 'all'` and
      `scope: 'step'` on the re-run action, above. Pause and resume are `POST
      /repos/workflow-runs/pause`, both directions through one action because they are one decision
      with a sign - two endpoints would be two places that have to agree about what a held run is.

      A hold stops what has not started, not what is running. A runner mid-build cannot be politely
      interrupted - that is why cancellation is cooperative - and a screen claiming the run has
      stopped while a machine is still billing for it would be a lie in the expensive direction. The
      claim only ever hands out work from a run in `queued` or `running`, so a held run is one no
      machine is offered work from, and the rule stays in the one place that decides.

      `paused_at` is a column beside the state because resuming has to put the run back to whatever
      it *would* have been, which is computed from the jobs and cannot be if the pause overwrote the
      only record that there was a pause. A run held while three jobs were running and resumed after
      they finished is a run that has finished - a remembered "it was running" would put it back to
      a state it left while nobody was watching.

      Cancelling was the first of the five, and it is the one the state machine exists for.

      A run goes to `cancelling`, not straight to `cancelled`: the jobs are on machines this
      instance does not control, and saying they have stopped before they have is a screen telling
      somebody work has ended while it is still running and still costing them. Jobs that never
      started are cancelled outright - there is nothing to ask to stop - and running ones have their
      **lease revoked at the moment of the request** rather than when a runner acknowledges it,
      which is what stops a worker that already lost its connection publishing a success over a run
      somebody cancelled.

      The update is guarded on the state that was read, so two cancellations arriving together, or a
      run that finished in between, cannot have one overwrite what happened. Cancelling a run that
      already finished is not an error and does not answer 409: it is an ordinary thing to do - two
      people on the same screen, a click that arrived late - and it answers with the state, which is
      the truth.

      Cancelling needed a permission that did not exist. `workflow:cancel` is its own ability rather
      than `check:report`, because a CI integration that publishes results has no business stopping
      somebody's build, and a person who can stop one need not be able to report a passing check -
      which is the more dangerous of the two, since that is what satisfies a branch protection rule.
- [x] Send a typed event to one waiting run, idempotently, and record who or what sent it

      `POST /repos/workflow-runs/event`, behind `workflow:approve` rather than `workflow:cancel`:
      an event is what lets a held deployment through, which is approval wearing different clothes.
      The payload becomes the waiting job's outputs, so a later job reads it as
      `needs.approval.outputs.version` - the same way it reads any other job's.

      Idempotent on a key the sender chooses, because a sender that does not hear the answer sends
      again - that is what every webhook in the world does, and without a key those are two events
      that let one deployment through twice. A sender that names no key gets one derived from the
      delivery, since a unique index over a nullable column enforces nothing for exactly the callers
      least likely to be careful.

      **Recorded even when nothing is waiting yet**, which closes the lost wakeup from the other
      side. An event that arrives a second before its job becomes eligible would otherwise vanish
      and the run would sit until its timeout on a message that did arrive - the hardest kind of
      report to believe, because the sender saw a 200 and nothing anywhere says it was dropped.
- [x] The interface, CLI, webhooks, and provider integrations call the same actions as the public API

      True, and now pinned rather than asserted: `tests/unit/one-front-door.test.ts` walks every
      `<form method="post">` in `resources/` and every `/api/` path in `app/Commands/`, and fails
      when one names a route this application does not declare. Prose does not fail, and a form
      posted at a route that does not exist renders perfectly and 404s on submit - which nobody
      notices until somebody presses the button.

      Writing it found exactly that: `ci:dispatch` had been posting to `/api/repos/workflow-dispatch`
      while the route is `/api/repos/workflows/dispatch`, so the command had been answering 404 for
      anybody who ran it. Fixed in the same commit.

      The rule is worth the test because the second front door is always the worse one: a control
      the interface has and the API does not has no token scope, no audit event, no rate limit and
      no OpenAPI entry, because every one of those was built for the first.
- [x] Every endpoint has a fine-grained token requirement, generated OpenAPI, stable errors, rate
      limits, audit events, and request ids that continue into dispatched jobs

      Five of the six were already load bearing: `app/TokenScopes.ts` maps every ability to a scope
      and a level, the OpenAPI document and `docs/api.md` are generated rather than kept in step by
      hand, `apiError` gives one error shape with a code and a fix, `RATE_LIMIT_HEADERS` are
      declared per endpoint, and anything that spends machines or changes state writes an audit
      event.

      The sixth is new. A caller's `X-Request-Id` is **kept** - or `X-Correlation-Id`, since both
      are in the wild - and lands on the run, travels to the machine in the claim, and reaches the
      job as `GITHUB_REQUEST_ID`. Kept rather than replaced because the whole value is on the
      caller's side: they have already logged that id beside their own stack trace, and one this
      instance invented is one they cannot search for. A caller who sends none gets one, so the run
      is traceable from this side either way.

      Untrusted, bounded, stripped of anything unprintable, and read by nothing that makes a
      decision - a value that decided something would be a value worth forging.
- [x] Webhook events for run and job transitions, action required, deployment, and artifact expiry

      **The two transitions are done; the other three have nothing to fire yet.** `run:transitioned`
      and `job:transitioned` carry the new state in `action`, so one subscription covers queued
      through finished and a receiver that only wants completed runs reads one field. They are
      emitted from every place a state actually changes - the claim, the report, the cancellation
      and the recovery sweep - and the sweep is the one that matters most: every other transition
      happens because somebody asked and hears the answer, while that one happens because a machine
      stopped talking, so the event is the only way anything finds out.

      A run's event carries its number, state, commit, ref and triggering event; a job's carries the
      key `needs` refers to, its name, its run, and which machine holds it - the fields a fleet
      operator needs to join a slow job to a sick runner. `subject` stays the repository rather than
      growing a fourth type for a receiver to learn.

      **Action required and artifact expiry now have something to fire, and do.** `run:action_required`
      is deliberately not "the run is waiting": a run waits behind a concurrency group and behind a
      sleep too, and neither is anybody's to act on - a receiver told about those learns to ignore
      the event, which is how an alert stops being one. `action` says which of the three it is, so a
      chat integration can post "this deploy needs an approval" without asking a second question.
      An approval is a fork's pull request nobody has vouched for, a gate is a `block:` job somebody
      has to open, an event is an `await:` job holding for something outside this instance.

      `artifact:expired` is the only event here about a disappearance, and it exists because that
      failure is otherwise silent: a system that fetched a build output nightly starts fetching a
      404, and the first person to find out is whoever needed the file. It carries the name, the
      size and the run rather than a link - the file is gone by the time it arrives, and a URL that
      answers 404 is worse than no URL.

      **And deployment, now that there is a deployment history to fire from.** `deployment:status`
      covers recorded, in progress, active, failed, inactive and rolled back, with the state in
      `action` like the rest - so a dashboard subscribes once rather than polling a history
      endpoint, and the next stage of a pipeline can wait on the one before it landing.
- [x] Tests cover every state transition, token boundaries, idempotency, stale writes, cursor
      pagination, recovery after lease expiry, and restart from a step

      **All seven.** The seventh had nothing to test until restart-from-step existed; it does now,
      and `workflow-restart-step.test.ts` covers the reuse, the refusal when the definition moved,
      the result too big to keep, and what the runner is handed. It is worth writing down where each
      of the others lives, because a list like this is otherwise a claim nobody can check:

      | Named case | Where |
      |---|---|
      | every state transition | `tests/unit/workflow-state-table.test.ts` - the table itself, not one case at a time |
      | token boundaries | `runner-api.test.ts`: a registration token cannot report, a job credential cannot write to another job |
      | idempotency | `runner-claim.test.ts` (the repeated completion), `runner-logs.test.ts` (the repeated chunk) |
      | stale writes | `runner-claim.test.ts` (a report after the lease lapsed), `runner-api.test.ts` (a completion for a run that already ended) |
      | cursor pagination | `workflow-api.test.ts` - including that the last page carries no cursor rather than one returning nothing |
      | recovery after lease expiry | `runner-reclaim.test.ts`, both directions: the dead machine's work comes back, the live machine keeps its own |
      | restart from a step | `workflow-restart-step.test.ts` - what is kept, what is refused, and what the runner is told |

      The state-transition file is the one worth reading. Individual cases cover the transitions
      somebody thought to write down; what they cannot cover is the shape of the table - a state
      added to the union and forgotten in the table, a terminal state that grew an exit, a derived
      state the table has never heard of. Each is a one-line mistake, and each ends with a run that
      either never finishes or finishes twice.

## Runner provider contract

Build the provider-neutral contract before a hosted runner. The first useful provider may be a
self-hosted runner process, an external CI adapter, or a Cloudflare-backed integration. ReviewOS
should not make its public workflow API describe one vendor's sandbox.

- [x] Versioned runner protocol for claim, heartbeat, log append, artifact upload, step completion,
      and cancellation acknowledgment

      Claim, heartbeat, completion and log append are implemented, reachable over HTTP at
      `/api/runner/claim`, `/api/runner/heartbeat`, `/api/runner/report` and `/api/runner/logs`,
      and held by `tests/e2e/runner-claim.test.ts`, `runner-api.test.ts` and `runner-logs.test.ts`.
      Cancellation acknowledgment and protocol versioning have since been added: a runner that
      heard a cancellation may report `cancelled` even with the lease the cancellation revoked -
      and only that, because "I stopped" cannot fabricate a verdict the way "I succeeded" can - and
      every request may carry `X-Runner-Protocol` while every answer carries
      `X-Runner-Protocol-Supported`. Artifact upload has since been added too, so the box now
      covers everything it names.

      The status codes are part of the contract rather than decoration. **No work is a 200 with
      `job: null`**, because a runner polling an idle instance is not making a mistake and an error
      status for the common case fills a fleet's logs with red that means nothing. **A refused
      heartbeat is a 409**, because it tells the runner to stop working - the lease lapsed or the
      run was cancelled, and anything it reports afterwards will be refused anyway. **A duplicate
      report is a 200**, because at-least-once delivery means a correct runner will say it twice,
      and answering 409 to that is how one retries forever.

      Adding the routes tripped two of this repository's own invariant tests, both correctly: the
      OpenAPI document needed regenerating, and the CSRF exemption count is asserted exactly, so
      three `skipCsrf` routes could not arrive without somebody writing down why they are exempt.
      They are exempt because a runner is a machine with its own bearer token and there is no
      browser, no cookie and no session anywhere in the conversation - nothing for a forged
      cross-site post to ride.

      **The guard is in the `WHERE`, not in an `if`.** Reading a job, deciding it is free and then
      writing the lease is two statements with a gap in the middle, and the gap is exactly long
      enough for another runner to do the same. The update names the state it expects to find, so a
      lost race changes no rows - an ordinary outcome rather than an error.

      Three bugs came out of running it, all of them in the direction that fails open:

      - `where(column, 'is', null)` compiles to a bound parameter and Postgres rejects it. This
        codebase already had that written up twice, in `Auth/twoFactor.ts` and `Pull/suggest.ts`,
        and it was repeated here anyway - and again in `Workflow/sync.ts`, where it would have
        broken owner-wide workflows. `whereNull` is the spelling.
      - A `where` added *after* a `limit` is spliced in after it, and Postgres answers "argument of
        AND must be type boolean, not type integer" - the limit having become one side of the
        condition. Conditional filters go on before `orderBy` and `limit`.
      - **This driver reports affected rows as a plain number**, which the first version of
        `changedSomething` did not handle: it looked for `numUpdatedRows`, found nothing on a `0`,
        and fell through to "assume it worked". An update that matched nothing reported success,
        which is the guard inverted - a runner could extend a lease on a job it did not hold, and
        two runners racing would both be told they had won. Unknown now counts as failure, because
        a claim that wrongly fails is visible and one that wrongly succeeds is two machines running
        the same job while the control plane believes one is.

      A completion also settles the run: it skips what can no longer happen and queues what is now
      unblocked. Without the first, a job whose dependency failed sits blocked forever and the run
      never reaches a terminal state - a pull request whose checks never resolve, holding a merge
      open on work that stopped minutes ago.
- [x] Runner registration, authentication, labels, capabilities, and scoping to an instance,
      organization, repository, or selected workflow

      The `Runner` model, with the token stored as a SHA-256 hash: a registration token in the
      database in plain text is one in every backup, and a runner credential is a credential to
      receive somebody's source code. Registration is administrative rather than self-service,
      which is the whole posture of the runner side - a runner executes hostile code by design, and
      what stops that being an instance compromise is that the instance hands work only to machines
      an operator chose.

      Scope is checked before labels, because it is the one that is not a scheduling mistake: a
      runner registered for one repository being handed another's source is the instance giving
      somebody else's private code to a machine its owner chose. **An unknown scope reaches
      nothing**, so a scope added later cannot silently default to everything.

      Selected-workflow scoping is not implemented; instance, organization and repository are.
- [x] Short-lived job credentials, bound to one attempt. Registration credentials never enter the
      job environment.

      A claim mints a random token, stores its SHA-256 on the job, and returns it once. Heartbeat
      and report authenticate with **that** and no longer accept the registration credential, which
      is the one an operator installs once and never rotates - the credential that must not be
      travelling on every call, let alone reach a job environment.

      **The token names the job**, so no job id is taken from the caller at all. "A credential used
      against the wrong job" stops being a case defended against by hand and becomes one that
      cannot be expressed.

      It is minted per claim, so recovering a lapsed lease invalidates the dead runner's token in
      the same write that hands the work on, and the sweep clears it for the same reason.

      **It is deliberately not cleared on completion**, which was the first instinct and is wrong.
      Delivery is at-least-once: a runner that did not hear the answer reports again with the same
      credential, and a cleared token turns that into a 401 - leaving the runner unable to tell
      whether its work was recorded, which is exactly the ambiguity the duplicate answer exists to
      remove. Nothing is bought by clearing it, either: the job is terminal by then, `mayReport`
      will not move a terminal job, and the token's entire remaining power is to be told "already
      recorded".

      A runner disabled mid-job stops being believed immediately rather than when its lease happens
      to lapse, because turning one off is something an operator does *because* they want it to
      stop.
- [x] Leases with heartbeat expiry, at-least-once delivery, and idempotent completion reporting

      Decided in `app/Actions/Runner/protocol.ts`, away from the database, so the cases that matter
      can be tested at the boundary - and `now` is passed in rather than read, because a lease rule
      that depends on a hidden clock cannot be.

      **Only the lease holder, and only before the lease lapses.** A worker that lost its connection
      is indistinguishable from one that never left, except by the lease, and without that rule it
      can publish a success over a job that was cancelled and handed to somebody else: a green check
      for work nobody did.

      A lease that has lapsed makes the job claimable again, which is the only thing that recovers
      work from a machine that died - it cannot be asked. A malformed lease timestamp reads as
      expired rather than as forever, because the other way round one bad write holds a job for
      good.

      A repeat of a completion already recorded is accepted as a duplicate rather than refused.
      Delivery is at-least-once, so a runner that did not hear the answer says it again, and
      treating that as a conflict is how a correct runner retries forever. It is still refused when
      it comes from a runner that does not hold the job.

      `runs-on` matching needs **every** label rather than any: `[self-hosted, macos]` means both,
      and matching on any is how a macOS build lands on a Linux box and fails confusingly instead of
      waiting for the machine that could have run it.
- [x] Provider capabilities are discoverable, so the scheduler can reject an impossible job instead
      of leaving it queued forever

      Discoverable was the easy half and was already done: a runner registers its labels, its scope
      and its tags, and `explainWaiting` turns those into the sentence on the run screen. The half
      that was missing is that **nothing acted on it**. A job asking for `macos-14` on a fleet that
      has never had one sat queued indefinitely, holding a pull request's checks open on work that
      was not going to happen.

      The sweep fails those, with the same sentence the screen shows and the fix beside it. It rests
      on one distinction: **a capability nobody has is not a fleet that is busy.** Machines being
      occupied, switched off, or in a drained queue is a wait, and failing it would be the instance
      giving up on work it can do. A label no runner carries, a scope none reaches, or a tag query
      nothing reported is permanent.

      An hour of grace, because "nothing answers to this label" is also what a correct instance
      looks like in the minute between a workflow landing and an operator registering the runner for
      it - and a pool refusing a repository is deliberately excluded even though it is just as
      permanent, since that is an operator's decision about their own fleet and one they may reverse
      before lunch.
- [ ] A provider cannot read another provider's job payloads, logs, caches, artifacts, or secrets
- [x] External CI adapters can translate an existing provider's run into ReviewOS check runs without
      pretending ReviewOS executed it

      The translation was already possible: a check run carries `provider`, `external_id` and
      `details_url`, so an adapter reports into the same table this instance's own runs report into
      - one list, one rollup, one branch rule, which is the whole point of an adapter.

      **What was missing was the second half of the sentence.** The panel dropped the provider, so
      somebody else's build rendered exactly like a run this instance executed. That is a forge
      claiming work it did not do, and it is also the first thing anybody needs when a check is
      wrong: "where do I go and look" has no answer on a row that does not say. The name is on the
      entry and on the screen now, dotted rather than solid so it reads as provenance and `Required`
      keeps the emphasis a branch rule deserves.

      Empty for a check this instance produced, rather than its own name: a badge on every row is a
      badge nobody reads, and the distinction being drawn is "this came from somewhere else".
- [x] A documented self-hosted runner installation and upgrade path, with compatibility negotiation

      [`docs/runner-protocol.md`](../runner-protocol.md). Four endpoints, HTTP and JSON, no SDK: a
      runner written in an afternoon in any language is a supported runner, and a protocol an
      operator can hold in their head is one they can debug at three in the morning with `curl`.

      Negotiation is one number rather than per-endpoint versions or a capability matrix, because a
      fleet operator upgrading a hundred machines needs one thing to compare and a matrix of
      capabilities is a matrix of states nobody tests. It is a *range*, since both directions have
      to work during an upgrade: the server keeps speaking to machines nobody has restarted yet, and
      a runner upgraded ahead of its server is told rather than left guessing.

      Three decisions worth keeping. **A missing version is the oldest**, not a refusal - every
      runner written before the header existed sends nothing, and refusing those would have broken
      every fleet on the day it shipped. **426 Upgrade Required** rather than 400 or 401: a 400
      sends somebody to look at their payload and a 401 to look at their token, and both are the
      wrong afternoon. And the check runs **before the credential**, because a runner that cannot be
      spoken to will misread whatever it is handed.
- [x] Tests against a fake provider: disconnect, duplicate claim, late completion, cancellation,
      incompatible capabilities, and a credential used against the wrong job

      All six, against the real endpoints rather than a mock, because the mock would be the thing
      being tested. Disconnect is the recovery sweep - a machine that stopped talking cannot say so,
      which is the whole reason leases exist. Duplicate claim is two runners asking at once, where
      the guarded write decides. Late completion is a report whose lease lapsed, and the one this
      protocol is built to refuse: a worker that lost its connection publishing a success over work
      somebody else now holds. Cancellation covers the acknowledgment with a revoked lease and the
      forced sweep behind it. Incompatible capabilities answers "no work" rather than an error,
      because a fleet of specialised machines should not log an error every few seconds for
      behaving correctly. And a credential used against the wrong job is refused as *held by another
      runner* rather than as missing - the runner is real, it is just not holding this.

## Execution plane, only after the security decision

Running repository code is not approved merely because the control plane exists. These boxes are a
gate, in order.

- [x] Decide the isolation boundary first: container, microVM, a remote provider, or self-hosted
      runners only. Publish the threat model and what the boundary does not protect.

      Published as [the CI threat model](../ci-threat-model.md). **The decision is that ReviewOS
      does not execute repository code by default, and its default deployment never will**: the
      instance ships a control plane and a runner protocol, and execution happens on machines the
      operator explicitly provides.

      The reason is specific to this product rather than borrowed. The documented default deployment
      is one host, and on one host a container shares a kernel with the process holding every
      private repository on the instance - so a kernel privilege escalation is not a sandbox escape,
      it is instance compromise. Where an operator does opt in, a microVM is the only boundary in
      which running a public repository's fork pull requests is defensible, and **container mode is
      documented as not a security boundary** rather than sold as one.

      The consequence for everything above it: the control plane has to be complete and useful with
      no execution plane at all, or the default becomes a mode nobody runs. That is already this
      phase's shape, and it is why those boxes are not blocked by this gate.
- [ ] Ephemeral workspace per job, immutable base image, read-only source checkout where possible,
      no host socket, no sibling process visibility, and no repository storage mounted into a job
- [ ] Network policy with a safe default and explicit egress controls. A sandbox with unrestricted
      access to instance-local services is not isolated.
- [ ] CPU, memory, process, disk, output, and wall-time limits enforced outside the job
- [x] Secrets encrypted at rest, scoped per environment and job, injected only after authorization,
      redacted from logs and structured outputs, and never exposed to untrusted fork workflows

      Sealed with the instance's `APP_KEY`, and **there is no endpoint that returns a value** - a
      listing gives names. A reveal button is the feature that turns one compromised session into
      every credential an organization has, and its absence costs somebody a trip to their password
      manager on the day they need the value back.

      Four scopes, narrowest first, and the environment scope is the one that earns the feature: a
      deploy credential attached to `production` is unreachable from the test job in the same run,
      and unreachable from the deploy job itself until the gate opens - otherwise it sits in the
      job's environment while it waits for a reviewer, which is the window somebody would use.

      Readable as `${{ secrets.NAME }}` and **not** injected into the environment, which is
      Actions' behaviour and the right one: a step never told about a credential does not have it
      where a crash dump or a `printenv` would find it. Every delivered value is masked on the
      runner before the first step runs - masking after the value has crossed the wire is not
      masking - and a value this instance can no longer decrypt is skipped rather than delivered
      empty, so the failure lands at the line that uses it.

      Rotating `APP_KEY` makes every secret undecryptable and they have to be set again. There is
      no re-encrypt command, which the documentation says rather than implying otherwise.
- [ ] Dependency cache keyed by declared inputs, runtime, architecture, and lockfile digest. Cache
      restore permissions prevent a fork or lower-trust branch from poisoning a protected branch.
- [x] Artifacts are content-addressed, size-limited, checksummed, access-controlled, and expired by
      policy. Artifacts and dependency caches are distinct resources.

      Storing bytes is not running them, which is why this one is done while the boxes around it
      wait: nothing here executes anything, and an artifact is a file a runner an operator already
      trusts hands over. Caches are deliberately absent - a cache is an optimisation the instance
      may drop whenever it likes and an artifact is something a person asks for by name three weeks
      later, so sharing a table would mean one retention policy for two opposite needs.

      **Content-addressed**, at `storage/artifacts/{aa}/{bb}/{sha256}`. Three consequences, and the
      third is the reason: a matrix of eight jobs publishing the same binary costs one copy; the
      name is metadata rather than a path, so an artifact called `../../config/app.ts` is a row with
      an odd name instead of a write outside the directory; and a download can be checked, because
      the digest is what the row is keyed on and is returned as a header.

      **Two ceilings**, per artifact and per run, because one without the other is not a ceiling: a
      per-artifact limit alone is walked around by a matrix of fifty jobs each uploading just under
      it. Both are enforced on the way in - a runner streaming forever is not stopped by a policy
      that runs tomorrow, it fills the disk tonight.

      **Access is the repository's**, with no artifact permission of its own: an artifact is built
      from a repository's code and often contains it, and a second permission that has to be kept in
      step with the first is one that eventually is not. The id is a number anybody can increment,
      so it is checked against the repository the caller named - without that the endpoint reads out
      every repository's build output one integer at a time. And every download is an attachment
      with `nosniff`, whatever the uploader claimed the type was, because an HTML report a browser
      renders in place is stored cross-site scripting with extra steps.

      **Expiry is a promise, not a cleanup.** The date is decided at upload, shown in every listing
      and on the run screen, and a download past it is refused before anything sweeps. The hourly
      sweep is how the disk follows, and it removes the row first and the blob second - a row
      without a file is an unpleasant 404, a file without a row is a byte nobody can reach and
      nobody will ever delete. A blob another artifact still points at survives its own row
      expiring, which on a matrix is the ordinary case.
- [ ] Log streaming applies backpressure and redaction before persistence, with configurable
      retention and a hard ceiling per job
- [ ] Concurrency, fair queueing, and quotas per instance, owner, repository, workflow, and token, so
      one repository or agent cannot starve the instance
- [ ] Runner images and toolchains are pinned and attestable. A run records exactly what executed it.
- [ ] Security review of the threat model, protocol, sandbox breakout surface, secret flow, cache
      poisoning, artifact handling, fork policy, and cancellation behavior before a public runner
      executes one command
- [ ] Adversarial tests: fork secret theft, cache poisoning, symlink escape, oversized logs and
      artifacts, process escape, internal-network access, job credential replay, and cancellation

## Workflow developer experience

- [x] Setup or install step can produce a cache snapshot consumed by later steps without giving
      those steps a shared mutable machine
- [x] Independent jobs run in parallel; dependencies and barriers are explicit in the graph
- [x] Conditional steps can inspect declared prior results, ref, changed paths, trigger, and approved
      inputs without arbitrary access to control-plane state

Prior results are `steps.*` and `needs.*`, the ref and the trigger are `github.ref` and
`github.event_name`, and an approval's typed values become the approving job's outputs - so they are
read as `needs.approve.outputs.x` rather than through a second mechanism. Changed paths are computed
at dispatch, where the repository is on disk, and carried to the runner in the claim: a step's
condition reads a value it was handed, never the control plane.

A very large push is cut to `MAX_CHANGED_PATHS`, and `github.changed_files_truncated` says so. A
condition that quietly answers "that path did not change" out of a cut list is the failure this is
designed against - a step that runs when it need not have costs a minute, and one skipped when it
was needed ships the bug.
- [ ] Preview deployment on non-default branches and deployment after all required checks pass,
      through the deployment model below
- [x] Run view shows the dependency graph, current branch of execution, retries, cache hits, wall
      time, active execution time, queue time, and the workflow version

      Six of the eight were already there - the graph with its critical path, which branch of it is
      executing, the attempt count on the run and on each job, wall time, and the version with the
      commit that supplied it. The two that were missing were the two that make the others
      actionable.

      **The three numbers per step**, which were recorded and shown nowhere: wall, then the queue
      time and the active time it is made of. A step that waited eight of its nine minutes is a
      fleet problem and one that worked for nine is a step problem, and the single number cannot say
      which - the whole reason they are stored separately.

      **Cache hits**, counted on the job as a pair rather than a ratio. Before this the only place
      the answer existed was a log line, which answers it for one person at a time and only while
      the log is still there. "Two of five" points at a key that changes too often; a percentage
      points at nothing.
- [x] Logs and step output can mark fields sensitive, and the API returns redaction metadata rather
      than silently omitting data
- [ ] Aggregate metrics for success rate, failure by step, queue time, duration, retry count, cache
      effectiveness, and runner utilization, filterable by owner, repository, and workflow

      **All seven numbers, filterable by repository, by workflow and by window. The owner-level
      rollup is what is left**, and it needs an authorization this codebase does not have yet:
      everything here answers to `authorizeRepository`, and "every repository under this owner"
      needs an owner-scoped check that does not exist.

      `GET /repos/workflow-metrics`. Success rate is over *finished* runs, because a run still going
      is not a run that failed and counting it as one makes a busy afternoon look like an outage.
      Durations are medians rather than means: one job that hung until its timeout moves a mean far
      enough to hide a week of ordinary builds, and "how long does this usually take" is the
      question being asked.

      Failures are grouped by step *name* rather than position - `make test` at step 3 in one job
      and step 5 in another is one step failing, and a table keyed on position reports it as two
      problems neither of which looks serious. Queue time is beside duration rather than added to
      it, because the two have different fixes and the sum hides which one is needed.

      Every rate is null rather than zero when nothing has happened: a repository that does not use
      the cache has no hit rate, and 0% reads as one that is broken. And the window travels in the
      answer, so a client cannot show a number without saying what it is of.
- [x] Local validation and a fake-runner test harness use the same parser and transition rules as
      production

      `buddy workflow:build` and the CLI's validate command run the same parser the server runs -
      not a description of it - which is what makes a local error the error the push will give.

      The harness is `tests/helpers/fakeRunner.ts`, and the point is what it does **not** do: it has
      no state machine. It calls `claimNextJob` and `reportJob`, the two functions the runner
      endpoints wrap, so every transition it produces is the one production produces. A harness that
      decided for itself what a failed job does to a run would agree with the real thing right up
      until the real thing changed, and then it would be a test suite defending the old behaviour.

      It stops when nothing is claimable, which is a state rather than an ending: a run holding at a
      gate has no claimable job and is not finished, and a test asserts that difference instead of
      timing out. `workflow-pipeline.test.ts` is what it bought - a fan-out, a barrier, a gate and a
      fail-fast in one graph, which is four features tested individually elsewhere and never tested
      meeting each other.
- [x] CLI commands to validate a workflow, dispatch it, follow logs, inspect a run, cancel it, and
      retry from a step, as clients of the public API

`buddy ci:validate`, `ci:runs`, `ci:run`, `ci:logs --follow`, `ci:dispatch`, `ci:unblock`,
`ci:cancel` and `ci:rerun`, all in `app/Commands/Ci.ts` and all going out through one HTTP client -
so a command can do nothing the API does not already offer somebody with `curl`. The exception is
`ci:validate`, which parses locally on purpose: checking a file before it is pushed is the point,
and an instance is not needed to read one.

The retry unit is a job (`--scope all | failed | job`) rather than a step, because a step is not
independently resumable: it inherits a workspace the steps before it wrote, and restarting one on a
fresh machine would run it against state that was never built.

## Repair agents

An agent may propose a repair. It never edits the failing commit in place and never converts its own
failed evidence into success.

- [ ] Opt-in failure hook at repository or workflow level, restricted to selected failed steps
- [ ] Agent receives the workflow version, failure, relevant logs, and a short-lived branch-scoped
      credential, not ambient instance authority or deployment secrets
- [ ] Repair runs in the same isolation boundary and quotas as any other untrusted job
- [ ] The original run remains failed; a successful repair creates a new branch and commit, then
      reports that proposed fix as structured output
- [ ] A pull request or explicit human approval is required before the repair reaches a protected
      branch. The agent cannot approve its own change.
- [ ] Attempt, token, time, and cost budgets stop repair loops. Each action is attributable in the
      audit log.
- [ ] Repository policy may forbid changes to workflow files, branch protection, tests, generated
      snapshots, or other validation surfaces during an automated repair
- [ ] Tests: the agent cannot weaken a required check, access a deploy secret, push to the protected
      branch, approve itself, or continue past its budget

## Deployments

- [x] `app/Models/Deployment.ts` and `DeploymentStatus.ts`, environments, workflow run and commit
      provenance, preview URL, and deployment history

      One deployment model rather than one per feature: a preview for a pull request and a
      production release are the same row with different environments, which is the point - "what is
      on staging" and "what is on this pull request's preview" are the same question, and a product
      answering them from two tables answers them differently within a month.

      `DeploymentStatus` is how it got there, which the row cannot carry. A deployment that went
      `in_progress` → `failed` → `in_progress` → `active` is four facts and a column keeps one of
      them - never the one being asked about, which is always "when did it go down and what did the
      job say". A rollback in particular is unreadable without it: what was restored, and from what,
      is a question about two states.
- [x] Environment protection rules, including required reviewers, wait timers, and branch policy

      All three, in `app/Actions/Workflow/environments.ts`, and the distinction between them is the
      part worth keeping: a **branch policy** refuses, while reviewers and a timer **hold**. Waiting
      for an approval that must not be given is worse than a clear no, and a reviewer asked to
      approve a deploy from the wrong branch will approve it.

      The person who *started* the run cannot be the person who approves it, which is the rule that
      makes required reviewers mean anything. The timer is swept every minute, because a timer that
      needs somebody to end it is a second approval wearing a clock.
- [x] Deployment credentials are released only to the deploy job after environment protection
      passes, never to build and test jobs

      The selection happens at the claim, which is the last point where both facts are known: the
      run's trust flag, and whether this job's gate has opened. A build job in the same run gets
      the repository's secrets and not the environment's - that separation is the whole reason
      environment-scoped secrets exist, and `tests/unit/workflow-secrets.test.ts` holds it along
      with the two cases that would quietly undo it: a fork, and a deploy job that has not been
      approved yet.
- [x] Preview deployments for non-default branches with expiry and a link on the pull request

      A preview is a deployment with a pull request on it, which is what makes expiry a fact rather
      than a feature: the thing it belongs to closed, so it is no longer current. Nothing is
      deleted - "what was on this URL last Tuesday" is a question somebody asks, and expressing "not
      running any more" by removing the history answers it with silence.

      Swept when a pull request closes *and* whenever a deployment is recorded, which is not belt
      and braces: a preview recorded by a job that finished after the merge would otherwise stay
      active forever, and a slow deploy finishing after the merge is the ordinary case.
- [ ] Gradual deployment stages with health checks, pause, promotion, and rollback expressed as
      durable steps rather than an opaque provider operation
- [x] Deployment status API and webhooks use the same actions as the workflow and interface

      One action for the lot - `list`, `create`, `update`, `deactivate`, `rollback`, `history` - and
      the interface posts to it rather than to a route of its own, for the reason the run controls
      do: a screen with a way to change state that the API does not have is a product growing a
      second, undocumented door.

      `deployment:status` is the webhook, named that rather than `deployment:updated` because the
      latter is already an audit event name and two emissions sharing one would deliver
      audit-shaped payloads to webhook receivers half the time. `action` carries the state, so one
      subscription covers recorded through rolled back.
- [x] Tests: failed checks prevent deployment, approval gates survive a restart, a fork cannot read
      environment secrets, and rollback records the version restored

      Four cases, and two of them were properties nothing had ever asserted.

      **Failed checks prevent deployment** is not a rule anybody wrote - it is the graph. A job
      whose dependency failed can never run, so it is skipped with the reason on it and the
      deployment it would have recorded is one nothing records. Worth pinning precisely because it
      is emergent: a change to how unreachable jobs settle could turn a failed build into a deploy
      that runs, and no test with "deployment" in its name would notice.

      **Approval gates survive a restart** turned out to be false, which is why the box could not
      have been ticked by reading the code. `rerunRun` cleared everything the last attempt left -
      the runner, the lease, the token, the outputs - and not `approved_at`, so a re-run of an
      approved deployment shipped again on a decision somebody made about a different attempt. The
      same failure as a green check surviving a re-run, one step further down the pipeline and with
      the machines already pointed at production. Fixed in the same commit; the gate is now asked
      again by the code that asked the first time.

      A fork and environment secrets are `tests/unit/workflow-secrets.test.ts`, which holds the
      whole ladder: a fork gets nothing, an environment's secrets wait for the gate, and another
      environment's never apply. Rollback is in `previews.test.ts`, where the restored deployment's
      status names what it put back.
