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

- [ ] **The workflow program runs as a job, not in the control plane.** A code-first workflow is
      dispatched to a runner like any other untrusted work, holding a lease. Its `step()` calls are
      authenticated API calls back to the control plane, which schedules the real work and returns
      the result. The control plane never imports, transpiles, or evaluates repository code.
- [ ] A static workflow document needs no orchestrator job at all: the graph is known before
      dispatch. The orchestrator exists only for definitions whose graph is decided at runtime.
- [ ] Both forms normalize to the same `WorkflowRun` and step rows, so the interface, API, logs, and
      restart-from-step behave identically whichever way a workflow was written. If a screen can tell
      which authoring form produced a run, the normalization is wrong.
- [ ] An organization-wide workflow runs as its own orchestrator with its own trust level, and the
      repositories it covers supply data, not code. This is the condition the old paragraph set, and
      it is the reason the orchestrator is per-run rather than per-repository.

### Durable execution

"Durable" is the load-bearing word in Cloudflare's announcement and it is not a synonym for
"retried". It means the run survives the death of whatever was executing it, resumes without
repeating completed work, and can be restarted from a named step hours later. Getting that from an
orchestrator that is itself a killable job requires a journal, and this is the Temporal and DBOS
pattern rather than something to invent.

- [ ] Every `step()` call is journaled by the control plane with a deterministic sequence identity
      **before** the work is dispatched, and its result recorded when it completes. The journal, not
      the orchestrator's memory, is the run.
- [ ] On restart the orchestrator replays: calls up to the journal head return their recorded results
      immediately without re-executing, and the first uncommitted call resumes real work. A run whose
      orchestrator was killed at step 40 does not repeat steps 1 to 39.
- [ ] Determinism rules for orchestrator code, documented and enforced rather than requested: no
      wall-clock reads, no randomness, no direct network or filesystem access. Each has an injected
      equivalent that is journaled, so a replay sees the same values it saw the first time.
- [ ] A replay that diverges from the journal, a call arriving in a different order or with different
      arguments, **fails the run loudly and names the divergence**. Silent divergence is the failure
      mode of every durable-execution system, and this repository has a written history of exactly
      that shape of bug going unnoticed for months.
- [ ] Sleeps and waits suspend the orchestrator and release its runner. A workflow waiting three days
      for an approval must not hold a lease for three days; the control plane wakes it by replay when
      the timer fires or the event arrives.
- [ ] The orchestrator's credential is scoped to its own run: it can create steps, read its own
      outputs, and nothing else. It is not a repository token and cannot outlive the run.
- [ ] An orchestrator that exceeds its own wall-time, step-count, or journal-size budget is
      terminated with a stated reason, so a runaway loop in a workflow file is bounded by the control
      plane rather than by whoever notices the bill
- [ ] Tests: kill the orchestrator mid-run and assert no completed step re-executes; a non-deterministic
      workflow detected on replay; a sleep that outlives the runner that started it; a restart from a
      named step whose inputs changed; and two orchestrators for one run, where the second is refused.

### Step results are data

Cloudflare's dashboard shows per-step inputs, outputs, wall time, and CPU time, and that is what
makes restart-from-step meaningful rather than decorative: a step can only be skipped on restart if
its result was recorded as a value.

- [ ] Steps record typed inputs and outputs as rows, not as text scraped from a log. A later step
      reading an earlier step's output is reading the database.
- [ ] Wall time and active execution time are recorded separately per step, plus queue time. A step
      that took nine minutes of which eight were queueing is a different problem from one that took
      nine minutes of work, and one number cannot say which.
- [ ] Cached and reused results are labelled as such in the interface and the API, with a link to the
      attempt that actually produced them
- [ ] Tests: a restart reusing outputs, a restart refusing to reuse them because the workflow version
      changed, and an output too large for the value store handled explicitly rather than truncated

### Snapshot caching

Their dependency cache is a snapshot of the workspace after `install`, restored into later steps,
rather than a keyed archive of a named directory. It is the better primitive for the common case,
because it needs no author to know which paths a package manager writes to.

- [ ] Snapshot a step's workspace on completion, content-addressed, and restore it as the starting
      state of dependent steps
- [ ] The snapshot key is derived from declared inputs (lockfile digest, runtime version,
      architecture, image), so a lockfile change invalidates it without anyone maintaining a key
      expression
- [ ] Keyed path caching also exists, because `actions/cache` is what a migrating workflow already
      uses and it must keep working
- [ ] Cache restore permissions prevent a fork or a lower-trust branch from writing a snapshot a
      protected branch would restore. This is listed in the execution-plane section too, and it is
      the one cache property that is a security boundary rather than an optimization.
- [ ] Snapshots are garbage collected by size and age with the policy visible before it deletes
      anything
- [ ] Tests: a snapshot restored into a parallel fan-out, an invalidated key, a poisoning attempt
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
- [ ] The check API is represented in generated OpenAPI, including request bodies, response bodies,
      error codes, pagination, and rate-limit headers
- [x] Required checks are enforced by protected branches and the merge action
- [ ] Annotations render inline in the diff on the lines they refer to. An annotation shown only in
      a log is a link nobody clicks.

  The data is ready - rows with a path, a line range and a side, served with the
  run - and this is the rendering. Left for a session that is not editing the
  diff viewer concurrently.
- [ ] Checks tab on a pull request: rollup, attempts, duration, details link, annotations, and the
      difference between missing, queued, running, failed, cancelled, and stale

  The endpoint behind it answers all of that today, including the head sha it
  reported against so the page can say "stale" rather than "green". This is the
  page.
- [ ] Webhook events for status and check transitions, with redelivery through phase 5
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

- [ ] The authoring contract is **both**, and the decision is now made rather than pending.
      [Phase 15](./15-pipelines.md) makes GitHub Actions-compatible YAML canonical, because the
      ecosystem is the product and a format nobody can leave with is a format nobody adopts. The
      constrained TypeScript API is the second front door for graphs that are decided at runtime,
      and it runs as an orchestrator job under the rules above. Both normalize to the same rows.
- [ ] Neither front door can express something the other cannot represent in the run. A capability
      reachable only from the SDK becomes a screen that renders differently depending on how a
      workflow was written, which is how two products grow inside one.
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
- [ ] Owner-managed reusable workflows can target many repositories, while a repository may also
      define its own workflows. Both are visible in the resulting run.
- [ ] A workflow can be **owned entirely by the organization and carried by no repository at all**,
      matching every repository under an owner or a selector over them. Cloudflare gets this by
      omitting `repoName` from an event binding; the value is that a security scan or a licence check
      lands on two hundred repositories without two hundred commits, and cannot be removed by editing
      a file in one of them.
- [ ] Such a workflow declares what it needs from each repository it covers (checkout, changed paths,
      metadata) and gets nothing else. It runs at the owner's trust level over the repository's data,
      never at the repository's trust level, which is what makes it safe to give it a secret.
- [ ] A typed event API can start a run directly, so a workflow is reachable from a webhook, another
      run, a scheduler, or an external system without a synthetic push
- [ ] Trigger policy records which source revision supplied the workflow. A pull request from a fork
      cannot replace a trusted workflow and gain secrets.
- [ ] Monorepository support: changed-path matching, working directory, shared setup jobs, and more
      than one deployable application per repository
- [x] Deduplicate trigger delivery so replaying a push webhook does not create a second run

      A unique index on (version, ref, head, event), not a check-then-insert: two deliveries
      arriving together would both pass a check and both insert. The insert is attempted and a
      collision is read as "somebody else already made this run", which is the right answer whether
      the somebody else is a redelivery, a retried job, or a second scheduler.

      Not cosmetic. Two runs for one commit are two builds competing to report a status for it, and
      the one that lands last wins regardless of which was right.
- [ ] Tests: branch and path filters, tag pushes, fork policy, reusable plus local workflows, an
      invalid graph, and the same event delivered twice

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
- [ ] Each step persists its inputs, output metadata, attempt count, timestamps, timeout, retry
      policy, and error before the next step becomes eligible
- [ ] Retry policies support limits, delay, and constant, linear, or exponential backoff
- [ ] Restart a whole run or restart from one named step and attempt. Earlier successful step results
      are reused only when their inputs and workflow version still match.
- [ ] Waiting steps can sleep until a time or wait for a typed external event, with a timeout. This
      is the primitive for approvals, webhooks, and other human-in-the-loop gates.
- [ ] Cancellation is cooperative first and forceful after a deadline, with the runner lease
      revoked so a disconnected worker cannot publish a late success
- [ ] Optimistic locking or transitions in one transaction prevent two schedulers from dispatching
      the same step
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

- [ ] Canonical route families under a repository: `/workflows`, `/workflows/{workflow}/versions`,
      `/workflow-runs`, `/workflow-runs/{run}/jobs`, `/logs`, `/events`, and lifecycle actions. Route
      names use `repository` and `workflow run`, not provider-specific vocabulary.
- [ ] List workflows, get one workflow, list versions, get one version, and return its normalized
      graph
- [ ] Dispatch a workflow with caller-supplied inputs and an idempotency key
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
- [ ] Pause, resume, cancel, retry from the start, and retry from a named step

      **Cancel is done; the other four are not.** Cancelling is the one that has something to act on
      while nothing executes, and it is the one the state machine exists for.

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
- [ ] Send a typed event to one waiting run, idempotently, and record who or what sent it
- [ ] The interface, CLI, webhooks, and provider integrations call the same actions as the public API
- [ ] Every endpoint has a fine-grained token requirement, generated OpenAPI, stable errors, rate
      limits, audit events, and request ids that continue into dispatched jobs
- [ ] Webhook events for run and job transitions, action required, deployment, and artifact expiry
- [ ] Tests cover every state transition, token boundaries, idempotency, stale writes, cursor
      pagination, recovery after lease expiry, and restart from a step

## Runner provider contract

Build the provider-neutral contract before a hosted runner. The first useful provider may be a
self-hosted runner process, an external CI adapter, or a Cloudflare-backed integration. ReviewOS
should not make its public workflow API describe one vendor's sandbox.

- [x] Versioned runner protocol for claim, heartbeat, log append, artifact upload, step completion,
      and cancellation acknowledgment

      Claim, heartbeat, completion and log append are implemented, reachable over HTTP at
      `/api/runner/claim`, `/api/runner/heartbeat`, `/api/runner/report` and `/api/runner/logs`,
      and held by `tests/e2e/runner-claim.test.ts`, `runner-api.test.ts` and `runner-logs.test.ts`.
      Artifact upload and cancellation acknowledgment are not, and neither is protocol versioning -
      the box is ticked for the parts that exist and says which those are.

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
- [ ] Provider capabilities are discoverable, so the scheduler can reject an impossible job instead
      of leaving it queued forever
- [ ] A provider cannot read another provider's job payloads, logs, caches, artifacts, or secrets
- [ ] External CI adapters can translate an existing provider's run into ReviewOS check runs without
      pretending ReviewOS executed it
- [ ] A documented self-hosted runner installation and upgrade path, with compatibility negotiation
- [ ] Tests against a fake provider: disconnect, duplicate claim, late completion, cancellation,
      incompatible capabilities, and a credential used against the wrong job

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
- [ ] Secrets encrypted at rest, scoped per environment and job, injected only after authorization,
      redacted from logs and structured outputs, and never exposed to untrusted fork workflows
- [ ] Dependency cache keyed by declared inputs, runtime, architecture, and lockfile digest. Cache
      restore permissions prevent a fork or lower-trust branch from poisoning a protected branch.
- [ ] Artifacts are content-addressed, size-limited, checksummed, access-controlled, and expired by
      policy. Artifacts and dependency caches are distinct resources.
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

- [ ] Setup or install step can produce a cache snapshot consumed by later steps without giving
      those steps a shared mutable machine
- [ ] Independent jobs run in parallel; dependencies and barriers are explicit in the graph
- [ ] Conditional steps can inspect declared prior results, ref, changed paths, trigger, and approved
      inputs without arbitrary access to control-plane state
- [ ] Preview deployment on non-default branches and deployment after all required checks pass,
      through the deployment model below
- [ ] Run view shows the dependency graph, current branch of execution, retries, cache hits, wall
      time, active execution time, queue time, and the workflow version
- [ ] Logs and step output can mark fields sensitive, and the API returns redaction metadata rather
      than silently omitting data
- [ ] Aggregate metrics for success rate, failure by step, queue time, duration, retry count, cache
      effectiveness, and runner utilization, filterable by owner, repository, and workflow
- [ ] Local validation and a fake-runner test harness use the same parser and transition rules as
      production
- [ ] CLI commands to validate a workflow, dispatch it, follow logs, inspect a run, cancel it, and
      retry from a step, as clients of the public API

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

- [ ] `app/Models/Deployment.ts` and `DeploymentStatus.ts`, environments, workflow run and commit
      provenance, preview URL, and deployment history
- [ ] Environment protection rules, including required reviewers, wait timers, and branch policy
- [ ] Deployment credentials are released only to the deploy job after environment protection
      passes, never to build and test jobs
- [ ] Preview deployments for non-default branches with expiry and a link on the pull request
- [ ] Gradual deployment stages with health checks, pause, promotion, and rollback expressed as
      durable steps rather than an opaque provider operation
- [ ] Deployment status API and webhooks use the same actions as the workflow and interface
- [ ] Tests: failed checks prevent deployment, approval gates survive a restart, a fork cannot read
      environment secrets, and rollback records the version restored
