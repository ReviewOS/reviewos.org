# Extensions

Everything this instance can do that GitHub Actions cannot, in one place, under
one key.

A workflow file here is an Actions workflow file. That is the whole compatibility
promise, and [the conformance table](./conformance.md) is where it is checked key
by key. This page is the other half: the small number of things the engine can do
that the Actions surface has no word for, and what it costs to use them.

## The one key

Every extension lives under `reviewos:` on a job:

```yaml
jobs:
  approve:
    reviewos:
      block: Deploy to production?
```

One key, on purpose. An extension spread across five new top-level keys is five
things to find when a workflow moves; this is one to delete, and one word to grep
for when somebody asks "what in this repository is not portable".

**What happens if you take it back to GitHub:** the file is refused. GitHub does
not accept a job key it does not know, so a workflow using `reviewos:` does not
run there at all.

That failure is loud, and loud is the right kind. The alternative - a key GitHub
silently ignores - would mean a `block:` gate that is simply not there on the
other side: a deployment approval that approves itself. If you need a workflow to
run in both places, keep the extensions in a workflow of their own and let the
portable one `needs:` nothing from it.

## Step kinds

Actions has one kind of job: a list of commands that a runner executes. This
engine has four. The other three are decided by the control plane and **never
reach a machine** - a runner is never offered one, which is what makes a gate a
gate rather than a suggestion.

### `wait` - a barrier

```yaml
jobs:
  build:
    runs-on: ubuntu-latest
    steps: [{ run: make }]
  test:
    runs-on: ubuntu-latest
    steps: [{ run: make test }]

  everything-built:
    reviewos:
      wait: true

  deploy:
    runs-on: ubuntu-latest
    steps: [{ run: ./deploy }]
```

Everything declared before the barrier finishes before anything declared after it
starts. It is resolved into `needs:` edges when the file is parsed - the barrier
needs every job before it, and every job after it that named no dependencies of
its own needs the barrier - so **the graph you see on the run page is the graph
that ran**.

A job that names its own `needs:` keeps them. An explicit dependency is a
statement about the graph, and a barrier does not quietly widen it.

The variant that lets a failed run past:

```yaml
  publish-results-anyway:
    reviewos:
      wait:
        continue-on-failure: true
```

**Actions has most of this** as `needs:`. The barrier is worth having when a
stage has six jobs and the next stage has six more: `needs:` means writing
thirty-six edges, and one of them will be wrong.

### `block` - a gate a person opens

```yaml
  approve:
    needs: [build]
    reviewos:
      block:
        prompt: Deploy to production?
        fields:
          - key: version
            type: string
            required: true
          - key: where
            type: select
            options: [staging, production]
```

The run holds at `waiting` - not `running`, because nothing is running - until
somebody with `workflow:approve` on the repository opens it, from the run page or
from `POST /api/repos/workflow-runs/approve`.

The fields become the job's **outputs**, so a later job reads them the way it
reads any other job's:

```yaml
  deploy:
    needs: [approve]
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy --version "${{ needs.approve.outputs.version }}" --to "${{ needs.approve.outputs.where }}"
```

Field types are `string`, `boolean` and `select`. A `select` declares its
options, and a value outside them is refused with the options listed - the whole
reason to declare them is that somebody can be told which ones there are.

Who opened it is recorded on the job and shown on the run.

`block:` with no fields is the short form: `block: Ship it?`

**Actions has no equivalent.** Its nearest thing is an environment protection
rule, which is configured in the interface rather than written in the file.

### `trigger` - start another run

```yaml
  announce:
    needs: [deploy]
    reviewos:
      trigger:
        workflow: announce.yml
        inputs:
          version: ${{ needs.approve.outputs.version }}
```

Starts a run of another workflow in the same repository. The short form is
`trigger: announce.yml`; the workflow is matched on its path or its name, because
both are what people write.

**Async by default.** `await: true` keeps the triggering job running until the
run it started finishes, and carries that run's verdict back - a trigger that
waited and then reported success whatever happened would be a gate that is not
one.

Three rules worth knowing:

- A triggered run is **trusted because the run that triggered it was**. A fork's
  pull request cannot trigger a trusted run: a trigger cannot raise its own trust
  level.
- It carries a **depth**, and five is the ceiling. A workflow that triggers a
  workflow that triggers the first one is otherwise a run factory, and nothing
  else in the model would notice, because every trigger makes a new run.
- A trigger that cannot resolve **fails** with the reason on the job. A pipeline
  whose deploy stage silently did nothing, and a green run to go with it, is the
  failure this whole feature exists to avoid.

**Actions reaches part of this** through `workflow_call` (which runs the called
workflow's jobs inside your run, rather than starting a run of its own) and
`repository_dispatch` (which needs a token and an HTTP call from inside a step).

### `if-changed` - run this job only when these paths moved

```yaml
jobs:
  api:
    runs-on: ubuntu-latest
    reviewos:
      if-changed: packages/api/**
    steps: [{ run: make api }]

  web:
    runs-on: ubuntu-latest
    reviewos:
      if-changed:
        - packages/web/**
        - package.json
    steps: [{ run: make web }]
```

A job whose globs match nothing this push touched is **skipped, with the reason
on the row** - not queued and quietly ignored. A job that names no globs always
runs.

**When the instance cannot tell what changed, the job runs.** A force push, a
first push, or a rewrite past the internal ceiling all leave the changed list
empty, and the two failures are not equal: a job that runs when it need not have
costs a few machine-minutes, and a job skipped when it should have run is a
broken commit nobody noticed.

A `wait` or `block` job cannot carry it, and the file is refused if one does. A
barrier that only sometimes exists changes the shape of the graph, and a gate
that vanishes because no file matched is a gate that approves itself.

**Actions has `on.push.paths`**, which filters the whole workflow. That is the
right tool for "do not run CI for a documentation change" and the wrong one for
a repository with twelve packages in it, where the workflow has to run and the
question is what it runs.

### `retry` - run a failed job again

```yaml
  flaky-integration:
    runs-on: ubuntu-latest
    reviewos:
      retry: 2
    steps: [{ run: make integration }]
```

Two extra attempts, so three runs at most. **The cap is required**, and there is
a ceiling of five: a retry without a limit is a job that fails forever on
somebody else's machine, and a job that fails five times in a row is not flaky,
it is broken. Asking for more is refused with that sentence rather than quietly
clamped.

Every attempt is visible on the run - "attempt 2" next to the job - because a
job that quietly ran twice is a flaky test nobody ever fixes.

Narrow it to the failures worth repeating:

```yaml
    reviewos:
      retry:
        attempts: 2
        exit-status: [137, 7]
```

A test suite that exits 1 because an assertion failed is not worth running
again. A step killed for memory at 137, or a fetch that exits 7, is exactly what
this is for. When statuses are named, a failure with an *unknown* status is not
retried: retrying on "we do not know why it failed" is how a narrow retry
becomes a blanket one.

**A job whose runner keeps disappearing is capped too**, at three, whatever the
workflow says. That one is not a feature you turn on: recovering a job from a
machine that died is what leases are for, but doing it without a limit is one
job taking down a fleet one machine at a time.

**Actions has manual re-runs** of a whole workflow or its failed jobs, and no
automatic retry at all.

### `priority` - which job leaves the queue first

```yaml
  deploy:
    runs-on: ubuntu-latest
    reviewos:
      priority: 10
    steps: [{ run: ./deploy }]
```

Higher goes first; zero is the default; negative means after everything else,
which is where a nightly cleanup belongs. Equal-priority jobs stay first in,
first out, because a queue that reorders equal work is one where somebody's
build can starve.

It orders a queue, it does not preempt. A job already running is not stopped for
a more important one: that would mean killing work somebody is waiting on to
start work somebody else is waiting on, which needs a policy rather than a
number.

**Actions has no equivalent.**

### `agents` - which machines may take this job

```yaml
  train:
    runs-on: ubuntu-latest
    reviewos:
      agents:
        gpu: a100
        region: ash
    steps: [{ run: ./train }]
```

A `key=value` query over the tags a machine reported about itself. The list form
works too: `agents: [gpu=a100, region=ash]`.

**`runs-on:` is a set membership test**, which is the right shape for
`ubuntu-latest` and the wrong one for anything with a value in it. A fleet with
four GPU models ends up with labels called `gpu-a100` and `gpu-a10g`, and a
label means whatever the person who typed it was thinking. A tag query says what
it means.

Every selector has to match, and a machine that reported no tags satisfies none
of them - a job that asked for a GPU waits visibly rather than running somewhere
that never said it had one. A selector that is not `key=value` is refused rather
than read as a label: one that silently became a label would match a different
set of machines than the file says, and a job running somewhere it should not is
invisible.

Tags are set when a machine registers, from whatever its startup script knows
about it. See [autoscaling](./autoscaling.md).

**Actions has no equivalent**; labels are all it has.

### `group` - a label

```yaml
  compile:
    runs-on: ubuntu-latest
    reviewos:
      group: Build
    steps: [{ run: make }]
```

Jobs sharing a label print under one heading, so a run with two hundred jobs
reads as eight things. A label rather than a container: the jobs stay in the
order the file declared them, which is what a reader is checking the screen
against.

**Actions has no equivalent.**

## `intermediate` - what to do with runs that have not started

The one extension that goes at the **top level** rather than on a job:

```yaml
name: CI
on: push
reviewos:
  intermediate: skip
concurrency:
  group: ci-${{ github.ref }}
```

Three commits land in a minute. `run` (the default, and Actions' behaviour) runs
all three. `cancel` is `concurrency.cancel-in-progress` said in one word: stop
whatever is running. `skip` is the third thing, and usually the one people mean:
**let the build that has already started finish, and drop the ones that have
not.**

The difference matters because the run in progress will produce a result
somebody reads, while the queued ones would produce two that nobody does. A
skipped run is `cancelled` outright rather than `cancelling` - nothing had taken
it, so there is no machine to tell - with the reason on the run.

**Actions has `cancel` only**, through `concurrency.cancel-in-progress`.

## Toolchains, instead of container images

Not a `reviewos:` key at all - it needs nothing in the workflow file.

If the checked-out repository has a pantry dependency file (`deps.yaml`,
`dependencies.yaml`, `pkgx.yaml`, or the dotted forms), the runner installs what
it names and puts it on `PATH` for every step:

```yaml
# deps.yaml, in the repository
dependencies:
  - node@22
  - postgresql.org@17
```

```yaml
# .github/workflows/ci.yml - unchanged, portable, no extension keys
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: node --version   # 22, because the repository said so
```

This is the answer to `container: node:20` for the case that is really "give me
node 20", which is most of them. The differences from an image are the point: no
registry, nothing to bake, and a repository that needs a different version
tomorrow changes one line instead of waiting for somebody to rebuild a base
image.

**It is not isolation and this page will not pretend otherwise.** Steps run as
the user who started the runner. If you need isolation, the boundary is a
separate machine - one job per machine with `--jobs 1`, which is what an
autoscaled fleet already gives you. See [autoscaling](./autoscaling.md).

Three properties worth knowing:

- **A repository with no dependency file gets nothing**, and a machine with no
  `pantry` gets a line in the log saying so and carries on. A workflow that
  installs its own tools in a step is how everything written for Actions already
  works, and it keeps working.
- **The repository's toolchain goes on `PATH` before a step's own additions.** A
  step that installed something and wrote to `GITHUB_PATH` is making a decision
  about *this run*, and a pinned version should not override it.
- The runner shells out to `pantry env --install --json` rather than reading the
  dependency file itself. A second implementation of version resolution would
  drift from the first in the one place where being wrong means building against
  the wrong compiler.

## Generated steps

A job can add jobs to the run it is already in - the pipeline decides what to do
after looking at the repository, which is the thing a static file cannot do.

```yaml
jobs:
  plan:
    runs-on: ubuntu-latest
    steps:
      - run: |
          ./what-changed > generated.yml   # writes a `jobs:` block
          reviewos-upload generated.yml
```

`reviewos-upload` is on the PATH of every step, put there by the runner. It
takes a file or stdin, and the document is the `jobs:` mapping on its own -
what a program generating steps has in its hands.

The uploaded jobs join the run: they can `needs:` jobs that are already there,
they show on the run page attributed to the job that made them, and a runner
picks them up as soon as they are eligible.

**What an upload cannot do**, because these are the properties that decide
whether the feature can exist at all:

- **Raise its own trust level.** A fork's run stays untrusted, the repository
  stays the same repository, and the pool serving it stays the pool that already
  served it. The document says *what* to run, never *where* or *as whom* - there
  is no field for it and no code that reads one.
- **Give itself a priority.** Priority is inherited from the job that uploaded,
  so a generated job cannot jump a queue full of other people's work.
- **Outlive the run.** A finished run takes nothing, however alive the machine
  still is - accepting a late upload would add work to a run whose conclusion has
  already been reported to a branch protection rule.
- **Loop.** Three limits, because each alone is a loop somebody can still write:
  three uploads deep, twenty uploads per run, fifty jobs per upload, five hundred
  jobs per run.

The document goes through **the same parser as a workflow file**, so every rule
that refuses a bad job in a repository refuses it here - cycles, unknown keys, a
job with no `runs-on`. A second, laxer validator for uploaded steps would be the
one an attacker reads.

**Actions has a shadow of this**: a matrix built from `fromJSON` of a prior job's
output, where the number of jobs can vary but not what they are.

## What this costs

| | |
|---|---|
| Portability | A file using `reviewos:` does not run on GitHub. It is refused, not ignored. |
| Migration in | Nothing. An Actions workflow uses none of this and behaves identically. |
| Migration out | Delete the `reviewos:` keys. A `wait` becomes `needs:`; a `block` becomes an environment protection rule; a `trigger` becomes `workflow_call` or an API call in a step; `if-changed` becomes a `dorny/paths-filter`-style action plus a step-level `if:`; `retry` becomes a `nick-fields/retry`-style action or a manual re-run; `priority` becomes nothing, since GitHub's queue has no order you can influence; `agents` becomes a label somebody has to keep in step with the machines; generated steps become a `fromJSON` matrix, which covers the case where only the *number* varies; `intermediate: cancel` becomes `concurrency.cancel-in-progress` and `skip` becomes nothing; a `group` becomes nothing, since GitHub has no grouping. |

The engine underneath is documented in
[the pipelines roadmap](https://github.com/stacksjs/reviewos/blob/main/docs/todo/15-pipelines.md),
including the attributes that exist in the model and do not yet have a key on the
surface.

## `services:` without containers

A workflow that writes this is asking for one thing - a database on a port
before the first step runs:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
      cache:
        image: redis:7-alpine
    steps:
      - run: bun test
```

Every other forge answers with a container. This runner has pantry, which
starts and health-checks sixty-eight of exactly these, so the image name is
read as **what the workflow meant** rather than as an artifact to fetch:
`postgres:16`, `postgres:16-alpine` and `docker.io/library/postgres` are all
"a Postgres, please".

A step reaches it on loopback, and the variables are named after the workflow's
own key:

```
$POSTGRES_HOST=127.0.0.1  $POSTGRES_PORT=5432  $POSTGRES_URL=postgres://127.0.0.1:5432
```

**An image nothing here can serve fails the job before a step runs**, with the
image named and the known list printed. Carrying on would produce a connection
refused three minutes later, in a log nobody reads to the bottom, and the person
debugging it has no reason to suspect the `services:` line at all. A job that
genuinely needs an arbitrary image needs a runner with a container engine, which
this is not.

**Started is not ready.** Postgres accepts connections a second or two after the
process exists, so the runner waits for the port rather than for the command -
that gap is where a whole class of flaky CI comes from.

A service already running is used rather than restarted, and is not stopped when
the job ends: pantry's services belong to the machine, and stopping one would
take down the database another job on the same runner is mid-query against.

`container:` is still not implemented, and the reason has not changed - see
above.

## A GitHub-shaped surface at `GITHUB_API_URL`

Actions do not read this instance's API reference. They build
`${GITHUB_API_URL}/repos/{owner}/{repo}/check-runs`, post what Octokit sends,
and read back an `id`. An instance that answers 404 to that is one where
`actions/github-script`, every "report status" action and every annotation
wrapper fails - with an error about a URL, which reads as *this forge is
broken* rather than *this forge is different*.

Three endpoints, which is what CI **writes**:

| Path | What it does |
|---|---|
| `POST /repos/{owner}/{repo}/check-runs` | a check on a commit, with `output.title`, `output.summary` and annotations |
| `POST /repos/{owner}/{repo}/statuses/{sha}` | the older commit-status API |
| `POST /repos/{owner}/{repo}/issues/{number}/comments` | a comment on an issue or a pull request |

What an action *reads*, it already has: the event payload at
`GITHUB_EVENT_PATH`, the environment, and the checkout.

**Everything else answers 404 with the list.** An action told "Not Found" by an
API it believes in retries, blames the token, and eventually blames the forge;
one told which three endpoints exist has been told what to do next.

Two places it is deliberately not identical:

- **`state: error` becomes a failure.** GitHub has four status states and this
  instance has three; `error` and `failure` both mean the commit did not pass,
  and inventing a third to preserve a distinction nothing acts on would be
  compatibility as decoration.
- **Numbering.** GitHub numbers issues and pull requests together. So does the
  comment endpoint here, because they share a table - which is what makes `#12`
  resolve either way.

Every call is this instance's own API with the caller's token, so
`permissions:` in the workflow is what decides whether a write is allowed.
There is no second permission check to disagree with the first.

## Step attributes: `skip`, `soft-fail`, `branches`

```yaml
jobs:
  lint:
    runs-on: ubuntu-latest
    reviewos:
      soft-fail: [1]          # findings do not fail the run; a missing linter does
      branches: [main, '!wip/*']
    steps:
      - run: ./lint

  vendor:
    runs-on: ubuntu-latest
    reviewos:
      skip: The vendor API is down until Tuesday.
    steps:
      - run: ./vendor
```

**`skip` takes a reason**, and that is the difference between a job somebody can
decide about in three weeks and a commented-out block nobody reads. The reason
shows on the run beside the job.

**`branches` is the shorthand for the most common `if:`.** `if: github.ref ==
'refs/heads/main'` is what everybody writes and a good share get wrong -
`refs/heads/` is easy to forget, and the failure is silent, because a condition
nobody matches is a job that simply never runs. An exclusion beats an inclusion,
which is what every other tool with both does and the safer reading: `['*',
'!release/*']` means *not release*.

Both decide **when the run is created**. A job that will never run reads as
skipped from the first second, rather than sitting in the queue looking like
work nobody has got to - which is how somebody ends up investigating a runner.

**`soft-fail` decides at the report**, because it keys on an exit status that
does not exist until the job has failed. `true` tolerates any failure; a list
tolerates the ones worth tolerating - a linter exiting 1 on findings is a soft
failure, and the same linter exiting 127 because it is not installed is a broken
pipeline wearing a green tick. A failure with no exit status at all (a lost
runner, a timeout) is **not** tolerated by a status list.

The job still reports `failed`. A screen that showed a tolerated failure as
passing is one where nobody finds out the linter has been failing for a month;
what changes is that the run does not fail with it.

## `allow-dependency-failure`

The "publish the results whatever happened" stage:

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps: [{ run: ./test }]

  publish-results:
    runs-on: ubuntu-latest
    needs: [test]
    reviewos:
      allow-dependency-failure: true
    steps: [{ run: ./publish }]
```

It is the graph-level twin of `if: always()`, and the difference matters: the
dependencies still have to be **finished**, only their verdict stops mattering.
A job that needed a failed one and did not ask for this is skipped, as it always
was.

It reaches the graph as the same flag a `wait:` barrier's `continue-on-failure`
sets, rather than as a second mechanism. One rule with two spellings is one that
disagrees with itself a year later.

## What a job's `if:` may read

A sandbox, and this is the whole of it:

| | |
|---|---|
| `github.ref`, `ref_name`, `ref_type` | the branch or the tag |
| `github.event_name` | what started the run |
| `github.sha`, `github.event.head_commit.message` | the commit, and what it said |
| `github.head_ref`, `github.base_ref` | a pull request's branches |
| `matrix.*` | this combination |
| `inputs.*` | what a dispatched run was given |
| `reviewos.changed` | the paths this event touched |

Every entry is a fact about **this event**. An expression cannot reach a step's
outcome - nothing has run yet, and the evaluator refuses rather than guesses, so
the job is skipped with the reason recorded. That is the safe direction: the
other one runs a deployment because a condition could not be read. And nothing
about the instance is in scope at all.

Two of these are worth calling out:

```yaml
    if: github.ref_type == 'tag'                                    # a release job
    if: "!contains(github.event.head_commit.message, '[skip ci]')"  # per job, not per workflow
```

The message is the **whole** message, not the subject: half the people who write
`[skip ci]` put it on the second line, and a condition that only saw the subject
would be right most of the time, which is the worst kind of wrong.

`reviewos.changed` sits under this instance's own name rather than inside
`github` because a workflow that reads it would not run on GitHub. A reader
deserves to see that in the expression rather than discover it on migration.
