# 15 - Pipelines

[Phase 9](./09-checks-ci.md) builds the machinery: a check API, a durable workflow control plane, a
runner contract, and a gate in front of ever executing somebody else's code. This phase is the
product that machinery has to add up to.

It has two competitors rather than one, and they are not competing for the same thing. Getting this
distinction wrong is the most expensive mistake available in this phase, so it goes first.

**GitHub Actions is the familiarity target.** It is what almost everyone arriving here already
knows. They have `.github/workflows/ci.yml` files that work, muscle memory for `runs-on` and
`needs:` and `uses: actions/checkout@v6`, and no appetite whatsoever for learning a second CI
language in order to leave GitHub. What they want is Actions that they own: same syntax, same
ecosystem, running on their hardware, with the reliability and the visibility that GitHub does not
give them. **If somebody cannot copy a working `.github/workflows` directory across and watch it go
green, nothing else in this phase matters.**

**Buildkite is the capability target.** It is what Actions turns into when a company outgrows it,
and it is the reference for the engine underneath: concurrency groups, dynamic step generation,
runner fleet management, signed steps, test intelligence. Buildkite sells to people who already hit
the ceiling Actions has.

So: **Actions syntax on the front, Buildkite-grade engine underneath.** Those are compatible goals,
not a compromise between two, and the rest of this file is written on that assumption. Where the two
conflict, Actions compatibility wins on the authoring surface and Buildkite wins on what the engine
can do once a workflow is parsed.

## Why the engine is modelled on Buildkite

Buildkite's model is hybrid: **they run the control plane, you run the compute.** Their agent is a
small cross-platform binary that you install on your own machines; it polls their API for work, runs
it on your hardware, inside your network, with your secrets, and reports back. Buildkite never sees
the source code, never holds the secrets, and never executes anything.

That is the shape phase 9 arrived at independently, from the opposite direction. Phase 9 splits the
durable control plane from the execution plane and puts a security review in front of the second one
because running untrusted repository code on instance-managed infrastructure is a separate project
with its own threat model. Buildkite made that same split a business model.

Which means the expensive, dangerous half of what Buildkite sells is the half we are deliberately
not building yet, and the half that is genuinely hard to copy is a control plane, an API, and a set
of screens.

| | GitHub Actions | Buildkite | ReviewOS |
|---|---|---|---|
| Source | Closed, runner is open source | Closed, agent is open source | Open source, whole thing |
| Control plane | Theirs. Enterprise Server is the only self-hosted path | Theirs, no self-hosted option | Yours, on your box |
| Compute | Theirs, or your self-hosted runners | Yours, or their hosted agents | Yours, or a provider you choose |
| Priced on | Compute minutes and seats | Seats, compute minutes, managed tests | Nothing |
| Forge | It is the forge | None. Bring GitHub, GitLab, or Bitbucket | It is the forge |
| Authoring | Workflow YAML, huge ecosystem | Their own YAML and plugins | Workflow YAML, their ecosystem |
| Where a result lands | The pull request | A dashboard, plus a status on your forge | The review surface, natively |

The last row is the one that matters and the only one a competitor cannot copy by changing a price.
Buildkite has to report into somebody else's pull request through a status API, so its richest
output, the annotations, the flaky test verdict, the artifact, the log, lives on a page in another
tab. Actions has the pull request but spends it on a check summary and a link to a log viewer. Here
it lands on the diff, on the line, in the review. Phase 9 already states the rule ("an annotation
shown only in a log is a link nobody clicks"); this phase is where it gets paid off.

## Vocabulary, decided once

Good news first: **phase 9's chosen names are already Actions' names.** A workflow is a workflow, a
run is a run, a job is a job, a step is a step, and the thing that executes them is a runner. Nobody
coming from Actions has to relearn a noun. The table below exists because Buildkite calls all five
of those something else, and the Buildkite word must not creep in as a synonym.

| GitHub Actions | Buildkite | Here | Why |
|---|---|---|---|
| workflow | pipeline | **workflow** | Phase 9 named it, and it matches Actions. `Workflow` plus immutable `WorkflowVersion`. |
| workflow run | build | **workflow run** | "Build" implies compilation. Most runs do not compile anything. |
| job | job | **workflow job** | Same word everywhere. |
| step | step | **workflow step** | Same word everywhere. |
| runner | **agent** | **runner** | Actions wins. `agent` is taken: in [phase 12](./12-api-and-agents.md) an agent is a coding agent with a token, and that is the more valuable meaning. |
| runner group | cluster | **runner pool** | A group of queues and the workflows allowed to use them. Neither name was good; this one says what it is. |
| runner label | queue plus tags | **queue plus tags** | Buildkite splits these and the split is useful. `runs-on` maps onto it. |
| matrix | build matrix | **matrix** | Same word. |
| (no equivalent) | meta-data | **run metadata** | `meta-data` with a hyphen is a Buildkite spelling, not a word. |
| (no equivalent) | test suite / run / execution | **test suite / test run / test execution** | Unchanged from Buildkite. |
| annotation | annotation | **annotation** | Same word, and it is already a phase 9 model. |
| check run | (reports as one) | **check run** | Phase 9 owns it. |

- [x] A test that greps routes, actions, models, and generated OpenAPI for `pipeline`, `build`,
      `agent`, and `meta-data` used in the Buildkite sense, and fails. This is the same class of rule
      as "never repo", and the same reason: a synonym that lands once is permanent.

      `tests/unit/pipeline-vocabulary.test.ts`, checked against the generated document, the model
      names and the action names - not against comments, because prose *about* Buildkite is how the
      decision gets explained. It also asserts the Actions nouns are the ones in use, since a guard
      that only bans things passes on an empty codebase.

---

## GitHub Actions compatibility

This section is the front door, and it is load-bearing for adoption in a way nothing else here is.
Phase 9 leaves the authoring contract open ("a constrained TypeScript API, a declarative format, or
both. Document the portability and security costs before choosing ecosystem compatibility"). **This
phase closes that box: the canonical format is Actions-compatible workflow YAML.** The reasoning is
written down here so it does not get relitigated:

- The ecosystem is the product. `actions/checkout`, `actions/setup-node`, `actions/cache` and a few
  thousand others are what a workflow is actually made of. A format that cannot run them starts at
  zero no matter how good it is.
- The syntax is already an industry default. Gitea and Forgejo both chose compatibility over
  invention, and it is the single reason a repository can move to either of them in an afternoon.
- Everything Buildkite can express, this file has to express anyway. Almost all of it fits as
  additive keys on a familiar shape rather than as a different language.
- A typed authoring SDK stays on the list, further down, but it emits the same normalized graph. It
  is a second front door, not the only one.

### The bar

- [ ] Copy `.github/workflows/` to `.reviewos/workflows/`, push, and a normal repository's CI runs
      green with no edits. This is the acceptance test for the whole section, run against real
      workflow files from real repositories rather than ones written to pass.

      **The copy is read now**, held by `tests/e2e/workflow-push.test.ts`: push
      `.reviewos/workflows/ci.yml` and it registers, produces a version, and starts a run. What is
      not done is "green", which needs the execution plane, so the box stays open. `.reviewos`
      **wins outright over `.github` rather than merging** - merging runs every job twice the day
      somebody forgets to delete the original, and "which of these two files ran" is a question
      nobody should have to ask.
- [x] `.github/workflows/` is also read directly, so a mirrored repository ([phase 13](./13-mirroring.md))
      runs its existing workflows without a commit that would have to be undone to go back.

      Read from the trusted ref with plumbing, nothing checked out. A repository that arrives with
      workflows registers them on its first push here, and one that later adds `.reviewos/workflows`
      switches over without the two ever running together.

      Testing this turned up an older bug with nothing to do with directories: **a workflow whose
      file was deleted stayed `active` forever**, and dispatch reads `state = 'active'`, so a
      repository that removed its CI kept starting runs from a definition that was no longer in the
      tree. A file that is gone now retires its workflow, in a `removed` state kept apart from
      `disabled` - a workflow somebody switched off has to stay off when the file comes back, and
      one state for both would let a revert resurrect it.
- [x] A conformance suite pinned to a corpus of widely used public workflows, run in CI, reporting
      which constructs pass, which are unimplemented, and which are refused on purpose. The report is
      published. Silence about a gap is how Gitea's ignored `concurrency:` surprised people.

      The corpus is in `tests/fixtures/conformance/` - workflows in the shapes people actually
      write: a version matrix, a release on a tag, a container build with services, a reusable
      workflow, a nightly with a composite action, an issue labeller. Every one is parsed on every
      test run, and a failure names the file and the errors rather than a count.

      The report is [`docs/conformance.md`](../conformance.md), generated from a table that is the
      source of truth, with a drift test: a key whose behaviour changes without its line changing
      fails rather than misleading somebody quietly for a year.

      It caught its first bug immediately, which is the argument for having it: **a workflow
      triggered only on `issues` was refused as naming no event at all.** The trigger had been
      implemented, dispatched and tested, and left out of the one list that decides whether a file
      is valid - so a labeller, the second thing anybody automates, could not be registered.
- [x] Where behavior deliberately differs from GitHub, it is documented per key with the reason, and
      the parser emits a warning naming the difference rather than quietly doing something else.

      **One table drives all three.** The published page, the conformance test and the parser's
      warnings read the same data, which is the only arrangement where a difference cannot be
      documented one way and behave another - and where adding a divergence without writing down its
      reason is impossible rather than merely discouraged. It lives in the domain rather than under
      `app/Docs/`, because it is data that happens to be published rather than documentation that
      happens to be checked.

      A workflow using a key that differs, or one that is not implemented yet, carries the warning
      on its version and shows it on the workflows page in the published table's own words. A
      workflow that fails to parse carries none: its author has errors to fix, and "by the way,
      `container:` behaves differently here" underneath them is noise on top of a problem.

      An ordinary `ci.yml` gets exactly two notes - `permissions` defaults differently here, and
      `fail-fast` is stored but not acted on yet - which is the standard this box asks for: both are
      things somebody would otherwise discover by watching a run behave unexpectedly.

### Workflow syntax

- [ ] `on:` triggers: `push`, `pull_request`, `pull_request_target`, `issues`, `issue_comment`,
      `release`, `schedule`, `workflow_dispatch`, `workflow_call`, `workflow_run`, `repository_dispatch`,
      with `branches`, `branches-ignore`, `tags`, `paths`, `paths-ignore`, and `types` filters

      **The push filters work end to end now**, which they did not: `paths:` and `paths-ignore:`
      were parsed, stored, consulted - and handed an empty list of changed files, because the
      dispatcher never read what the push touched. Empty reads as "no information, so run", so both
      filters did nothing at all and a documentation-only push started the whole test suite. One
      `git diff --name-only` per updated ref answers it, with a new branch read as what its own
      commit introduced rather than as every file in the repository, and a push past 5,000 files
      answered as unknown rather than truncated.

      The negative forms are stored and consulted too. `branches-ignore` is not `branches`
      inverted - it changes the default, so a workflow with only an ignore list runs everything it
      does not name, and `tags-ignore` counts as naming tags or a workflow written to run on every
      tag but the release ones would never run on any. `paths-ignore` excludes a push only when
      *every* file it changed is ignored: one source file among a hundred documentation changes is
      still a source change.

      **`pull_request` starts runs now**, which it did not: the trigger was stored on every version
      and read by nothing, so a workflow that named it never ran - on a forge built around review,
      which is the wrong trigger to be missing. `DispatchPullRequestRuns` listens on `pr:opened`,
      `pr:synchronized` and `pr:ready_for_review`, with Actions' three default activity types when a
      workflow names none, drafts skipped unless the workflow asks for `ready_for_review`, and
      `branches:` filtering on the *base* branch - a workflow saying `branches: [main]` means "when
      something is proposed into main", not "when the contributor's branch is called main".

      Two things the fork policy decides, held by tests rather than by care:
      **the definition comes from the base branch** - the dispatcher reads registered versions and
      never parses anything from the head - and **a fork's run is recorded untrusted**, decided by
      the head repository rather than by the branch name or who pushed.
      `pull_request_target` is asked as its own question, so a workflow naming only `pull_request`
      can never be started as the trigger behind the published secret-theft write-ups.

      **`schedule` dispatches too**, swept every minute by `DispatchScheduledWorkflowsJob`. A sweep
      rather than a timer armed per workflow: a timer has to survive a restart and a redeploy, and a
      sweep reads what is actually due, so a process that dies between two minutes loses only the
      minutes it was dead. Runs are created on the default branch, the way Actions does it - a cron
      on a feature branch would be a job nobody is watching, from a definition nobody reviewed.

      What stops a cron firing twice is a **compare-and-swap on `workflows.last_scheduled_at`**, not
      the run table's unique index: a scheduled run repeats at the same ref and the same commit by
      design, so the index cannot tell a second night from a duplicate. Two sweeps racing means one
      of them updates nothing and dispatches nothing.

      A workflow that has never been swept records the clock and waits for the next occurrence
      rather than firing immediately, and a sweep after downtime looks back at most six hours - an
      instance that was off for a week should produce one catch-up run, not seven.

      **`issues`, `issue_comment` and `release` dispatch too**, which was wiring rather than
      anything new: this instance has emitted those events since
      [phase 5](./05-notifications.md) and nothing had ever read them for CI. Labelling a new issue
      and publishing on a release are the two things people automate first.

      Their filters are `types:` and nothing else - there is no branch on an issue and no path on a
      release. `issues` and `issue_comment` take Actions' defaults (every type, and
      created/edited/deleted). **`release` deliberately defaults to `published` only**, where
      Actions defaults to every type: a draft release starting a deployment is the surprise nobody
      wants, and `published` is what people mean when they write `on: release`. Naming the types
      opts back in.

      The subject goes in the run's ref - `refs/heads/main#issues/7/opened` - because the redelivery
      index is on (version, ref, head, event) and every issue event in a repository shares a head
      commit. Without it the second issue would look like the first one redelivered.

      The rest are recorded as recognised-but-not-dispatched.
- [x] `jobs:` with `needs:`, `outputs:` (**resolved by the runner and handed to dependent jobs as
      `needs.<job>.outputs.<name>`, alongside `needs.<job>.result`**), `if:` (**decided at dispatch now** - a job whose condition is false is
      `skipped` from the moment the run exists, with the reason on the row, rather than queued and
      quietly ignored), `strategy.matrix` including `include`, `exclude`, `fail-fast`,
      and `max-parallel`, plus `continue-on-error`, `timeout-minutes`, and `outputs`

      **A matrix is now four jobs in a run rather than one**, which is the half that was missing:
      the expansion existed in the parser and was dropped on the way to the version, so a matrix of
      four produced a single job. Each combination is its own `workflow_jobs` row, named the way
      Actions names them - `test (ubuntu-latest, 20)` - and carrying its own values for a runner to
      inject and a screen to show. They succeed and fail separately, which is the point: a person
      looking at a failed run needs to see *which* combination broke.

      **The expansion itself**, in `app/Actions/Workflow/matrix.ts`: the cartesian
      product with the last key varying fastest, `exclude` applied *before* `include` so a workflow
      that excludes a combination and includes it back keeps it, an `include` entry merged into
      every combination it fits without overwriting and appended as its own job when it would, and
      a 256-job ceiling that says what to do rather than starting 400 jobs. Object values compare by
      shape, because `{ node: 20 }` as a matrix value is idiomatic and comparing by identity makes
      every `exclude` miss.

      **`needs:` means every combination**, which is where a real defect lived: the graph kept its
      jobs in a map keyed by name, and a matrix puts four rows under one name, so the map held
      whichever combination was written last. A matrix whose first combination failed and whose last
      succeeded unblocked the deploy that the failure existed to stop. It also meant only one row of
      a dependent matrix was ever unblocked, leaving the rest in `blocked` until somebody cancelled
      the run. The graph groups by name now and aggregates, and the same rows carry their ids so the
      write moves the job it decided about rather than the first one with that name.

      **`fail-fast` works**, and defaults to true the way Actions does: one combination failing
      cancels the queued siblings and asks the running ones to stop, with the reason on each row -
      a cancelled job with nothing on it reads as "somebody pressed cancel", which is the wrong
      thing to go looking for. `fail-fast: false` leaves them alone, which is the only reason to
      write it.

      **`max-parallel` is honoured at claim time**, by counting the combinations already running.
      That is a check rather than a lock, stated plainly here and on the conformance page: two
      runners polling in the same instant can both take the last slot. Making it exact needs a lock
      held across every claim on the instance, which is a cost paid by every job to make one key
      precise.

      **`continue-on-error` at job level** does what Actions does and it reads strangely until you
      need it: the job still shows as failed, the run is not failed by it, and the jobs that
      `needs:` it are told `success`. The run page says so on the row, because a red job on a green
      run is otherwise a puzzle. The alternative - treating it as fatal - is what makes people
      delete the flaky suite instead of watching it.

      **`timeout-minutes` is enforced twice**, and the two halves fail differently. The runner
      checks between steps and can say *which step* the time went into; the control plane sweeps a
      job that overran whether or not its runner is still listening. Six hours when the workflow
      does not say, which is Actions' default and exists so that nothing runs forever rather than
      as an opinion about how long a job should take.

      One thing the sweep needed on the way: it recomputed only the run's own state, so a job it
      force-cancelled left its dependants in `blocked` and the run never reached a terminal state at
      all - a pull request holding on work that ended an hour ago. The graph settler is shared with
      the reporter now, because two things move a run and two copies of "what does this failure
      unblock" is how they end up disagreeing about the same run.
- [x] `runs-on:`, accepting a single label, a list of labels, and a `group`/`labels` object, mapped
      onto queues and runner tags. Complex `runs-on` expressions are in scope; Gitea's not supporting
      them is a known migration blocker.

      All three forms parse, with the group flattened onto the labels a runner has to carry because
      a pool is a label here. The object form had been refusing a valid workflow outright - the
      parser read `runs-on` as a string or a list and a mapping came back empty, which reported as
      "does not say what it runs on". It had no test; it has one now. Expressions inside `runs-on`
      are still text, because evaluating them needs the expression engine.
- [x] `steps:` with `run`, `uses`, `with`, `env`, `id`, `if`, `name`, `shell`, `working-directory`,
      and `continue-on-error`.

      All of them are read and stored. `shell` is null when the step does not say, which means
      *inherit* rather than bash - see `defaults:` below. `continue-on-error` is only a literal
      `true`: an expression there needs the expression engine, and reading `${{ inputs.soft }}` as
      truthy text would make every such step unfailable, which is the dangerous direction to guess
      in.

      **`if` is evaluated now**, by the runner rather than at dispatch - a condition reading
      `steps.build.outputs.changed` cannot be answered before the step called `build` has run, so it
      cannot be answered when the run is created at all. `steps.<id>.outputs`, `.outcome`,
      `.conclusion`, `job.status`, `needs` and `always()` all work, and a step whose condition is
      false says so in the log rather than vanishing.

      Two consequences worth stating. **A failing step no longer ends the job's steps**: a step with
      `if: always()` or `if: failure()` exists to run after a failure - uploading logs, posting a
      comment, tearing down a deployment - and stopping at the first failure skips exactly the steps
      written for that moment. The job still fails; the file gets to say what happens next.

      And **`${{ }}` in a `run:` is filled in before the shell sees it**, which is what makes
      `echo "${{ steps.build.outputs.name }}"` work rather than producing "bad substitution". That is
      also the well-known injection shape - a value spliced into a shell command can end it and
      start another - and Actions has the same property by design: the value comes from this run's
      own steps and event, quoting is the author's job exactly as it is there, and anything
      unresolvable is left as written rather than becoming an empty string that silently changes what
      the command means.
- [ ] `container:` and `services:` on a job, with `image`, `env`, `ports`, `volumes`, `options`, and
      health-checked service startup before the first step

      Still not implemented, and still refused at run time with a reason rather than run on the
      host. What *has* changed is that the common case behind `container:` now has an answer: a
      `container: node:20` is usually asking for a toolchain rather than for isolation, and a pantry
      dependency file in the repository gets that with no image, no registry and nothing to bake -
      the runner installs what the file names and puts it on `PATH` for every step. See
      [extensions](../extensions.md).

      That is deliberately not called container support. Isolation is a separate machine, which an
      autoscaled fleet already gives you one of per job; `services:` needs something that can start
      and health-check a database next to a job, and pantry has services but wiring them per job is
      its own piece of work.
- [ ] `concurrency:` with `group` and `cancel-in-progress`, at workflow and job level. Actions has
      this and Gitea ignores it; the Buildkite concurrency engine in this file implements it properly
      rather than partially.

      **`cancel-in-progress` works.** A run records the group it belongs to, resolved against its
      own event rather than stored as written, and a new run in the same group moves the ones it
      replaces to `cancelling`. Push twice and the first run stops, which is the whole reason people
      write the key.

      `cancelling` rather than `cancelled`: a run already handed to a runner has to be told and has
      to acknowledge ([phase 9](./09-ci.md)), and the control plane does not get to claim an outcome
      it cannot observe.

      Two decisions worth keeping:

      - **A group whose expression cannot be resolved is no group at all.** Only the closed set of
        context values dispatch actually knows is substituted - `github.workflow`, `github.ref`,
        `github.ref_name`, `github.sha`, `github.head_ref`, `github.base_ref`, the pull request
        number. Anything else (a `||` fallback, `hashFiles`, an input) leaves the template
        unresolved, and an unresolved template would be the same literal string for every run of
        that workflow - grouping runs that should be independent and cancelling somebody's build
        under `cancel-in-progress`. Grouping too little only wastes runners.
      - **A group is not namespaced by event**, matching Actions. `group: ${{ github.ref }}` is
        written precisely so a branch's push run and its pull request run do not both run.

      **Job-level `concurrency` works too**, which is the case the workflow level cannot express: a
      workflow whose runs may overlap, with one deployment job inside it that must not. A job's
      group is resolved against its run *and its matrix combination* - `${{ matrix.node }}` is
      available - because a matrix job whose group names none of its values puts every combination
      in one group, and under `cancel-in-progress` they then cancel each other. Actions behaves the
      same way and does not withhold the values, so neither does this; there is a test saying so, so
      that nobody "fixes" it by namespacing silently.

      A superseded job moves to `cancelling`, and a sibling job that asked for no group is untouched.

      What is left is the other half: `cancel-in-progress: false` should *queue* the second run
      behind the first, and that is not a state a run can enter on its own - something has to
      release the group when the first finishes, which is the execution plane. The box stays open
      for that.
- [x] `permissions:` on the workflow and per job, mapped onto the fine-grained token permissions from
      [phase 1](./01-foundation.md#access-tokens), defaulting to read-only.

      The file speaks GitHub's vocabulary and this instance has its own, so the names are
      translated rather than adopted: `pull-requests` onto `pull_requests`, `statuses` onto the
      `checks` scope, `repository-hooks` onto `webhooks`. All three shapes are read - the mapping,
      `read-all` / `write-all`, and `{}`, which is a workflow asking for nothing on purpose and is
      not the same as the key being absent.

      **The default is read-only and it does not depend on a setting.** Actions' default varies with
      an organization option, which is a footgun this instance declines to reproduce: a workflow
      that says nothing gets a token that can read the repository and no more, on every instance.

      Two decisions the tests hold. **A job's block replaces the workflow's rather than adding to
      it** - merging is the friendlier reading and the wrong one, since it hands a job powers its
      author took away. And **neither blanket form grants `administration`**, which is the scope
      that can change branch protection and delete the repository; a workflow that needs it names
      it.

      A permission this instance has no scope for - `packages`, `id-token`, `deployments` - is
      **recorded and returned** rather than dropped, because a token that silently grants nothing is
      a workflow that fails at the far end with no explanation. The run detail reports the scopes, the
      level of the file that decided them, and what was refused.

      Nothing mints a token yet; that is the execution plane, and by the threat model it happens
      after the fork check - a fork's pull request gets no write-scoped token whatever its workflow
      declares.
- [x] `defaults:` including `run.shell` and `run.working-directory`, at workflow and job level,
      with steps inheriting.

      Three levels, narrowest wins, each key falling through on its own - a step that sets only
      `working-directory` still inherits the shell. The run detail reports what a job's steps
      inherit and from which level.

      One difference from `env:` is worth keeping in mind: **nothing declared anywhere means the
      runner decides**, and that is reported as `runner` rather than filled in with `bash`. The
      answer depends on the platform the runner is on, which is knowledge the control plane does not
      have; inventing a default here would also be impossible to tell apart from a workflow that
      asked for it. An empty string is treated as a mistake rather than an answer, so
      `shell: ''` falls through to the level that meant something.
- [x] `env:` at workflow, job, and step level with Actions' precedence order.

      Stored at all three levels rather than merged at parse time, because the precedence is a rule
      a reader has to be able to check and a merged blob cannot say which level a value came from.
      `app/Actions/Workflow/env.ts` resolves it - narrowest wins, names merge and values do not -
      and `explainEnv` answers the question the merge cannot: *why did my step see `staging` when
      the job says `production`*. The run detail returns that per job, with the level in effect and
      the ones it beat.

      The cases worth pinning are the ones people get wrong: a name with no value is an empty
      string rather than absent, because a step testing `[ -z "$THING" ]` should see one; an empty
      value at a narrower level still wins, since blanking a variable is a real thing people write;
      and names are compared exactly, so `Path` and `PATH` are two variables.

      Step-level `env` is stored and applied when a step runs, so the job's answer stays one answer
      rather than one per step. Secrets are not in this and never will be: they are resolved at
      injection time, after the fork check, and never written to a row.
- [x] `secrets:` on `workflow_call`, including `inherit`.

      Declared by the called workflow, passed by the caller, and **recorded rather than resolved**.
      `inherit` stays the word it was written as: expanding it here would decide what a run may
      read before the fork check has happened, and by [the threat
      model](../ci-threat-model.md) that decision belongs at injection - a fork's pull request gets
      no secrets whatever any `secrets:` line says.
- [ ] `workflow_dispatch` inputs of every type Actions supports (string, boolean, choice, environment)
      and the interface form generated from them.

      **The trigger works, the inputs are checked, and the form is generated.** A repository's
      workflows have a screen now (`/{owner}/{repository}/workflows`) which answers the question the
      runs list cannot: *why did nothing happen at all*. A workflow whose file was deleted, one
      somebody disabled, one whose only trigger is an event this instance does not dispatch, and one
      that failed to parse all look identical from the runs list, which shows nothing in every case.
      Each reason is written out in words - including `unsupported_events`, recorded at parse time
      for exactly this and never shown anywhere until now - and the dispatch form is built from the
      inputs the workflow declared, posting to the same public action the API and the CLI use. `POST /api/repos/workflows/dispatch` starts a run from a workflow that names
      `workflow_dispatch`, under a new `workflow:dispatch` ability (write, mapped to `checks:write`)
      - starting a run spends the instance's runners, so seeing a workflow is not permission to run
      it.

      All four types are read, in the order written, because a form follows that order. Checking
      them is most of the value: a choice outside its options, a boolean that is not one, a required
      input with nothing to fall back on, and **an input the workflow never declared** are all
      refused with every problem listed at once rather than the first. That last one is refused
      rather than dropped on purpose - silently discarding `enviroment: production` is how somebody
      spends an afternoon wondering why nothing happened.

      A default satisfies `required`, matching Actions: `required: true` with a default means "this
      always has a value", not "the caller must always type one". The run records the values it ran
      with, defaults filled in, because "the default applied" is otherwise invisible.

      One thing this turned up: the run dedupe index refused a second manual dispatch, having read it
      as a redelivered event. It is partial now (`WHERE event <> 'workflow_dispatch'`) - a manual run
      is not a delivery, and pressing the button twice means two runs.
- [x] `environment:` on a job, wired to deployment environments and their protection rules,
      including required reviewers and wait timers

      The key was parsed, stored, and honoured by nothing - which is worse than refusing it, since
      the workflow says the deploy is protected, the run screen shows an environment, and everybody
      involved believes the opposite.

      **The rules live on the repository, never in the file.** A rule a workflow author can edit is
      a rule they can remove on the afternoon they are in a hurry, so naming an environment takes
      push access and configuring one takes `repository:settings`.

      Three rules, each a decision a test holds. Required reviewers, where **the person who started
      the run may not approve it even when they are on the list** - a reviewer who can approve
      their own deploy is a rule that reads as two people and behaves as one. A wait timer that
      releases itself, measured from when the job was first held rather than from now (measuring
      from now restarts the clock every sweep, so the wait never ends) or from the run's start (a
      long build would eat the window). And a branch policy that **refuses** rather than holds,
      because a reviewer repeatedly asked to approve deploys from the wrong branch will eventually
      approve one.

      An environment the repository has not configured runs normally: `environment: staging` with
      no `staging` is documentation, and refusing it would break far more workflows than it
      protects.

      Found while wiring it: the settler's ready-loop hands the *graph* row to each branch, and the
      graph row carries no settings - so the first version read `undefined` and ran every protected
      deploy. `tests/e2e/workflow-environment-gates.test.ts` is what caught it.

      Scoped secrets are still not built, and the docs say so: there is no secret store at all yet,
      so "a deploy credential released only after approval" is not something to claim.
- [ ] Reusable workflows via `uses:` at job level, local and cross-repository, with inputs, secrets,
      and outputs, and the called workflow's jobs shown in the run rather than collapsed to one box.

      **Local calls work.** A job that `uses: ./.reviewos/workflows/build.yml` becomes that
      workflow's jobs, copied into the same run and named `build / compile` the way Actions names
      them, so one run still shows everything that happened. The calling job is not a row of its
      own: it has nothing to run. Inputs are checked against what the called workflow declares,
      reusing the `workflow_dispatch` validator rather than growing a second one that would have to
      agree with it forever.

      Three refusals, each recorded as a skipped job carrying its reason rather than as silence,
      because a run that quietly misses half its pipeline is the failure people spend an afternoon
      on:

      - **A workflow that did not say `workflow_call` cannot be called**, even though its jobs would
        copy in perfectly well. Calling one runs a pipeline its author never offered as an
        interface.
      - **A cycle** is caught by the trail rather than by the depth limit, which would otherwise let
        one go round three times first - and three copies of a pipeline is worse than none, since
        somebody has to work out which was real.
      - **Nesting deeper than four levels** stops there, the same limit Actions has and for the same
        reason a stack has one.

      What is left is cross-repository calls, which need a policy about which repositories may be
      called and a way to read a version this instance may not hold. Refused with a clear reason for
      now rather than half done. Outputs are stored as written and are not yet readable by a caller,
      which needs the jobs to have run.

      Found while writing the test for this: **the parser refused every reusable-workflow caller**,
      because a calling job has no `runs-on` and the validator required one. Its jobs run on
      whatever the called workflow says, which is the point of calling it.
- [ ] Composite actions, JavaScript actions, and Docker actions, all three, because a repository's
      dependency tree contains all three whether or not its own workflows do

### Expressions and contexts

- [x] `${{ }}` expression evaluation: operators, precedence, and the function set (`contains`,
      `startsWith`, `endsWith`, `format`, `join`, `toJSON`, `fromJSON`, `hashFiles`).

      A lexer, a Pratt parser and an evaluator in `app/Actions/Workflow/expression.ts`. Not a
      regular expression, and never `new Function`: an expression comes out of a file in a
      repository, which on a public instance means it comes from a stranger, and evaluating it with
      the host language's evaluator would hand that stranger this process.

      GitHub's semantics are copied deliberately, including the parts that look wrong, because a
      workflow that behaves differently here is one somebody has to debug twice: comparison coerces
      to number so `'' == 0` is true, strings compare without case, `&&` and `||` return operands
      rather than booleans (`inputs.name || 'default'` is the fallback idiom), an unknown property
      is null rather than an error, and an empty object is truthy.

      `hashFiles` is **refused rather than answered**: it reads a checked-out tree this side does
      not have, and a fake digest silently restores the wrong cache - a bug people chase for days.

      Property reads are own-properties only. `thing.toString` is null, not the host's function;
      the grammar cannot call anything outside the closed set, but a value that leaks a host
      function into a comparison is the first half of an escape.
- [x] Status functions `success()`, `always()`, `cancelled()`, `failure()`, with Actions' rule that
      an `if:` without one implies `success()`.

      They read the job's status rather than computing anything, which is why `success()` with
      nothing yet reported is true: it is the default behaviour written out.
- [ ] Contexts: `github`, `env`, `vars`, `job`, `jobs`, `steps`, `runner`, `secrets`, `strategy`,
      `matrix`, `needs`, `inputs`. A `reviewos` context is the canonical name and `github` is an
      alias, which is the approach Forgejo took and it works.

      **Eight of the twelve are readable now**: `github` (with `actor`, `workflow`, `head_ref`,
      `base_ref`, `ref_name`, `ref_type`, `run_id`, `run_number`, `run_attempt`, `repository_owner`,
      `server_url`, `api_url`, `event` and `event_path`), plus `env`, `job`, `steps`, `needs`,
      `matrix`, `inputs` and `runner`. `reviewos` is the same object under this forge's own name.
      `secrets`, `vars`, `strategy` and `jobs` are not populated, and an expression reading one is
      left as written rather than quietly becoming an empty string.

      They are built in one function rather than assembled per call site, because a `run:` and a job
      output that interpolate the same expression have to see the same value. Half of `github` was
      being read by the expression evaluator and sent by nothing: `github.workflow` resolved to an
      empty string on every run, which is the kind of defect that looks like a workflow bug.
- [x] The expression evaluator is sandboxed and total: no host access, no unbounded evaluation, and a
      documented failure mode for an expression that cannot be resolved.

      The failure mode is written down and tested in both places it matters. **An `if:` that cannot
      be evaluated does not run the job**, because the other direction deploys somebody's code
      because their condition had a typo; the reason is recorded on the job, since a skipped job is
      the one outcome with nothing else to look at. **An interpolation that cannot be evaluated
      stays as written**, rather than becoming an empty string somebody has to explain.
- [x] Tests: an expression suite ported from Actions' own documented examples, including the ones
      that are surprising

      `tests/unit/workflow-expression-parity.test.ts`, and it is deliberately the *documented*
      examples rather than more cases of our own: a compatibility claim is worth what somebody can
      check, and the cheapest check is to take the expressions out of GitHub's documentation and
      assert what the documentation says they produce. Nobody's workflow breaks on `1 == 1`.
      Workflows break on `'' == 0` being true, on `'ABC' == 'abc'` being true, on `&&` returning an
      operand rather than a boolean, and on `format('{{Hello}}')` meaning something.

      **It found a real one immediately.** An `if:` that names no status function carries an implied
      `success() &&`, and a step with no `if:` at all is exactly that case - this instance applied
      neither, so every condition was evaluated as though nothing had failed. That was invisible
      while the runner stopped at the first failing step, and became load-bearing the moment it
      stopped stopping: without the rule, a job whose build broke went on to run its deploy step.
      The reason is said on the skipped step rather than left for somebody to work out from the
      file.

### The runner protocol Actions expects

This is where compatibility is actually won or lost. A workflow file that parses but whose steps
cannot talk back to the runner is a workflow that fails on its second line.

- [x] Workflow commands on stdout: `::error::`, `::warning::`, `::notice::` with `file`, `line`,
      `col`, and `endLine`, plus `::group::`, `::endgroup::`, `::debug::`, `::add-mask::`,
      `::add-matcher::`, and `::stop-commands::`
- [x] `::error file=...,line=...::` becomes a check annotation, which becomes a comment on the diff.

      The whole path is held by a test: a step prints the line, the runner parses it, the annotation
      endpoint records it against a check named for the *job* - "greet failed" is useful, "CI
      failed" is what the reader already knew - and the diff renders it in the gutter. That is the
      reason to implement the format exactly rather than approximately: every linter, compiler and
      test runner people already use has an Actions reporter, and honouring it means those reporters
      work here unchanged.

      Read defensively at both ends. A path is a string a step printed rather than a file this
      instance verified, and the count is capped at two hundred in the runner *and* in the endpoint,
      because the runner is the part this instance does not control. Annotations replace rather than
      append, so a retried job does not leave two of everything on one line.
      line. This is the sentence where the Actions ecosystem and this project's whole premise meet,
      and every linter, compiler wrapper and test reporter already emits it.
- [x] File-based protocol: `GITHUB_OUTPUT`, `GITHUB_ENV`, `GITHUB_PATH`, `GITHUB_STATE`, and
      `GITHUB_STEP_SUMMARY`, with the multiline delimiter form, under both `GITHUB_*` and
      `REVIEWOS_*` names
- [x] Step summaries render as markdown on the run and, where they belong to a check, on the pull
      request

      A step summary is the one part of a run written *for a reader* rather than printed for a log:
      the table of what was built, the diff of what changed, the three numbers somebody actually
      wanted. It was being collected, filed on the check, and shown nowhere on the run - a page with
      ten thousand lines of output and not the paragraph the job wrote has the two the wrong way
      round. On the pull request it was printed as text, so a markdown table arrived as literal
      pipes and dashes.

      Rendered through the same constructed-HTML renderer as an issue body, because it comes from
      whoever can push to the repository: nothing is sanitized, the HTML is built tag by tag from a
      closed set. Headings get a per-job id prefix, since a summary titled "files" must not be able
      to take the id the page's own tab uses.
- [x] The default environment variable set: `GITHUB_REPOSITORY`, `GITHUB_SHA`, `GITHUB_REF`,
      `GITHUB_REF_NAME`, `GITHUB_HEAD_REF`, `GITHUB_BASE_REF`, `GITHUB_WORKSPACE`, `GITHUB_ACTOR`,
      `GITHUB_RUN_ID`, `GITHUB_RUN_NUMBER`, `GITHUB_RUN_ATTEMPT`, `GITHUB_EVENT_NAME`,
      `GITHUB_EVENT_PATH`, `GITHUB_SERVER_URL`, `GITHUB_API_URL`, and the rest, each aliased

      All of them, plus `GITHUB_REF_TYPE`, `GITHUB_REPOSITORY_OWNER`, `GITHUB_TRIGGERING_ACTOR` and
      the `RUNNER_*` set, and **every one is also `REVIEWOS_*`**. Aliased rather than chosen: a
      script that reads one and a script that reads the other are both right, and a forge that only
      answers to somebody else's name cannot be described in its own terms. `RUNNER_*` keeps its
      prefix, because it describes the machine rather than the forge.

      Three decisions worth keeping. `GITHUB_SERVER_URL` is **the address the runner actually
      reached**, not a configured one: a configured URL is the one behind the proxy as often as not,
      and every action that builds a link from it would produce a link nobody can follow.
      `GITHUB_BASE_REF` is **empty rather than absent** outside a pull request, because
      `if [ -n "$GITHUB_BASE_REF" ]` is how much of the ecosystem asks "am I on a pull request".
      And `RUNNER_TEMP` and `RUNNER_TOOL_CACHE` are **inside the workspace**, not the host's `/tmp`:
      a step that writes to a shared temp directory can read what the last job left there, and on a
      single-tenant box the last job may have been somebody else's branch.

      Deliberately not the whole of the control plane's environment, which holds the database
      credentials. A runner that passed its own environment through would be a way to read every
      repository on the instance.
- [x] `GITHUB_EVENT_PATH` contains an event payload matching the shape of the webhook payloads from
      [phase 5](./05-notifications-webhooks.md), because half the ecosystem parses it

      Written per job into the workspace's runner directory, so it goes when the workspace goes: a
      payload left in the host's temp directory outlives the job that owned it. The envelope is
      `Webhooks/payloads.ts`'s - `event`, `repository`, `sender`, and one key named after what
      happened - with `ref`, `after` and `pull_request.base.ref` under the names the ecosystem's
      scripts already reach for.

      Built from what the run recorded rather than from the repository as it is today, so a re-run
      of an old run sees the commit it was created for. **Nothing in it carries a URL**: this
      instance cannot know its own public address from inside a job, and a payload with a URL that
      does not resolve is worse than one with none - the environment is where a runner is told,
      by whoever configured it.

      One thing it cost: the runner directory is created *after* the checkout, because `git clone`
      refuses a directory that already holds anything. Writing the payload first turned every job
      into "destination path '.' already exists".
- [ ] An automatic per-job token, scoped to the run and the repository, expiring with the job,
      honouring the `permissions:` block, and never granted to a fork run by default. This is
      `GITHUB_TOKEN` and the ecosystem assumes it exists.
- [ ] The API endpoints that automatic token is used against by common actions, at
      `GITHUB_API_URL`, in the same shapes, so `actions/github-script` and friends work
- [x] Secret masking in logs, including values registered at runtime with `::add-mask::`.

      **Masked in the runner, before anything crosses the wire.** A value masked server-side has
      already been written down by the time it is hidden, which is a masking feature that does not
      mask. The command's own line is dropped rather than logged, since `::add-mask::hunter2`
      contains the secret it is asking to hide.

      Longest secret first, so one containing another leaves no fragment behind; values under three
      characters are not masked at all, or every log becomes asterisks.

### Resolving `uses:`

- [x] Local actions: `uses: ./.reviewos/actions/thing`.

      Composite actions run properly - their steps in order, with `with:` arriving as `INPUT_*` the
      way every action written against Actions reads it, and **in the caller's workspace rather than
      the action's own directory**, which reads as wrong until you write one: an action's steps
      operate on the repository that called them, and `GITHUB_ACTION_PATH` is how it reaches its own
      files. That covers most of what an action is in practice, since repositories' own actions are
      nearly all composite.

      JavaScript actions run their `main:` with Bun, and the log says so rather than pretending to
      be node - an action that depends on something Bun does not implement fails in a way its author
      can read. A path that climbs out of the workspace is not a reference at all: on a host runner,
      the directory above the checkout is the rest of the machine.

      Nesting - a composite step that itself `uses:` something - is refused with a message rather
      than followed, because doing it without the depth limit and cycle check the
      reusable-workflow path already has is the version that recurses forever.
- [ ] Container actions: `uses: docker://registry/image:tag`
- [x] Remote actions by owner and name with a configurable default host, plus fully qualified URLs.

      An origins map decides where a host's repositories actually live, so `actions.example` can
      point at an internal mirror, at this instance, or at a directory on disk. That is the same
      mechanism the mirroring box below wants rather than a second one - and it is what lets the
      test suite exercise real fetching over `file://` on a machine with no network.

      A reference naming no host is refused with a reason rather than resolved against github.com.
      That guess is the one the policy layer already declines to make, and making it here instead
      would have moved the decision somewhere nobody would look for it.
- [x] Ref resolution by tag, branch, and commit sha, with sha pinning enforceable by policy.

      The reference forms are read and the policy decides: **the default is closed** - local actions
      always, and nothing from anywhere else until an operator names a host. An unqualified
      `actions/checkout@v4` means nothing without a configured default host, and says so rather than
      guessing at github.com.

      Only a full forty-character sha counts as pinned. A short sha is ambiguous by construction and
      a seven-character prefix can be brute-forced onto a different object, so accepting one would
      make `requirePinnedSha` a setting that reads as protection and is not.

      **Fetching works now.** A remote reference is fetched with a shallow fetch of the one object
      the reference names - which is the only form that handles a tag, a branch and a sha without
      guessing which it was - and checked out into a cache keyed by the resolved commit.
- [x] An action cache on the instance, so a fleet of runners does not each fetch the same action, and
      so an instance can keep working when the upstream host does not.

      **Keyed by the resolved commit rather than by the reference**, so `@v4` and the sha behind it
      are one entry - which is what makes the second job's fetch free rather than a fetch. A pinned
      reference is answered from the cache without touching the network at all, because a sha *is*
      the identity and a directory named after one cannot be stale; a tag is resolved every time,
      because it moves, and only the resulting commit is reused.

      Two jobs fetching the same commit at once is a race with no loser: the second finds the first
      one's directory already there and drops its own copy, since same sha means same bytes.

      **The instance-side cache exists now too**, and it is the same thing as mirroring: the
      instance keeps bare mirrors under `storage/actions/{host}/{owner}/{name}.git` and serves them
      over the ordinary git protocol, so a runner points its origins map at
      `https://instance/actions/github.com` and everything else about fetching stays exactly as it
      was. Ten runners then fetch from here instead of from the internet.

      Read-only and unauthenticated on purpose: what is here is public code mirrored from a public
      host, carrying no repository's contents and no user's data, and requiring a credential would
      mean every runner in a fleet holding one to fetch things anybody can download.
      `git-receive-pack` is not served at all - a mirror that could be pushed to is a supply chain
      with a hole in it, and the whole value of mirroring `actions/checkout` here is that what this
      serves is what upstream had.
- [x] Mirroring of the actions a repository actually uses into the instance ([phase 13](./13-mirroring.md)
      already mirrors repositories), so an air-gapped install is a supported configuration.

      **What is mirrored is what is used**, read out of the workflow versions this instance has
      already parsed rather than from a list somebody maintains: a list drifts the moment a workflow
      changes, and the failure of a stale one is a build that breaks because the single action
      nobody added is the one it needed. Only the newest version of each active workflow counts, and
      only references the policy would actually allow - mirroring an action nobody may run is a
      network request with no possible use.

      Swept hourly. `git remote update --prune` on an unchanged repository transfers nothing, and a
      tag deleted upstream disappears here rather than being served forever; the reason to run it
      when everything is fine is that the day it matters is the day the upstream is down, and a
      mirror last updated a week ago is missing exactly the tag somebody pushed yesterday.

      The test deletes the upstream before fetching through the instance, because a cache that only
      works while the thing it caches is reachable is not a cache.
- [x] An allowlist policy at instance and owner level over which action sources may be used, since
      `uses:` is arbitrary code selection by anyone who can edit a workflow file
- [x] Tests: every resolution form, a pinned sha that does not match, an action outside the
      allowlist, an unreachable upstream with a warm cache, and a local action outside the repository

      All five, against real git over `file://` rather than against a mock, which is the only way
      the resolution cases mean anything - tag, branch, commit sha and subdirectory each resolve
      differently and the differences are the whole feature. A branch is the form people reach for
      without noticing (`@main` means "whatever is there today") and it had no test at all.

      The warm-cache case removes the upstream rather than misconfiguring it, because a cache that
      only works while the thing it caches is reachable is not a cache. Its other half is that a
      **tag fails honestly** with the upstream gone: a tag moves, so answering one from the cache
      would mean serving whatever it pointed at last time and calling it current. A pinned sha is
      different in kind - a sha *is* the identity, so a directory named after one cannot be stale.

### First run

Actions users do not provision anything. They push a file and it runs. That expectation does not
survive contact with a self-hosted forge unless we make it.

- [x] A single documented command brings up a runner and registers it with the instance

      `./buddy runner:local`, and that is now the whole of it. It used to be two: register, copy the
      credential out of the output, start with `--token`. The second step was friction with no
      safety behind it - the same operator, at the same shell, on the instance's own machine - and
      the argument that actually matters is unchanged: **this instance runs nothing until somebody
      types this**, and typing it is that. The credential is kept in
      `storage/framework/runtime/runner-local.token` at mode `0600`, because a file that can claim
      any job on the instance is not a world-readable one.

      `--register` stays, for the case it is really for: a runner on a *second* machine, where the
      credential has to be carried over. Re-registering rotates rather than duplicating, so a leak
      is fixed by one command. Documented in [self-hosting](../self-hosting.md#running-ci), with the
      no-isolation tradeoff stated where somebody deciding will read it.
- [x] A default queue exists on a new instance, so `runs-on: ubuntu-latest` resolves to something
      without configuration

      `ubuntu-latest` is in the local runner's default labels, alongside `self-hosted` and `local`.
      It is what every workflow copied from Actions says, and a new instance where the first
      `runs-on:` anybody writes matches nothing is an instance where CI appears to be broken rather
      than unconfigured. Naming it is a claim about what the label *means* here - "the machine the
      instance is on" - which is the honest reading for a single-tenant install and is printed on
      every start rather than assumed.

      The other half is the empty state. A job that can never be taken already said why; it now also
      says **what to do about it**, and only to somebody who could - the ability the cancel control
      asks for. A shell command in front of every visitor is noise; a paragraph that stops one word
      short of useful is worse.
- [x] Optionally, the instance ships with one local runner enabled for single-tenant installs, off by
      default for multi-tenant ones, with the tradeoff stated plainly rather than buried.

      `./buddy runner:local` - **a command rather than a setting**, which is the whole safety
      argument: this instance does not execute repository code unless an operator has said where,
      and typing it is that. `--register` makes the credential once; re-running it rotates the
      credential rather than making a second runner, so a leak is fixed by one command.

      The tradeoff is printed on every start, not buried here: **no isolation**. A step runs as the
      user who started the runner, on the host the control plane is on, with that user's files and
      network. Right for one team on one box running code they wrote; wrong for anything else.

      **A fork's pull request is refused by the runner itself**, not by a flag somebody can set at
      three in the morning: untrusted code on the control plane's own host is the one combination
      that turns CI into somebody else's shell. It is reported as failed rather than dropped, so the
      run still reaches a terminal state instead of holding a pull request's checks open.

      It speaks the ordinary HTTP protocol - claim, logs, report - rather than reaching into the
      database, so the lease, job-token and late-report rules are exercised rather than bypassed.
      Two things it does that a remote runner cannot: it clones from the bare repository on disk
      (`--no-hardlinks`, so a step running `git gc` cannot write into the instance's own objects),
      and **it checks out before the first step**. Actions leaves that to `actions/checkout`, which
      needs action resolution this phase has not built - without the checkout every copied workflow
      would run in an empty directory and read as a broken product rather than an incomplete one.

      A step's environment is the documented default set, deliberately *not* this process's
      environment: the control plane's own variables include the database credentials, and handing
      those to a repository's script would make the runner a way to read every repository on the
      instance. `uses:` steps are skipped with a line saying so, since resolving an action is the
      next box rather than this one.
- [x] The interface says clearly when a run is queued because no runner matches, and which labels
      would have matched, instead of a spinner.

      A run sitting at "queued" with a spinner is the most expensive screen in a forge: it looks
      like the instance is thinking, so people wait, then wait longer, then ask in a chat channel -
      and the instance knew the answer the whole time. Five answers, and each sends somebody
      somewhere different:

      - no runners are registered at all;
      - none of them reaches this repository, which is a scope problem rather than a label one;
      - none has the labels this job asked for - and the message names **what the runners that
        could take it do have**, which is the half that tells somebody what to write instead;
      - every runner that matches is disabled, which means "turn that one back on" rather than
        "change your `runs-on`";
      - a runner matches and will take it on its next poll, which is a real answer rather than an
        absence.

      Computed from the same rules the claim protocol uses to hand work out, because a screen that
      explains a decision the dispatcher did not make is worse than a spinner. On the run page and
      in the run detail, and read only when something is actually waiting - a finished run has
      nothing to explain.
- [x] A repository with no workflows offers starter templates that are real Actions workflows.

      Six of them, on the workflows page's empty state, ordered by the languages this instance has
      already measured - and nothing hidden, because a suggestion that removes options is one that
      is wrong at somebody's expense.

      Every starter is parsed *and dispatch-checked* by a test: it is not enough that a template
      reads well, it has to be a file this instance would actually run, and one whose triggers
      nothing dispatches would sit there saying "runs on nothing". They are deliberately small and
      carry no placeholder to fill in - a starter that needs editing before it works is an editing
      task, an editing task is a decision, and a decision is where people stop.

### Where the compatible forges stop, and we do not

Gitea and Forgejo both chose Actions compatibility and both proved it works. The places they fall
short are documented, and they are precisely the Buildkite capabilities in the rest of this file,
which is the whole argument for this phase existing:

| They do not have | We do, and it is in this file |
|---|---|
| `concurrency:` groups (ignored by Gitea) | The concurrency engine, ordered and eager |
| Scheduled workflows (ignored by Gitea) | Schedules with branch, message, and environment |
| Complex `runs-on` expressions | Queue plus tag selection, with a visible reason when nothing matches |
| Environment protection rules | Required reviewers, wait timers, and branch policy, with scoped secrets *(planned)* |
| Test intelligence of any kind | Flaky detection, quarantine, splitting, ownership |
| Fleet management beyond a registered runner | Pools, queues, autoscaler contract, drain, lifecycle |
| Signed step dispatch | Signed workflows, enforceable per pool *(planned)* |
| Annotations on the diff | The reason this project exists |

- [x] Each row above has a test proving the difference, because a comparison table in marketing that
      no test defends becomes false without anybody noticing

      `tests/unit/comparison-claims.test.ts`. Every row is either a **live claim**, checked by
      exercising the capability rather than importing the module - a concurrency group actually
      resolved, a tag selector actually matched and actually refused, an annotation landing on the
      row a reviewer is reading - or a **pending claim** naming the roadmap box that would make it
      true.

      **It ratchets both ways.** A new row with no claim fails; so does a pending claim whose box
      gets ticked, because at that point the promise should be replaced by a check.

      Writing it did the job immediately: two rows were not true. `environment:` was parsed and
      wired to nothing, and signed dispatch has no key for a pool to trust. Both were marked
      *(planned)*, which is the correction the test existed to force - and the first of them was
      then built, so the ratchet fired and the promise was replaced by a live check.

---

## The engine: the step model underneath

Everything above describes what an author writes. This describes what the control plane can do once
it has parsed it. The Actions surface normalizes into this model, and the Buildkite capabilities here
are reachable from additive keys on Actions syntax rather than from a second language.

### Step kinds

Actions has one step kind and expresses the rest through job structure. Buildkite has six, and the
extra five are genuinely useful, so the engine carries all of them. In Actions syntax the last four
appear as job-level keys rather than as new step types, which is the pattern for everything in this
phase: **familiar surface, larger engine.**

- [x] **Command step.** One or more shell commands, or a `uses:` action. The only kind that consumes
      a runner, and the only one an Actions workflow writes directly.

      The default, and the only kind the claim will hand to a machine - which is a rule rather than
      an optimisation. The other three are the control plane's own work, and a runner deciding a
      deployment approval would not be a scheduling mistake, it would be the gate not existing.
- [x] **Wait step.** A barrier. Everything before it must finish before anything after it starts,
      with a variant that continues on failure. `needs:` covers most of this; an explicit barrier
      covers the rest.

      `reviewos: { wait: true }`, **normalized into `needs:` at parse time** so the graph a reader
      sees is the graph that runs: the barrier needs every job declared before it, and every job
      after it that named no dependencies of its own needs the barrier. A job with an explicit
      `needs:` keeps it, because that is a statement about the graph and a barrier must not quietly
      widen it.

      `continue-on-failure: true` is the variant, and it is the graph-level twin of `if: always()`:
      the dependencies still have to be *finished*, since the point of a barrier is that everything
      before it is over - only their verdict stops mattering. It reaches the graph as
      `allow_dependency_failure`, which is the attribute two sections down.
- [x] **Block step.** Pauses the run until a human unblocks it. The approval gate, and the primitive
      phase 9's "waiting steps" already describes. Reached from Actions syntax through
      `environment:` protection rules.

      `reviewos: { block: 'Deploy to production?' }`. The job sits in **`paused`**, which is its own
      job state rather than `blocked`: `blocked` means "waiting for another job" and the graph
      resolves it on its own, where nothing resolves this but somebody deciding. A screen that
      cannot tell the two apart cannot show the button, which is the whole difference between a gate
      and a hang. The run reads `waiting` rather than `running`, because nothing is running.

      **Its own ability, `workflow:approve`.** Not `workflow:cancel`: stopping a build is safe and
      approving a release is not, and folding them together would mean anybody who can stop a run
      can also ship one. Who opened it is recorded on the job, because "who approved this
      deployment" is asked while looking at the run.
- [x] **Input step.** Pauses and collects typed fields (text, select, boolean) from the person
      unblocking it, which become available to later steps.

      **Folded into the block step rather than given a row of its own**, because a block with fields
      *is* an input step and two names for one row is how a model grows a spelling problem. The
      typed values become the job's **outputs**, so a later job reads
      `needs.approve.outputs.version` exactly as it reads any other job's output - inventing a
      second mechanism for "values a person typed" would be a second thing to learn for a value that
      behaves identically.

      `string`, `boolean` and `select`, and a `select` declares its options. A value outside them is
      refused **with the options listed**: the entire reason to declare them is that somebody can be
      told which ones there are rather than reading "invalid input".
- [x] **Trigger step.** Starts a run of another workflow, in this repository or another, passing
      commit, branch, environment, and metadata. Async by default, awaitable on request. Actions
      reaches this through `workflow_call` and `repository_dispatch`.

      In this repository, for now: a cross-repository trigger is the same policy question as a
      cross-repository `uses:`, and answering it here would answer it in the wrong place. Async by
      default, which is Buildkite's default and the right one - a trigger that waits turns one stuck
      run into two - with `await: true` keeping the job running until the run it started finishes
      and **carrying that run's verdict back**, since a trigger that waited and then reported
      success whatever happened would be a gate that is not one.

      Three rules that are not optional. A triggered run is **trusted because the run that triggered
      it was**, so a fork's pull request cannot trigger a trusted one: a trigger cannot raise its own
      trust level. It carries a **depth with a ceiling of five**, because a workflow that triggers a
      workflow that triggers the first one is a run factory and nothing else in the model would
      notice - every trigger makes a *new* run, so there is no row to catch the loop. And a trigger
      that cannot resolve **fails, with the reason on the job**: a pipeline whose deploy stage
      silently did nothing, and a green run to go with it, is the failure this phase exists to
      avoid.
- [x] **Group step.** Nests steps under one label so a run with two hundred jobs reads as eight
      things. Groups carry their own dependency edges and rollup state.

      **A label rather than a container**, which is a deliberate narrowing of what the line asks for.
      Nesting jobs inside jobs would change every query that reads a run, and it would let a screen
      re-sort the jobs - and a run page that disagrees with the order in the file is a page nobody
      can check the file against. The heading prints once, over the jobs that share it, in declared
      order. Dependency edges stay between jobs, where `needs:` already puts them.

### Step attributes

Every one of these has to survive normalization into rows (phase 9: no workflow-sized JSON blob) and
has to be expressible in the validator that runs before a definition ever reaches a runner. The names
below are the internal model's; the Actions key that maps onto each is noted where it is not obvious.

- [ ] `key`, `label`, and a stable identity that survives re-uploads within a run
- [ ] `depends_on`, accepting several keys, plus `allow_dependency_failure` so a step can run after a
      failure on purpose
- [ ] `if`, a conditional expression over a documented, sandboxed variable set: branch, tag, commit
      message, trigger source, changed paths, prior step outcomes, and declared inputs. No arbitrary
      reads of control-plane state.
- [ ] `branches`, including negation, as the shorthand for the most common `if`
- [ ] `skip`, boolean or a reason string that shows on the run
- [ ] `soft_fail`, boolean or a list of exit statuses that report failure without failing the run
- [x] `retry`, automatic and manual. Automatic retries key on exit status, a lost runner, and a
      timeout, with limits and constant, linear, or exponential backoff. Manual retry can be
      permitted, forbidden, or forbidden with a reason.

      **Automatic, on exit status and on a lost runner.** `reviewos: { retry: 2 }` is two extra
      attempts; `retry: { attempts: 2, exit-status: [137] }` narrows it to the failures worth
      repeating, because a suite that exits 1 on a failed assertion is not one and a step killed for
      memory at 137 is. A named-status retry does *not* fire on an unknown status: retrying on "we
      do not know why it failed" is how a narrow retry becomes a blanket one.

      **The cap is required and there is a ceiling of five**, refused with the reason rather than
      clamped: a job that fails five times in a row is not flaky, it is broken, and the retries are
      spending machines to postpone the moment somebody looks at it. Every attempt shows on the run,
      because a job that quietly ran twice is a flaky test nobody ever fixes.

      **This found an unbounded loop.** The lease sweep requeued *every* job whose runner stopped
      responding, with nothing counting - so a job that kills the machine it runs on, out of memory
      or out of disk, was handed to every runner in the fleet in turn, for as long as the fleet
      existed. Recovery is right; recovery without a limit is one job taking down a fleet one
      machine at a time. Three attempts now, and then a failure that says three different runners
      went quiet on the same work rather than reading as an ordinary one.

      Backoff and manual-retry policy are not implemented: a retry that waits needs a scheduled
      wake-up rather than a state change, and the manual half is a re-run button that does not
      exist yet.
- [x] `timeout_in_minutes`, per step, with a workflow default and an instance ceiling

      `timeout-minutes:` on a step, which is Actions' own key and was parsed by nothing until now:
      the runner applied its own two-hour ceiling to every step and the workflow's number went
      nowhere. The narrow one is the useful one - a job allowed sixty minutes that hangs in a
      thirty-second health check spends fifty-nine of them proving nothing - and a step stopped this
      way **says so**, because a killed process exits with a signal and otherwise reads as an
      ordinary failure in a command that was working fine.

      The ceiling stays underneath as the default, so nothing hangs forever whatever the file says.
- [x] `priority`, so a deploy jumps a queue full of pull request checks

      `reviewos: { priority: 10 }`, read by the claim on every poll - which is why it is a column
      rather than a value in the settings blob. Equal-priority jobs stay first in, first out,
      because a queue that reorders equal work is one where somebody's build can starve.

      **It orders a queue, it does not preempt.** A job already running is not stopped for a more
      important one: that would mean killing work somebody is waiting on to start work somebody else
      is waiting on, which needs a policy rather than a number.
- [ ] `parallelism`, expanding one step into N identical jobs that differ only by index and total
- [ ] `matrix`, expanding across named dimensions, with `adjustments` that add a single combination,
      skip one, or soft-fail one, because the useful matrix is never the full cross product
- [ ] `concurrency` and `concurrency_group`, a named limit shared across runs and workflows, which is
      how a shared staging environment or a deploy lock gets serialized
- [ ] `concurrency_method`: ordered (a FIFO queue) or eager (whoever is ready). The difference is
      whether a deploy queue preserves commit order.
- [ ] `agents`, a `key=value` tag query selecting which runners may take the job
- [ ] `env`, per step, over a workflow-level `env`, over runner environment
- [ ] `secrets`, naming secrets to inject rather than embedding them, resolved at dispatch
- [ ] `artifact_paths`, globs uploaded automatically when the step ends, pass or fail
- [ ] `plugins`, the extension point, with its own section below
- [ ] `cancel_on_build_failing`, so long jobs stop when a sibling has already sunk the run
- [ ] `checkout` options: submodules, clone depth, LFS, sparse paths, clean behavior, and skipping
      checkout entirely
- [x] `if_changed`, path-glob gating evaluated against the run's diff. The monorepository primitive,
      and the one that decides whether a big repository is usable here at all.

      `reviewos: { if-changed: packages/api/** }` on a job. Actions filters the *whole workflow* on
      `on.push.paths`, which is the wrong grain for a repository with twelve packages in it: the
      workflow has to run, and what it runs is the question.

      Decided at dispatch, like `if:`, so a job that is not going to run is `skipped` **with the
      reason on the row** from the moment the run exists rather than queued and quietly ignored. The
      reason names the globs, because the value of skipping a job in a monorepository is being able
      to see why without opening the file.

      **Unknown paths mean the job runs.** The changed list is empty when the instance could not work
      out what moved - a force push, a first push, a rewrite past the ceiling - and the two failures
      are not equal: a job that runs when it need not have costs a few machine-minutes, and a job
      skipped when it should have run is a broken commit nobody noticed.

      A barrier or a gate cannot carry it, and that is refused rather than allowed: a barrier that
      only sometimes exists changes the shape of the graph, and a deployment gate that vanishes
      because no file matched is a gate that approves itself.
- [ ] `notify`, per step, distinct from workflow-level notification
- [ ] Tests: every attribute above round-trips definition to normalized rows to execution, and the
      validator rejects each one's malformed forms with a file location and a fix

Which of those an Actions author already has a word for, so the engine does not grow a second
spelling for a thing people can already say:

| Internal | Actions key | Note |
|---|---|---|
| `depends_on` | `needs:` | Same semantics. `allow_dependency_failure` is `if: always()`. |
| `if` | `if:` | Same expression language as the section above. |
| `soft_fail` | `continue-on-error:` | Actions has boolean only; the exit-status list form is additive. |
| `timeout` | `timeout-minutes:` | Same. |
| `parallelism` | `strategy.matrix` | Actions expresses N identical jobs as a one-dimensional matrix. |
| `matrix` | `strategy.matrix` | `adjustments` are `include:` and `exclude:`. |
| `agents` | `runs-on:` | Labels resolve to a queue plus tag query. |
| `artifact_paths` | `actions/upload-artifact` | Both work. The declarative form uploads on failure too, which the action cannot. |
| `env`, `secrets` | `env:`, `secrets:` | Same. |
| `checkout` options | `actions/checkout` inputs | Both work. |
| `if_changed` | `on.push.paths` | Actions filters the whole workflow; per-step filtering is additive and is the monorepository primitive. |
| `concurrency_group` | `concurrency.group` | Same. `concurrency_method` is additive. |
| `priority` | (none) | Additive. |
| `plugins` | `uses:` | Different mechanisms, overlapping purpose. See the plugins section. |

- [x] Every additive key above is documented as an extension, in one place, with what happens when a
      workflow using it is taken back to GitHub. An extension nobody can find, or that silently
      breaks portability, is worse than not having it.

      [`docs/extensions.md`](../extensions.md), and there is exactly one key to document because
      **everything additive lives under `reviewos:` on a job**. An extension spread across five new
      top-level keys is five things to find when a workflow moves; this is one to delete and one
      word to grep for when somebody asks what in a repository is not portable.

      What happens on GitHub is stated first rather than in a footnote: **the file is refused**,
      since GitHub does not accept a job key it does not know. That is the right failure. A key
      GitHub silently ignored would mean a `block:` gate that is simply not there on the other
      side - a deployment approval that approves itself.

### Dynamic definitions

Buildkite's most important feature and its largest security surface. A job can generate steps and
upload them into the run it is already part of, so a workflow can decide what to do after looking at
the repository. Actions has only a shadow of this: a matrix built from `fromJSON` of a prior job's
output, which covers the common case and nothing else.

- [x] A runner-side upload command that appends steps to the current run, validated by the control
      plane before any of them become eligible

      `reviewos-upload generated.yml`, on the PATH of every step, put there by the runner. One line,
      because the alternative is every generating job carrying a curl invocation with a job
      credential in it - and a credential in a repository's own script is a credential in its own
      log. The credential lives in the script, outside the checkout, so a step that prints its
      environment or tars its workspace does not carry it away.

      Validated by **the same parser a workflow file goes through**, with the run's existing job
      names handed to it so a generated job may depend on the one that generated it. A second,
      laxer validator for uploaded steps would be the one an attacker reads.
- [x] Uploaded steps are attributed to the job that uploaded them, and the run records the full
      resulting graph rather than only what was declared at the start

      `uploaded_by_job_id` and `upload_depth` on the row. A run's graph is what it *became*: a
      screen showing only the original file would be describing a run nobody had.
- [x] An uploaded step cannot raise its own trust level: it cannot grant itself secrets, target a
      queue the parent could not, or turn a fork run into a trusted one

      Structural rather than checked: everything that decides what a job may reach is inherited from
      the run and the uploading job, and **there is no field in the document for any of it**. A
      fork's run stays untrusted, the repository is the same repository, and the pool serving it is
      the pool that already served it. Priority is inherited too, which is the one field a generated
      job could otherwise use to jump a queue full of other people's work.

      Secrets are not in this list because they are not implemented anywhere yet; when they are, the
      rule is already written down in the threat model and this is the shape it has to take.
- [x] An upload budget: maximum steps, maximum depth, maximum total uploads per run, so a loop is
      bounded by the control plane rather than by a quota nobody set

      Four limits, because each one alone is a loop somebody can still write: three uploads deep,
      twenty uploads per run, fifty jobs per upload, five hundred jobs per run - plus a 200KB ceiling
      on the document itself, which bounds how much text one request can make the parser look at.
      Reaching a limit stops the *next* upload rather than unwinding the last one.
- [ ] Signature verification. When signed workflows are enforced (below), an uploaded step must be
      signed by a key the runner pool trusts, or refused.

      Not implemented, and it cannot be until signed workflows are: there is no key for a pool to
      trust yet. Written here rather than half-built, because a signature check with nothing behind
      it is worse than none - it reads like a guarantee.
- [x] Tests: uploading a step that targets a forbidden queue, an upload loop, an upload from a fork,
      an unsigned upload under enforcement, and an upload after the run reached a terminal state

      Four of the five, plus the ones writing it turned up: a name the run already has, a `needs:`
      naming nothing, a document the parser refuses, and a priority a generated job tried to give
      itself. The fifth - an unsigned upload under enforcement - is the box above, and there is
      nothing to test until there is something to enforce.

      The forbidden-queue case is covered by construction rather than by a check: an uploaded job
      cannot name a pool at all, and the claim already refuses a repository a pool does not serve.
      The end-to-end test runs the real runner, whose step writes YAML and calls `reviewos-upload`,
      and then claims the generated job with a second poll.

### Definition management

- [ ] Workflow templates, owner-managed, so an organization can require a starting point. This is
      phase 9's "owner-managed reusable workflows" from the governance side rather than the reuse
      side.
- [ ] Schedules in cron syntax, per workflow, each with its own branch, commit, message, and
      environment, plus enable and disable without deleting
- [x] Skip intermediate runs and cancel intermediate runs, per workflow: when three commits land in a
      minute on the same branch, do not run all three

      `reviewos: { intermediate: skip | cancel | run }` at the top level - the only extension that is
      not on a job, because it is a statement about the *workflow's* runs.

      `cancel` is `concurrency.cancel-in-progress` said in one word. **`skip` is the third thing
      neither Actions nor Gitea offers**, and usually the one people mean: let the build that has
      already started finish, and drop the ones that have not. The run in progress will produce a
      result somebody reads; the queued ones would produce two nobody does.

      A skipped run is `cancelled` outright rather than `cancelling`, because nothing had taken it -
      there is no machine to tell and no acknowledgement to wait for, which is the whole difference
      from cancelling in progress. Its jobs go with it, rather than sitting queued for a runner to
      take work from a run nobody will read.

      One thing writing it turned up: the value was being validated *after* the parser's
      `errors.length > 0` gate, so `intermediate: maybe` was silently read as `run`. A validator
      whose complaints are discarded is worse than none - it reads like a check.
- [ ] Merge queue support: a run against the prospective merge result rather than the branch tip, so
      a queue of pull requests is tested in the order it will land
- [x] A workflow can live at a path other than the repository root, and more than one can live in one
      repository

      `.github/workflows/*.yml` and `.reviewos/workflows/*.yml`, any number of them, each its own
      workflow with its own runs and its own schedule. `.reviewos/` wins outright when present -
      not merged, because two directories quietly contributing to one list is how somebody ends up
      running a file they thought they had replaced.
- [x] Environment variables and settings at instance, owner, repository, and workflow level, with a
      documented precedence order and a screen that shows where a value came from

      Narrowest wins - the workflow file's `env:`, then the repository, then the owner, then the
      instance - and that half is what everybody expects. **The screen is the feature.** Four
      places can set `REGISTRY`, so a value can be wrong at a level nobody is looking at, and "it
      is us-east-1" is not the answer somebody needs at that point: the listing says which level
      answered and what it overrode, widest last.

      Setting a value something narrower already overrides says so in the answer, because
      otherwise it looks like it worked and the question comes back three days later.

      The resolution runs once, at claim time, and the page reads the same function: a precedence
      rule implemented twice is a precedence rule that disagrees with itself about why a value is
      what it is.

      An instance variable needs an administrator and an owner variable needs the owner -
      administering one repository is not permission to change every repository an organization
      has. And they are **variables, not secrets**: readable by anybody who can read the
      repository, in the logs, handed to a fork's job. There is no secret store yet and the docs
      say so rather than approximating one with a `secret: true` column on a plain-text table.
- [ ] Tests: schedule fires once per window, intermediate cancellation leaves exactly one run, a
      template change does not retroactively alter a finished run

---

## The runner fleet

Buildkite's agent is the part of it that is open source, and the part people trust it for. Phase 9
defines the protocol; this is the fleet management around it.

**The protocol has been run as a fleet, on machines that are not the instance's**, which is worth
recording because everything below is easy to design against a runner that only ever runs next to
the control plane. `./buddy build:runner --target linux-x64` compiles the *same executor*
`runner:local` uses into one file with no runtime to install - it compiles at all because nothing
under `app/Actions/Runner/` touches the framework or the database, and a runner that needed a
database connection is one you could only run on the instance's own box.

What a real run showed, with two runners on a Linux x86-64 machine in another country claiming from
a macOS arm64 control plane:

- A three-way matrix spread across both runners, with `max-parallel: 2` holding the third
  combination back until a slot opened.
- The **checkout over HTTP**, since there is no `storage/repos` on a fleet machine. A same-host
  runner still clones from disk; which one happens is a fact about where the runner is rather than a
  setting.
- `RUNNER_OS=Linux` and `RUNNER_ARCH=X64` on the runner while the control plane was `macOS`/`ARM64`,
  which is the environment set being *about the machine that runs the job* rather than about the
  instance.
- A `wait` barrier resolving with **no runner at all** (`runner_id` null), and the job after it
  running only once the barrier had.
- Job outputs read back from `$GITHUB_OUTPUT` across the wire, and a step-level `if:` gated on one.

The credential is made on the instance and carried over, because a fleet machine has no database to
register itself in - which is exactly what a registration token is for.

- [x] Runner pools: a named group of queues plus the workflows permitted to use them. A workflow in
      one pool cannot dispatch to, read artifacts from, or trigger a workflow in another unless a
      rule says so.

      **A pool serves the repositories it lists, and every repository when it lists none.** The empty
      list is what every existing install has, so nobody is quietly given a boundary they did not
      ask for; adding one repository is the act of drawing it. The refusal names the pool but *not*
      its other repositories - on a shared instance that list is the map of who is working on what.

      The narrowing from the line above: permission is per *repository* rather than per workflow, and
      it governs which machines take the work rather than artifacts and triggers. A workflow-level
      rule needs a name for a workflow that survives being renamed, and artifact and trigger scoping
      is a second boundary with its own failure modes - both are worth doing after somebody has run
      the first one.
- [x] Queues within a pool, named for infrastructure rather than for teams, with pause and resume so
      an operator can drain one without deleting it

      Draining is the operation the row exists for. Every other way to take machines out of service
      loses something: deleting runners loses their identity and their history, disabling them one
      at a time is a list somebody has to keep, and turning them off leaves jobs waiting on a
      machine that is not coming back. Pausing says "no new work here", lets what is running finish,
      and is undone by one call - **the jobs stay queued**, which is the difference between a drain
      and an outage. The reason travels to the run page, because the person who returns to a stuck
      queue is usually not the person who drained it.
- [x] Registration tokens scoped to one pool, rotatable, revocable, with a first-use and last-use
      record. Registration credentials never enter a job environment (phase 9 rule).

      **The credential a fleet machine should actually carry.** Before this, an autoscaler needed an
      *administrator's* token to create runners - which puts the widest credential on the instance
      into a userdata blob on every machine it starts. A registration token can do one thing, add a
      machine to one pool, and that is the whole blast radius when a blob leaks.

      `POST /api/runner/register` **exchanges it**: registering mints a per-runner credential and the
      machine uses that from then on, the same shape as the job token one layer down. That is how the
      phase 9 rule is kept rather than promised - the thing running jobs is holding something else by
      then, and a test asserts the registration credential is refused at the claim.

      Revoked rather than deleted, because "which token did that machine register with" outlives the
      token and is asked at exactly the moment a machine did something surprising. Revoking stops
      *new* machines joining and does not interrupt a build already running on one that joined.
      First use and last use are recorded because they answer the two questions asked about a
      credential nobody remembers making: has this ever been used, and is it still being used.
- [x] Runner tags, set at registration and by a startup hook, queried by a step's `agents` selector.
      Unmatched selectors leave a job queued with a visible reason rather than silently forever.

      `reviewos: { agents: [gpu=a100] }`, matched against `key=value` tags a machine reports about
      itself at registration. Labels are a set membership test, which is the right shape for
      `ubuntu-latest` and the wrong one for anything with a value in it: a fleet with four GPU models
      grows labels called `gpu-a100`, and a label means whatever the person who typed it was
      thinking.

      A selector that is not `key=value` is **refused rather than read as a label** - one that
      silently became a label would match a different set of machines than the file says, and a job
      running somewhere it should not is invisible. A machine that reported no tags satisfies no
      selector, which is the safe direction.

      An impossible selector is told apart from a label mismatch on the run page, because the two
      look identical from outside and have opposite remedies: a label is changed in the workflow, and
      a tag is set on the machine by whatever knows it has a GPU.
- [x] Runner lifecycle visible in the interface: connecting, idle, accepted, running, stopping,
      stopped, lost, with the job it is on and the time in state

      Six states, derived rather than stored: `never-seen`, `idle`, `running`, `stopping`, `lost`,
      `disabled`. A status column has to be written by whoever causes the change, and **the one
      change nobody causes - a machine going quiet - is the one that matters**, so the lifecycle is
      the lease, the last poll and the stop somebody asked for, read together.

      `lost` outranks `stopping` and `running` on purpose: a machine asked to stop that then goes
      quiet has stopped without saying so, and a machine holding a job whose lease has lapsed is
      exactly what the reclaim sweep is about. `never-seen` is the first-run confusion made visible -
      a credential somebody made and a command nobody started.
- [x] Ephemeral runners: disconnect after one job, or after an idle timeout, which is what makes an
      autoscaling group safe

      `--jobs 1` and `--idle-timeout <seconds>`, both on the runner itself. That placement is the
      point: **the runner knows whether it is mid-job** where a scaler outside it has to guess, and
      guessing wrong means killing a machine in the middle of somebody's build. The idle clock runs
      from the last *job* rather than the last poll, so a runner that has been busy does not shut
      down because the queue emptied for one cycle.

      Verified on a real machine: a runner started with `--idle-timeout 6` against an empty queue
      exited on its own.
- [x] Graceful stop that lets the current job finish, and a forced stop that does not, both from the
      API

      Both on `/api/instance/fleet`. They differ in one thing: what happens to the job the machine
      is holding. Graceful takes no new work and lets it finish; **forced puts the job back in the
      queue rather than cancelling it** - the work is fine, it is the machine that is going away,
      and somebody watching a pull request should not see their build fail because an autoscaler
      shrank the fleet. It counts as an attempt, so a machine force-stopped repeatedly cannot hand
      one job round a fleet forever.

      The machine is told **when it next asks for work**, because that is the only moment this
      instance can tell it anything: a runner is somebody else's machine, possibly behind a
      firewall, and there is no connection to send a signal down. The request is cleared when it is
      acknowledged, or a machine an operator brought back would stop again immediately.
- [x] A metrics endpoint reporting queue depth, waiting jobs per queue, and runner counts by state,
      in a shape an autoscaler can poll. This is the whole interface an autoscaler needs.

      On the existing `/api/metrics`, in Prometheus exposition format, because that is what every
      scraper and every autoscaler already reads - a JSON shape of our own would be a format each
      operator has to write an exporter for. `reviewos_ci_jobs_waiting`, `_jobs_running`,
      `_jobs_oldest_waiting_seconds` and `reviewos_ci_runners{lifecycle}`, all per queue.

      **Every series is emitted at zero**, which is the detail that decides whether the contract
      works: a gauge that disappears when it reaches zero is how a scaler concludes there is no work
      when what happened is that nobody reported any. `unassigned` is a real queue name, carrying
      the machines nobody put in a queue and the jobs whose `runs-on:` matches no runner anywhere -
      on an instance that has started using pools, that bucket is where the surprises are.
- [x] Reference autoscaler for at least one substrate, plus documentation of the polling contract for
      the ones we do not write

      [`docs/autoscaling.md`](../autoscaling.md): the contract, what a scaler has to do itself, and a
      hundred-line shell script against Hetzner Cloud that is deliberately boring.

      **The interesting part is that it has no scale-down path.** The runner exits on its own when
      the queue has been empty for five minutes and the machine shuts itself off, so nothing outside
      has to answer "is it mid-job" - which is the question a scaler cannot answer and the reason
      autoscaled CI kills builds. `stop-runner` exists for the cases the runner cannot know about: a
      spot instance being reclaimed, a queue drained for maintenance.

      Machine preparation is **pantry, not a container image**: `pantry install git node@22` on a
      general-purpose machine, and a machine that needs a different version tomorrow installs it
      rather than being rebuilt. There is no Dockerfile anywhere in that document, which is the
      point.

      The binary comes from the instance itself - `GET /api/runner/download?target=linux-x64`,
      public and uncredentialed because the file holds no secret and does nothing until it is given
      a URL and a token. That makes the version question answer itself: the binary a machine fetches
      is the one built for the instance it is about to talk to.
- [x] Pool maintainers: a role that can manage queues, tokens, and workflow assignment without being
      an instance administrator

      The role exists because of what happens without it: the person who looks after the build
      machines is made an instance administrator - draining a queue needs it - and now they can read
      every private repository on the instance.

      Per pool rather than a global "fleet operator", because a fleet with two pools usually has them
      because two groups own different machines, and a role spanning both puts each group's
      credentials within reach of the other. Two verbs stay administrator-only: creating a pool is
      creating a boundary, and appointing maintainers is handing out the power to manage one - a role
      that can appoint itself sideways is not a narrower role at all.

      A maintainer acting on a pool they do not maintain gets the same 404 a stranger gets: the
      existence of somebody else's pool is not theirs to learn.
- [x] Tests: a job with an impossible selector, a runner lost mid-job, a drained queue, a revoked
      token mid-job, and a runner claiming work from a pool it is not registered to

      All five, against the real claim rather than against the rules in isolation - a boundary the
      dispatcher does not enforce is documentation. The runner-lost case is in
      `runner-reclaim.test.ts`, where it also proves the attempt cap: three machines going quiet on
      one job stops it being handed out rather than passing it round the fleet forever.

### Runner hooks

Buildkite's hook set is the extension point that makes the agent adaptable without a plugin, and the
list is worth copying wholesale because each entry exists to solve a problem people actually have.

- [ ] Fleet lifecycle: `runner-startup`, `runner-shutdown`
- [ ] Job lifecycle, in order: `pre-bootstrap`, `environment`, `pre-checkout`, `checkout`,
      `post-checkout`, `pre-command`, `command`, `post-command`, `pre-artifact`, `post-artifact`,
      `pre-exit`
- [ ] Three scopes with a documented precedence: runner hooks (on the machine, outside repository
      control), repository hooks (in the checkout), and plugin hooks
- [ ] `pre-bootstrap` can refuse a job before any repository code is fetched. This is how an operator
      keeps a trusted runner from running an arbitrary workflow, and it must be runner-scoped only.
- [ ] `checkout` and `command` are overridable, so a fleet can substitute its own clone strategy or
      execution wrapper
- [ ] Tests: a refusing `pre-bootstrap`, a repository hook attempting to override a runner hook, hook
      failure at each stage, and the environment a hook can and cannot see

### Plugins

**Actions is the primary extension mechanism.** `uses:` is what an author reaches for, it is what the
ecosystem is made of, and nothing here replaces it. A plugin is the second mechanism, for the thing
an action structurally cannot do: hook into the job around the command, before checkout or after
artifact upload, on every step in a pool without being written into each workflow. Buildkite's
plugins and Actions' actions are not competitors; they sit at different points in the job lifecycle.

- [ ] The distinction above is documented on one page with a decision rule, or every workflow author
      will pick by coin flip and half of them will be wrong
- [ ] A plugin is a versioned, self-contained repository providing hooks and a declared parameter
      schema, referenced by a step or attached to a pool
- [ ] Parameters are validated against the plugin's schema before dispatch, not by the plugin at
      runtime
- [ ] Pinning by commit or tag, and an instance policy that can require pinning
- [ ] An allowlist policy at instance, owner, or pool level, because an unrestricted plugin reference
      is arbitrary code selection by whoever can edit a workflow file
- [ ] Vendored plugins: a plugin resolved from the repository itself rather than fetched
- [ ] A plugin can be marked as requiring elevated capability (docker socket, host network), and a
      pool can refuse those
- [ ] Documented authoring path, a local test harness, and a small first-party set that covers the
      cases every fleet needs
- [ ] Tests: an unpinned plugin under a pinning policy, a schema violation, a plugin outside the
      allowlist, and a plugin hook attempting an escalation the pool forbids

---

## What a run looks like

The screens. Buildkite's advantage here is a decade of small decisions, and most of the list is small
decisions.

- [ ] Log output streamed live, with collapsible groups the job itself opens and closes, per-line
      timestamps, ANSI colour, links, and images

      **Everything but images.** Groups, timestamps, colour and links are done, on top of structured
      log events: an append may carry `line`, `group` and `endgroup` events instead of bytes, and
      the four things text cannot carry stop being guesses. `::group::` is a marker one CI product
      uses and a string somebody's build may legitimately print; the time a chunk arrived is not the
      time a line was printed, since a runner batching a hundred lines has them all land in one
      millisecond; a chunk carries one stream where a job interleaves two; and escape bytes shown as
      text are noise nobody can turn off.

      A group is a `<details>`, so folding works with no script - the run screen carries almost
      none. The last group of a *failed* job is open, because a job that groups its output is
      usually grouping the parts nobody reads and the exception is the one the failure is in; that
      is decided from the job's state rather than by searching the output for the word "error".

      Colour is classes rather than inline styles, so a theme decides what red is on the background
      the reader actually has. Links are `http` and `https` only, `rel="noreferrer nofollow
      noopener"`, with trailing punctuation left out of the href - a link that 404s because it
      swallowed a full stop teaches people not to click them.

      Text is not deprecated: a runner that sends what its build printed still works, renders through
      the same path, and gets the text stored beside any events rather than having to send both.

      Images are the one left. They need a way to reference bytes a job produced - which is now
      possible, artifacts exist - plus a content policy for rendering them, and an image a build can
      put on a page somebody else loads is a decision rather than a feature.

      **The streaming half, from before:** The run screen follows a job from the
      sequence the page was rendered at - `resources/functions/runlive.ts` - so a job that has
      already printed two megabytes costs nothing to follow and a reader never sees a line twice.
      New output is appended after what the server rendered rather than replacing it, because a
      reader mid-line in the failure of job three should not be moved; the run's own state is
      reported in a line at the top, and a run that finishes offers a reload rather than taking one.

      It stops when the run does. The log endpoint reports the job's state beside its chunks for
      exactly that: a job quiet for a minute in the middle of a step and one quiet forever look
      identical from the output alone, so a follower without it either gives up early or polls a
      finished job until the tab closes. A hidden tab backs off to a minute rather than stopping,
      since coming back to a stale page is the thing this exists to prevent.

      Groups, timestamps, ANSI and links wait on structured log events - the plain-text half is what
      exists, and a group marker parsed out of plain text is a guess about somebody's build output.
- [ ] Log search that works during streaming and on a finished run, with deep links to a line
- [ ] Log redaction applied before persistence, driven by the secrets the job was given, with a
      visible marker where something was removed rather than a silent gap
- [ ] Log size ceiling with a documented truncation behavior, and backpressure that slows a runner
      rather than dropping the middle of the log
- [ ] Annotations: markdown, with a level (success, info, warning, error), a context key so a rerun
      replaces rather than appends, and append semantics when asked for
- [x] **Annotations render on the diff**, on the file and line they name, on both sides. This is the
      row in the table at the top of this file, and it is the reason to build any of this.

      Done in phase 9, where the checks half of it lives: `app/Actions/Pull/annotations.ts`, hung on
      the diff through an `annotationsAt` slot beside the one review threads use. Both sides, on the
      line the tool named, and a finding spanning five lines is placed once rather than five times -
      repeating it would turn one warning into five and give a reviewer counting them a number the
      tool never reported.
- [ ] Artifacts: uploaded by glob, content-addressed, downloadable individually and as a set,
      searchable within a run, with retention policy and expiry visible before it happens
- [ ] Artifacts are downloadable by later steps in the same run by name, which is the only reason
      most artifacts exist
- [ ] Run metadata: string key/value pairs any job in a run can read or write, with
      compare-and-set so two parallel jobs cannot lose a write
- [x] Run and job state machines exposed exactly as phase 9 defines them, with the interface, API,
      and webhooks reading the same states rather than three vocabularies

      The run list and the run page, at `/{owner}/{repository}/runs` and `/run/{number}`. One
      mapping in `resources/functions/runs.ts` turns a state into a word and a tone, and **the word
      is the state, capitalised** - the way this goes wrong is not a disagreement about data, it is
      a screen inventing a friendlier synonym, and then "Stopping" is in the interface while
      `cancelling` is in the API and somebody has to know they are the same thing.

      Colour is the second signal and never the only one: the state is written beside the dot,
      because a green dot and a red dot are the same shape to a reader who cannot tell those two
      colours apart.

      A blocked job says **what it is waiting for**, from the row it already has. "Blocked" alone
      sends somebody to open the workflow file to find out something the page knows. And the two
      commits are shown when they differ - what the run is about, and where its workflow came from -
      because a reader who cannot see that difference cannot tell a run of their code from a run of
      their code by somebody else's workflow.

      Webhooks for run transitions are not wired; the box's third vocabulary has no consumer yet.
- [ ] A dependency graph view: what ran, what is running, what is blocked and on what, and the
      critical path through the run
- [ ] Timing on every job: queue time, run time, and the difference between them, because a slow run
      is usually a queue problem and the graph should say so
- [ ] Rerun a whole run, rerun failed jobs only, and rerun one job, each recording that it is an
      attempt rather than overwriting the first
- [ ] Cancel a run and cancel a job, cooperative first and forced after a deadline (phase 9)
- [ ] Unblock a block step from the interface, the API, and the CLI, recording who did it, and
      collecting input fields where declared
- [ ] A run's provenance is always visible: which workflow version, which commit, which trigger,
      which actor or token, which runner, and which pool
- [ ] Keyboard navigation through jobs and log sections, and a run page that is readable with no
      JavaScript for the finished case, in line with the phase 14 rule
- [ ] Tests: a run page rendered server-side for a finished run, redaction of a secret that appears
      in a log line split across two writes, an annotation replaced by context key, metadata written
      by two parallel jobs, and artifact download authorization from a different repository

---

## Security

Phase 9's execution-plane gate covers sandboxing. This section is the part that applies even when
every runner is somebody else's machine.

- [ ] **Signed workflows.** The control plane signs each step it dispatches, over the command,
      environment, plugins, and matrix values; the runner verifies before executing. Without this,
      anyone who can write to the control plane's database can execute arbitrary code on every runner
      in the fleet.
- [ ] Verification is enforceable per pool, and a pool can be set to refuse any unsigned step
- [ ] Key management: generation, rotation, and multiple active verification keys during a rotation
- [ ] **OIDC.** A job can request a short-lived token, scoped to the run, repository, workflow, and
      branch, to authenticate to an external service without a stored credential. This is how a
      deploy stops needing a long-lived cloud key.
- [ ] OIDC claims are documented and stable, so a cloud trust policy written against them keeps
      working
- [ ] Secrets stored encrypted, scoped to a pool, repository, or environment, injected only into the
      steps that name them, never listed in plaintext after creation
- [ ] The recommended path stays an external secret store, with first-party support for fetching from
      one, because the best secret is one we never held
- [ ] Fork policy: a run triggered from a fork gets no secrets and no OIDC by default, cannot supply
      the workflow definition it runs under, and requires approval to run at all. Phase 9 states this
      rule; this is where it is enforced in the dispatch path.
- [ ] Fine-grained token permissions for reading runs, dispatching runs, managing workflows,
      administering pools, and reading logs, each separable, per the [phase 1](./01-foundation.md)
      rule that there is no fallback token type
- [ ] Every state-changing operation is in the audit log from [phase 11](./11-self-hosting-deploy.md),
      attributable to a token as well as a person
- [ ] Tests: a forged step signature, a rotated key mid-run, an OIDC token used against another
      repository's trust policy, a fork run attempting secret access, and a token with dispatch but
      not admin attempting each admin route

---

## Test intelligence

Buildkite Test Engine is a separate product and, for a lot of their customers, the reason they are
there at all. It ingests test results from any CI, not just their own, which is the shape to copy: it
should work for a repository that has not moved its CI here yet.

- [x] `TestSuite`, `TestRun`, `TestExecution`, and `ManagedTest` models. A test is identified by
      suite, scope, and name; scope is what separates two tests with the same name.

      A rename makes a new test, deliberately. Guessing that `renders the header` and
      `renders a header` are the same test is guessing about intent, and being wrong loses the
      history of the test that still exists - which is the history somebody is about to decide
      from. `tests/e2e/test-intelligence.test.ts` says so out loud.

- [x] Ingest JUnit XML and a documented JSON format over an authenticated endpoint, from any CI,
      with the run tied to a commit and optionally a pull request

      `/api/repos/tests/ingest`, with `check:report` - the ability a CI integration already has to
      say a commit passed. Reporting *which* tests passed is the same act at a finer grain, and a
      new scope would mean every existing integration asking for one more permission to tell you
      more. The reporter's own `key` makes the run idempotent, because every collector retries and
      a doubled history is one flake detection then answers from.

      **JUnit is read with a scanner, not an XML library.** The input is a file from a machine this
      instance does not control; a reader that cannot be made to resolve an external entity or
      allocate a gigabyte is worth more here than one that handles namespaces.
      `tests/unit/test-junit.test.ts` proves `&xxe;` stays text, and that a truncated report keeps
      the cases before the cut rather than being thrown away whole.

- [ ] First-party collectors for the frameworks people actually use, starting with the ones this
      repository could use on itself, and a documented protocol so the rest are writable by anyone

      The protocol is written (`docs/test-intelligence.md`); the collectors are not. Anything that
      emits JUnit already works, which is most things, so this is convenience rather than reach.

- [x] Per-execution: result, duration, retries, failure message, stack, and the job it ran in
- [x] Tags as dimensions on an execution, for filtering and aggregation

      Both are why the JSON format exists: JUnit cannot carry retries or a dimension without
      somebody inventing an attribute, and a failure that only happens on one browser or one shard
      is the most useful thing a suite can say.

- [x] Ownership: map a test to a team or a path, so a failure has an addressee
- [x] **Flaky detection**: a test that passed and failed on the same commit, or that changes verdict
      across reruns, over a configurable window

      Two shapes, over the last twenty executions: disagreeing about one commit, and passing only
      after a retry. **The second is the one tools throw away** - a reporter that stores the final
      verdict has already lost the fact that the test failed twice first.

      One failure is a failure, not a flake. Calling it flaky there is telling somebody to ignore a
      broken test.

- [x] Test states: enabled, muted, skipped. A muted test still runs and still reports, but does not
      fail the run. A skipped test does not run. The difference matters and most tools conflate it.
- [x] Quarantine is auditable and expires: who muted it, when, why, and a review date, so quarantine
      does not become a graveyard

      A mute needs **both** a reason and a review date or it is refused, and the listing marks the
      ones whose date has passed `overdue`. The friction is the point: thirty seconds against a
      test that would otherwise be off forever.

      Muted failures are counted, kept in the test's history, and shown - they are only set aside
      when the endpoint reaches a verdict. So the day the test starts passing again is visible,
      which is exactly what skipping it destroys.
- [x] Monitors and actions: a rule that watches a test over time, raises an alarm when a condition
      holds, recovers when it stops, and fires an action once per transition rather than per run

      Three conditions - `fail_rate`, `flaky`, `duration` - and no expression language, because a
      general one is a second product to document, test and get wrong.

      **The state lives on the monitor, and that is the whole design.** "Is the failure rate above
      five percent" is true every hour it is true, so a rule that acted on the answer would send
      the same alarm twenty-four times a day - and the channel it arrives on is the one that has to
      work the day it matters. A monitor in alarm for a month sends one message.

      Three decisions the tests hold. A **measurement it could not take is not a recovery**: a
      suite nobody reported for would otherwise clear an alarm because the reporting broke, which
      is when the alarm matters most. A **muted test cannot cause one**, since its failures are set
      aside everywhere else and counting them here would alarm on exactly the tests somebody
      already decided about. And **exactly at the threshold is not over it**, because "above five
      percent" is what somebody wrote down.

      The threshold for `fail_rate` is a percentage rather than a share, which is a decision about
      a trap rather than about taste: `5` typed at a field wanting a share is five hundred percent,
      a monitor that can never fire, and it reads as covered.

      Found on the way: `schema.double()` is an alias for `float` in ts-validation, so it generates
      a four-byte column that hands `2.5` back as `2.5000000596046448`. Thresholds are `decimal`,
      which is exact - and percentages fit its two decimal places, where shares would not.

      Transitions leave as the `test:monitor` webhook with `alarm` or `recovered` in `action`.
      Webhook-only, like `check:reported`: nobody wants an inbox entry each time a suite wobbles.
- [x] Reliability and duration trends per test, per suite, and per branch, with the slowest and least
      reliable surfaced without a query

      A Tests tab on the repository, beside Runs. "Without a query" is the whole requirement: every
      number on it is derivable from the execution table by anybody willing to write SQL, which
      means in practice nobody looks, and the slow test that got slower over four months stays
      invisible until somebody wonders why CI takes eleven minutes.

      **Ranked by total time, not by the slowest single run.** A 40ms test that runs in every one
      of two thousand executions costs more than the one nine-second test, and the total is what
      the wall clock feels.

      The page states its own evidence: a test with fewer than five runs in the window is not
      ranked, and the number left out is shown. A reliability figure computed from four executions
      is not a measurement, and presenting it as one teaches people to distrust the rest of the
      page. `?branch=` narrows it, which is what makes "per branch" true rather than claimed.
- [x] **Test splitting**: a client that distributes a suite across parallel jobs using historical
      timing, so `parallelism` stops meaning "split alphabetically and hope"

      Longest-processing-time-first, which is within 4/3 of optimal and enough - the input is
      estimates, so chasing an optimal partition of approximate numbers buys nothing. What matters
      is that the big items are placed first: placing them last is how one node ends up eleven
      minutes long while another finishes in forty seconds.

      **Two properties matter more than the quality of the partition, because both are silent when
      they break.** Every item lands on exactly one node - a test that runs twice wastes a machine,
      a test that runs nowhere stopped being run and nothing says so. And every node computes the
      same partition without talking to any other, which makes determinism load-bearing down to how
      ties are broken.

      For a job here the runner writes `reviewos-split` onto the PATH beside `reviewos-upload`, so
      a sharding job needs no repository credential: the job token it already holds can read the
      timings. `tests/unit/runner-shell-commands.test.ts` executes both generated scripts, which is
      how the first one's broken escaping was found - a `\n` in a template literal became a real
      newline inside a JavaScript string, and nothing type-checks a shell script.

- [x] Splitting degrades honestly with no history: deterministic partition, and a note saying it had
      nothing to work with

      And a file nobody has timed is assumed to cost what a typical file costs, not nothing. Zero
      is the obvious default and it hides: adding zero never changes which node is cheapest, so
      every new file lands on the same node - the pull request that added twelve test files would
      put all twelve on one.
- [x] Test results appear on the pull request, and a newly flaky test introduced by a branch is
      distinguishable from one that was already flaky on the base

      A Tests panel on the checks tab: which tests failed and what they said, the per-suite counts,
      and the sentence nobody else writes - "this branch made 1 test flaky", against "6 were
      already flaky on main, so this branch did not cause them".

      **The distinction is measured, not read off a flag.** Flakiness elsewhere is a property of
      the test, so a test unreliable on main for a month decorates every pull request that touches
      nothing near it, and "there are seven flaky tests" becomes a sentence reviewers skip. Here
      the same rule runs twice, over this branch's history and over the base's, and the difference
      is the only part anybody has to act on.

      A commit nothing has reported on says so rather than showing green, which is the rule the
      checks rollup beside it already follows: green for unmeasured is how a misconfigured
      collector goes unnoticed for a month. `tests/e2e/pull-tests.test.ts`.
- [x] Retention policy on execution data, configurable, with the storage cost stated

      `test_retention_days`, an instance setting, default 90, swept daily. Executions are the one
      table in this product that grows with how often *machines* run rather than with how much
      people do - two thousand tests reported on every commit is two thousand rows per push.

      The cost is stated rather than left to be discovered: about 220 bytes per execution with
      indexes, so two thousand tests at ten pushes a day for ninety days is roughly 400MB. Zero
      keeps everything and the setting's own description says the cost is then unbounded, because
      finding that out from a full disk is the failure worth spending a sentence on.

      **Tests, suites, mutes, owners and reasons are never swept**, only executions and the runs
      they belonged to. Those are decisions somebody recorded rather than data that accumulated,
      and a sweep that took the mute with the history would silently un-quarantine a test. Batched
      at two hundred runs, because the first sweep on a year of history is otherwise one statement
      against millions of rows holding a lock long enough for pushes to time out.
- [ ] REST API, webhooks, and generated OpenAPI for suites, runs, executions, and states

      The two endpoints and their OpenAPI are generated and published; the webhook events are not,
      and belong with the run and job events on the delivery list below rather than on their own.

- [x] Tests: ingestion of a malformed report, the same run reported twice, a test renamed between
      runs, flake detection across a rerun, and muting that does not hide the result

      Fourteen in `tests/e2e/test-intelligence.test.ts`, twelve in `tests/unit/test-junit.test.ts`.
      The malformed case is the load-bearing one: a collector posting an HTML error page, because a
      proxy answered instead of the file it meant to send, must not read as a suite with no tests -
      which is indistinguishable from a suite that passed.

      Splitting has its own twelve in `tests/unit/test-split.test.ts` and three more over HTTP,
      including the partial-history case.

---

## Delivery

Phase 9 owns deployments. Two Buildkite capabilities sit next to them and belong here.

- [ ] Preview environments linked on the pull request, expiring on merge or close, using phase 9's
      deployment model rather than a second one
- [ ] macOS runners as a first-class case in documentation and pool configuration: they are how
      mobile delivery works and they are the case every CI product handles worst
- [ ] Signing material and store credentials as environment-scoped secrets released only to the
      publish step, never to build or test steps
- [ ] Tests: a preview expiring, a build step attempting to read a publish secret

---

## Insight

Buildkite sells reporting on the fleet, and it is the thing an operator opens on a Monday.

- [ ] Per workflow and per repository: run count, success rate, duration percentiles including p95,
      failure by step, and retry rate, over a selectable window
- [ ] Queue wait time by queue and by pool, which is the number that tells an operator to add runners
- [ ] Runner utilization and idle time, which is the number that tells them to remove some
- [ ] Cost proxies: total run minutes by repository, owner, and queue. We do not bill, but somebody
      self-hosting this pays for the machines and should be able to see where they went.
- [ ] Flaky test impact: runs failed by a test that was already known flaky, which is the argument
      for fixing it
- [ ] The whole surface is available through the API in the same shape as the screens

---

## Clients

Buildkite's surface is reachable from a terminal, from Terraform, and from a program, and phase 12
already commits us to the principle. These are the pipeline-specific pieces.

- [ ] CLI: validate a workflow, dispatch one, follow logs, inspect a run, unblock a step, cancel,
      and retry from a step, as a client of the public API only ([phase 12](./12-api-and-agents.md))
- [ ] Workflows as code: a typed SDK, in the shape Cloudflare's `@cloudflare/ci` demonstrates, where
      the workflow is a program and ordinary control flow expresses the graph. It runs as an
      orchestrator job under the durable-execution rules in
      [phase 9](./09-checks-ci.md), never in the control plane, and it produces the same normalized
      rows as a YAML workflow. This is the second front door, not a second product.
- [ ] The SDK's determinism rules are enforced by its own types and a lint rule where they can be,
      and by the replay check where they cannot. An author should learn about a forbidden clock read
      from an editor, not from a diverged run three weeks later.
- [ ] Terraform provider covering workflows, schedules, pools, queues, tokens, and secrets, because
      a fleet that cannot be declared is a fleet that drifts
- [ ] MCP surface for runs, logs, and test results, so a coding agent can read a failure without
      scraping a page
- [ ] Webhook events for every run, job, and test transition, redelivered through
      [phase 5](./05-notifications-webhooks.md)
- [ ] Notifications on run outcome, per workflow and per step, to the channels phase 5 already
      delivers, with a rule set rather than an on/off switch
- [ ] A status badge endpoint, cached, for a workflow on a branch

---

## Arriving from somewhere else

A migration path is a feature. There are two of them and they are not the same shape.

**From GitHub Actions there is no migration**, and that is the point of the compatibility section:
the workflow files are the workflow files. What is still needed is everything around them.

- [ ] [Phase 8](./08-migration.md)'s importer carries workflow files across untouched, and reports
      which constructs the conformance suite says will not run yet, before the move rather than after
- [ ] Repository and organization secrets, variables, and environments import as part of the same
      operation, since a workflow without them is green in the file and red in the run
- [ ] Self-hosted runner labels are preserved, so `runs-on: [self-hosted, gpu]` keeps meaning what it
      meant
- [ ] A per-repository report after import: workflows found, constructs unsupported, actions
      referenced that the instance cannot resolve, and what to do about each
- [ ] Tests: import a real repository's workflow directory and assert the run graph matches what
      Actions produced for the same commit

**From Buildkite it is a translation**, and it is cheap because their format is public.

- [ ] An importer that reads a `pipeline.yml` and emits workflow YAML, reporting per step and per
      attribute what translated, what translated with a change in meaning, and what has no
      equivalent. The report is the deliverable; a silent partial translation is worse than a refusal.
- [ ] A documented mapping table from their vocabulary to ours, which is the table at the top of this
      file plus the attribute list
- [ ] A stated position on plugin compatibility: their plugin interface is hook scripts plus a
      parameter schema, which is close enough that compatibility is a decision rather than a
      rewrite. Decide, write it down, and do not leave it implied.
- [ ] Test result import so history survives the move, since the flaky verdict is the part that took
      months to accumulate

---

## Not copying

Named so they stop being re-proposed, in the manner of the index's deferred list.

- **Seat pricing, managed test pricing, and compute minutes.** There is no meter. Several Buildkite
  features exist to make a meter legible and have no purpose here.
- **A hosted execution plane, for now.** Unchanged from [phase 9](./09-checks-ci.md): it does not
  begin until the threat model, isolation boundary, secret flow, cache policy, and quotas pass
  review. Everything in this file is deliberately useful with only self-hosted runners.
- **A package registry, for now.** Buildkite sells one and it is a real gap against them. It stays on
  the deferred list in [the index](./index.md) until the forge is good, with the standing condition
  that when it lands, `packages:read` and `packages:write` are fine-grained token permissions from
  the first commit ([phase 1](./01-foundation.md#access-tokens)). Writing that condition down now is
  the entire point of naming it here.
- **A second receive pipeline.** Push triggers consume the `push:received` event from
  [phase 2](./02-git-hosting.md), as phase 9 already says.
- **A better workflow language.** There is a good argument that Actions YAML is not a good format,
  and it does not matter. It is the format people have, the format the ecosystem targets, and the
  format a repository can leave with. The typed SDK in the clients section exists for anyone who
  disagrees, and it emits the same graph. Inventing a third language is how a CI product acquires
  users it already had and loses the ones it wanted.
- **Bug-for-bug fidelity with GitHub.** Compatible means a normal workflow runs unchanged, not that
  every undocumented behavior is reproduced. Where we differ, the conformance report says so and the
  parser warns. The line between those two is a judgement call, made per construct, written down.
