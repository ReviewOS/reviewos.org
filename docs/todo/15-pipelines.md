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
- [ ] A conformance suite pinned to a corpus of widely used public workflows, run in CI, reporting
      which constructs pass, which are unimplemented, and which are refused on purpose. The report is
      published. Silence about a gap is how Gitea's ignored `concurrency:` surprised people.
- [ ] Where behavior deliberately differs from GitHub, it is documented per key with the reason, and
      the parser emits a warning naming the difference rather than quietly doing something else

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
- [ ] `jobs:` with `needs:`, `if:` (**decided at dispatch now** - a job whose condition is false is
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
      every `exclude` miss. `continue-on-error` and `outputs` are parsed but nothing consumes them
      yet.
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

      `if` is stored as written and not evaluated, which is the expression engine's job.
- [ ] `container:` and `services:` on a job, with `image`, `env`, `ports`, `volumes`, `options`, and
      health-checked service startup before the first step
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
- [ ] `secrets:` on `workflow_call`, including `inherit`
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
- [ ] `environment:` on a job, wired to phase 9's deployment environments and their protection rules,
      including required reviewers and wait timers
- [ ] Reusable workflows via `uses:` at job level, local and cross-repository, with inputs, secrets,
      and outputs, and the called workflow's jobs shown in the run rather than collapsed to one box
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
- [x] The expression evaluator is sandboxed and total: no host access, no unbounded evaluation, and a
      documented failure mode for an expression that cannot be resolved.

      The failure mode is written down and tested in both places it matters. **An `if:` that cannot
      be evaluated does not run the job**, because the other direction deploys somebody's code
      because their condition had a typo; the reason is recorded on the job, since a skipped job is
      the one outcome with nothing else to look at. **An interpolation that cannot be evaluated
      stays as written**, rather than becoming an empty string somebody has to explain.
- [ ] Tests: an expression suite ported from Actions' own documented examples, including the ones
      that are surprising

### The runner protocol Actions expects

This is where compatibility is actually won or lost. A workflow file that parses but whose steps
cannot talk back to the runner is a workflow that fails on its second line.

- [ ] Workflow commands on stdout: `::error::`, `::warning::`, `::notice::` with `file`, `line`,
      `col`, and `endLine`, plus `::group::`, `::endgroup::`, `::debug::`, `::add-mask::`,
      `::add-matcher::`, and `::stop-commands::`
- [ ] `::error file=...,line=...::` becomes a check annotation, which becomes a comment on the diff
      line. This is the sentence where the Actions ecosystem and this project's whole premise meet,
      and every linter, compiler wrapper and test reporter already emits it.
- [ ] File-based protocol: `GITHUB_OUTPUT`, `GITHUB_ENV`, `GITHUB_PATH`, `GITHUB_STATE`, and
      `GITHUB_STEP_SUMMARY`, with the multiline delimiter form, under both `GITHUB_*` and
      `REVIEWOS_*` names
- [ ] Step summaries render as markdown on the run and, where they belong to a check, on the pull
      request
- [ ] The default environment variable set: `GITHUB_REPOSITORY`, `GITHUB_SHA`, `GITHUB_REF`,
      `GITHUB_REF_NAME`, `GITHUB_HEAD_REF`, `GITHUB_BASE_REF`, `GITHUB_WORKSPACE`, `GITHUB_ACTOR`,
      `GITHUB_RUN_ID`, `GITHUB_RUN_NUMBER`, `GITHUB_RUN_ATTEMPT`, `GITHUB_EVENT_NAME`,
      `GITHUB_EVENT_PATH`, `GITHUB_SERVER_URL`, `GITHUB_API_URL`, and the rest, each aliased
- [ ] `GITHUB_EVENT_PATH` contains an event payload matching the shape of the webhook payloads from
      [phase 5](./05-notifications-webhooks.md), because half the ecosystem parses it
- [ ] An automatic per-job token, scoped to the run and the repository, expiring with the job,
      honouring the `permissions:` block, and never granted to a fork run by default. This is
      `GITHUB_TOKEN` and the ecosystem assumes it exists.
- [ ] The API endpoints that automatic token is used against by common actions, at
      `GITHUB_API_URL`, in the same shapes, so `actions/github-script` and friends work
- [ ] Secret masking in logs, including values registered at runtime with `::add-mask::`

### Resolving `uses:`

- [ ] Local actions: `uses: ./.reviewos/actions/thing`
- [ ] Container actions: `uses: docker://registry/image:tag`
- [ ] Remote actions by owner and name with a configurable default host, plus fully qualified URLs,
      so an instance can point at its own mirror, a public mirror, or GitHub
- [ ] Ref resolution by tag, branch, and commit sha, with sha pinning enforceable by policy
- [ ] An action cache on the instance, so a fleet of runners does not each fetch the same action, and
      so an instance can keep working when the upstream host does not
- [ ] Mirroring of the actions a repository actually uses into the instance ([phase 13](./13-mirroring.md)
      already mirrors repositories), so an air-gapped install is a supported configuration
- [ ] An allowlist policy at instance and owner level over which action sources may be used, since
      `uses:` is arbitrary code selection by anyone who can edit a workflow file
- [ ] Tests: every resolution form, a pinned sha that does not match, an action outside the
      allowlist, an unreachable upstream with a warm cache, and a local action outside the repository

### First run

Actions users do not provision anything. They push a file and it runs. That expectation does not
survive contact with a self-hosted forge unless we make it.

- [ ] A single documented command brings up a runner and registers it with the instance
- [ ] A default queue exists on a new instance, so `runs-on: ubuntu-latest` resolves to something
      without configuration
- [ ] Optionally, the instance ships with one local runner enabled for single-tenant installs, off by
      default for multi-tenant ones, with the tradeoff stated plainly rather than buried
- [ ] The interface says clearly when a run is queued because no runner matches, and which labels
      would have matched, instead of a spinner
- [ ] A repository with no workflows offers starter templates that are real Actions workflows

### Where the compatible forges stop, and we do not

Gitea and Forgejo both chose Actions compatibility and both proved it works. The places they fall
short are documented, and they are precisely the Buildkite capabilities in the rest of this file,
which is the whole argument for this phase existing:

| They do not have | We do, and it is in this file |
|---|---|
| `concurrency:` groups (ignored by Gitea) | The concurrency engine, ordered and eager |
| Scheduled workflows (ignored by Gitea) | Schedules with branch, message, and environment |
| Complex `runs-on` expressions | Queue plus tag selection, with a visible reason when nothing matches |
| Environment protection rules | Phase 9 deployments, reviewers, wait timers, and scoped secrets |
| Test intelligence of any kind | Flaky detection, quarantine, splitting, ownership |
| Fleet management beyond a registered runner | Pools, queues, autoscaler contract, drain, lifecycle |
| Signed step dispatch | Signed workflows, enforceable per pool |
| Annotations on the diff | The reason this project exists |

- [ ] Each row above has a test proving the difference, because a comparison table in marketing that
      no test defends becomes false without anybody noticing

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

- [ ] **Command step.** One or more shell commands, or a `uses:` action. The only kind that consumes
      a runner, and the only one an Actions workflow writes directly.
- [ ] **Wait step.** A barrier. Everything before it must finish before anything after it starts,
      with a variant that continues on failure. `needs:` covers most of this; an explicit barrier
      covers the rest.
- [ ] **Block step.** Pauses the run until a human unblocks it. The approval gate, and the primitive
      phase 9's "waiting steps" already describes. Reached from Actions syntax through
      `environment:` protection rules.
- [ ] **Input step.** Pauses and collects typed fields (text, select, boolean) from the person
      unblocking it, which become available to later steps.
- [ ] **Trigger step.** Starts a run of another workflow, in this repository or another, passing
      commit, branch, environment, and metadata. Async by default, awaitable on request. Actions
      reaches this through `workflow_call` and `repository_dispatch`.
- [ ] **Group step.** Nests steps under one label so a run with two hundred jobs reads as eight
      things. Groups carry their own dependency edges and rollup state.

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
- [ ] `retry`, automatic and manual. Automatic retries key on exit status, a lost runner, and a
      timeout, with limits and constant, linear, or exponential backoff. Manual retry can be
      permitted, forbidden, or forbidden with a reason.
- [ ] `timeout_in_minutes`, per step, with a workflow default and an instance ceiling
- [ ] `priority`, so a deploy jumps a queue full of pull request checks
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
- [ ] `if_changed`, path-glob gating evaluated against the run's diff. The monorepository primitive,
      and the one that decides whether a big repository is usable here at all.
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

- [ ] Every additive key above is documented as an extension, in one place, with what happens when a
      workflow using it is taken back to GitHub. An extension nobody can find, or that silently
      breaks portability, is worse than not having it.

### Dynamic definitions

Buildkite's most important feature and its largest security surface. A job can generate steps and
upload them into the run it is already part of, so a workflow can decide what to do after looking at
the repository. Actions has only a shadow of this: a matrix built from `fromJSON` of a prior job's
output, which covers the common case and nothing else.

- [ ] A runner-side upload command that appends steps to the current run, validated by the control
      plane before any of them become eligible
- [ ] Uploaded steps are attributed to the job that uploaded them, and the run records the full
      resulting graph rather than only what was declared at the start
- [ ] An uploaded step cannot raise its own trust level: it cannot grant itself secrets, target a
      queue the parent could not, or turn a fork run into a trusted one
- [ ] An upload budget: maximum steps, maximum depth, maximum total uploads per run, so a loop is
      bounded by the control plane rather than by a quota nobody set
- [ ] Signature verification. When signed workflows are enforced (below), an uploaded step must be
      signed by a key the runner pool trusts, or refused.
- [ ] Tests: uploading a step that targets a forbidden queue, an upload loop, an upload from a fork,
      an unsigned upload under enforcement, and an upload after the run reached a terminal state

### Definition management

- [ ] Workflow templates, owner-managed, so an organization can require a starting point. This is
      phase 9's "owner-managed reusable workflows" from the governance side rather than the reuse
      side.
- [ ] Schedules in cron syntax, per workflow, each with its own branch, commit, message, and
      environment, plus enable and disable without deleting
- [ ] Skip intermediate runs and cancel intermediate runs, per workflow: when three commits land in a
      minute on the same branch, do not run all three
- [ ] Merge queue support: a run against the prospective merge result rather than the branch tip, so
      a queue of pull requests is tested in the order it will land
- [ ] A workflow can live at a path other than the repository root, and more than one can live in one
      repository
- [ ] Environment variables and settings at instance, owner, repository, and workflow level, with a
      documented precedence order and a screen that shows where a value came from
- [ ] Tests: schedule fires once per window, intermediate cancellation leaves exactly one run, a
      template change does not retroactively alter a finished run

---

## The runner fleet

Buildkite's agent is the part of it that is open source, and the part people trust it for. Phase 9
defines the protocol; this is the fleet management around it.

- [ ] Runner pools: a named group of queues plus the workflows permitted to use them. A workflow in
      one pool cannot dispatch to, read artifacts from, or trigger a workflow in another unless a
      rule says so.
- [ ] Queues within a pool, named for infrastructure rather than for teams, with pause and resume so
      an operator can drain one without deleting it
- [ ] Registration tokens scoped to one pool, rotatable, revocable, with a first-use and last-use
      record. Registration credentials never enter a job environment (phase 9 rule).
- [ ] Runner tags, set at registration and by a startup hook, queried by a step's `agents` selector.
      Unmatched selectors leave a job queued with a visible reason rather than silently forever.
- [ ] Runner lifecycle visible in the interface: connecting, idle, accepted, running, stopping,
      stopped, lost, with the job it is on and the time in state
- [ ] Ephemeral runners: disconnect after one job, or after an idle timeout, which is what makes an
      autoscaling group safe
- [ ] Graceful stop that lets the current job finish, and a forced stop that does not, both from the
      API
- [ ] A metrics endpoint reporting queue depth, waiting jobs per queue, and runner counts by state,
      in a shape an autoscaler can poll. This is the whole interface an autoscaler needs.
- [ ] Reference autoscaler for at least one substrate, plus documentation of the polling contract for
      the ones we do not write
- [ ] Pool maintainers: a role that can manage queues, tokens, and workflow assignment without being
      an instance administrator
- [ ] Tests: a job with an impossible selector, a runner lost mid-job, a drained queue, a revoked
      token mid-job, and a runner claiming work from a pool it is not registered to

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

- [ ] `TestSuite`, `TestRun`, `TestExecution`, and `ManagedTest` models. A test is identified by
      suite, scope, and name; scope is what separates two tests with the same name.
- [ ] Ingest JUnit XML and a documented JSON format over an authenticated endpoint, from any CI,
      with the run tied to a commit and optionally a pull request
- [ ] First-party collectors for the frameworks people actually use, starting with the ones this
      repository could use on itself, and a documented protocol so the rest are writable by anyone
- [ ] Per-execution: result, duration, retries, failure message, stack, and the job it ran in
- [ ] Tags as dimensions on an execution, for filtering and aggregation
- [ ] Ownership: map a test to a team or a path, so a failure has an addressee
- [ ] **Flaky detection**: a test that passed and failed on the same commit, or that changes verdict
      across reruns, over a configurable window
- [ ] Test states: enabled, muted, skipped. A muted test still runs and still reports, but does not
      fail the run. A skipped test does not run. The difference matters and most tools conflate it.
- [ ] Quarantine is auditable and expires: who muted it, when, why, and a review date, so quarantine
      does not become a graveyard
- [ ] Monitors and actions: a rule that watches a test over time, raises an alarm when a condition
      holds, recovers when it stops, and fires an action once per transition rather than per run
- [ ] Reliability and duration trends per test, per suite, and per branch, with the slowest and least
      reliable surfaced without a query
- [ ] **Test splitting**: a client that distributes a suite across parallel jobs using historical
      timing, so `parallelism` stops meaning "split alphabetically and hope"
- [ ] Splitting degrades honestly with no history: deterministic partition, and a note saying it had
      nothing to work with
- [ ] Test results appear on the pull request, and a newly flaky test introduced by a branch is
      distinguishable from one that was already flaky on the base
- [ ] Retention policy on execution data, configurable, with the storage cost stated
- [ ] REST API, webhooks, and generated OpenAPI for suites, runs, executions, and states
- [ ] Tests: ingestion of a malformed report, the same run reported twice, a test renamed between
      runs, flake detection across a rerun, muting that does not hide the result, and splitting with
      partial history

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
