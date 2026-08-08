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

- [ ] `app/Models/CommitStatus.ts`: `repository_id`, `sha`, `context`, `state` (pending, success,
      failure, error), `target_url`, `description`, `creator_id`
- [x] `app/Models/CheckRun.ts`: one named run against a commit, with queued, in-progress, and
      completed states, conclusions, timestamps, a details URL, and a summary
- [ ] Extend check runs with the reporter, a provider and external run id, an idempotency key,
      output title and text, and stable ordering for repeated attempts
- [ ] `app/Models/CheckAnnotation.ts`: one row per file and line range with level, title, message,
      and optional raw details. Annotations are relations, not a JSON array on the run.
- [ ] `app/Actions/Checks/CreateStatusAction.ts`, `CreateCheckRunAction.ts`, and
      `UpdateCheckRunAction.ts`, with field-level validation and stable error codes
- [ ] `GET` endpoints for statuses and check runs by commit, and by pull request head, returning the
      latest attempt per name plus the combined state
- [ ] Statuses roll up per commit and per pull request head. A failed check wins, an unfinished check
      is pending, and a commit with no reports is neutral rather than green.
- [ ] Fine-grained token permission for reporting checks, separate from permission to push code or
      administer a repository
- [ ] Idempotency on create and safe compare-and-update semantics so a late queued report cannot
      replace a completed attempt
- [ ] The check API is represented in generated OpenAPI, including request bodies, response bodies,
      error codes, pagination, and rate-limit headers
- [x] Required checks are enforced by protected branches and the merge action
- [ ] Annotations render inline in the diff on the lines they refer to. An annotation shown only in
      a log is a link nobody clicks.
- [ ] Checks tab on a pull request: rollup, attempts, duration, details link, annotations, and the
      difference between missing, queued, running, failed, cancelled, and stale
- [ ] Webhook events for status and check transitions, with redelivery through phase 5
- [x] Tests: a required check that never reports blocks the merge, and reporting late unblocks it
- [ ] API tests: permission isolation, idempotent retry, out-of-order updates, pagination, a stale
      pull request head, and annotations on both sides of a diff

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
- [ ] `Workflow` and immutable `WorkflowVersion` models: owner, repository scope, source commit and
      path, content digest, trigger policy, state, and the normalized step graph
- [ ] Normalize jobs, steps, dependencies, triggers, and input declarations into related rows. A
      workflow-sized JSON blob would make querying, authorization, and migrations harder.
- [ ] Validate a definition without running it, returning errors with a file location and a concrete
      fix. Invalid workflow code must never reach a runner.
- [ ] Triggers for push, pull request, tag, schedule, manual/API dispatch, and repository events,
      each with repository, ref, and path filters
- [ ] Push triggers consume the same `push:received` event emitted by phase 2. There is no second
      receive pipeline just for CI.
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
- [ ] Deduplicate trigger delivery so replaying a push webhook does not create a second run
- [ ] Tests: branch and path filters, tag pushes, fork policy, reusable plus local workflows, an
      invalid graph, and the same event delivered twice

## Durable runs and the control API

The database is the source of truth for orchestration. A runner may disappear after accepting work;
the run must remain inspectable and resumable without trusting runner memory.

- [ ] `WorkflowRun`, `WorkflowJob`, `WorkflowStep`, and `WorkflowStepAttempt` models, tied to one
      workflow version, repository, commit, trigger, actor or token, and optional pull request
- [ ] Explicit run states: queued, running, waiting, paused, cancelling, cancelled, failed, and
      succeeded, with terminal states that cannot move backwards
- [ ] A dependency graph supports sequential jobs, fan-out, fan-in, conditional edges, and failure
      policies without encoding orchestration in queue timing
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
- [ ] Recovery sweep for expired runner leases and control-plane restarts

### REST API

- [ ] Canonical route families under a repository: `/workflows`, `/workflows/{workflow}/versions`,
      `/workflow-runs`, `/workflow-runs/{run}/jobs`, `/logs`, `/events`, and lifecycle actions. Route
      names use `repository` and `workflow run`, not provider-specific vocabulary.
- [ ] List workflows, get one workflow, list versions, get one version, and return its normalized
      graph
- [ ] Dispatch a workflow with caller-supplied inputs and an idempotency key
- [ ] List runs by repository, workflow, commit, pull request, status, trigger, and time using cursor
      pagination with stable ordering
- [ ] Get a run with its jobs, steps, attempts, check rollup, trigger, workflow version, and timing
- [ ] Read logs incrementally from a cursor, with plain text and structured event representations
- [ ] Pause, resume, cancel, retry from the start, and retry from a named step
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

- [ ] Versioned runner protocol for claim, heartbeat, log append, artifact upload, step completion,
      and cancellation acknowledgment
- [ ] Runner registration, authentication, labels, capabilities, and scoping to an instance,
      organization, repository, or selected workflow
- [ ] Short-lived job credentials, bound to one attempt. Registration credentials never enter the
      job environment.
- [ ] Leases with heartbeat expiry, at-least-once delivery, and idempotent completion reporting
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

- [ ] Decide the isolation boundary first: container, microVM, a remote provider, or self-hosted
      runners only. Publish the threat model and what the boundary does not protect.
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
