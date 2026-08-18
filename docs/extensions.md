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

### `parallelism` - one job, run N times

```yaml
  test:
    runs-on: ubuntu-latest
    reviewos:
      parallelism: 5
    steps:
      - run: |
          curl -sf "$REVIEWOS_API_URL/repos/tests/split" \
            -H "authorization: Bearer $REVIEWOS_TOKEN" \
            -d "{\"owner\":\"acme\",\"repo\":\"api\",\"suite\":\"unit\",
                 \"nodes\":$REVIEWOS_PARALLEL_JOB_COUNT,\"index\":$REVIEWOS_PARALLEL_JOB,
                 \"items\":$(ls tests/**/*.test.ts | jq -Rs 'split("\n")')}" \
          | jq -r '.items[]' | xargs bun test
```

Five jobs from one definition, handed to five machines, named `test (1/5)`
through `test (5/5)`. They succeed and fail separately, which is the point: a
sharded suite where one shard fails should show you which one.

Each copy is told which it is:

| Variable | Value |
|---|---|
| `REVIEWOS_PARALLEL_JOB` | Which copy this is, **counting from zero** |
| `REVIEWOS_PARALLEL_JOB_COUNT` | How many copies there are |

**The index counts from zero and the name counts from one.** That is not an
oversight and it is the one thing to get wrong here: the number exists to be
handed to [`/api/repos/tests/split`](./test-intelligence.md), which indexes from
zero like every other partitioning API, while a person reading a failed run is
not indexing an array. Buildkite makes the same split for the same reason.

There is no `GITHUB_PARALLEL_JOB`. Actions has no such variable, and inventing
one would be this instance putting words in GitHub's mouth: a workflow written
against it would quietly do something else on the platform it names.

A job with no `parallelism:` is told nothing at all, rather than told it is
copy 0 of 1 - a script asking "am I a shard" should get an answer it can branch
on, and `0 of 1` is indistinguishable from the first shard of a suite somebody
scaled down.

**Actions can fake this** with `strategy.matrix: { shard: [1, 2, 3, 4, 5] }`,
which works and reads as though the numbers meant something. The ceiling here is
100 copies, and a file asking for more is refused rather than clamped: a suite
quietly running twenty of the two hundred shards it asked for reports a tenth of
itself as green.

A barrier, a gate or a trigger cannot have copies. Five copies of a gate is five
approvals for one deploy.

### `artifact-paths` - what to keep when the job ends

```yaml
  browser-tests:
    runs-on: ubuntu-latest
    reviewos:
      artifact-paths:
        - screenshots/**
        - playwright-report/**
    steps: [{ run: ./e2e }]
```

Globs, relative to the workspace, uploaded by the runner when the job finishes -
**whether it passed or failed**. That is the whole reason the attribute exists.
The alternative is a step that uploads its own output, which has to be written
`if: always()`, and the run where somebody forgot is always the run with the
screenshot in it.

The files land as ordinary artifacts on the run, downloadable from the run page
and from `/api/repos/workflow-runs/artifacts`. The path is kept in the name -
`screenshots/failure.png` is stored as `screenshots-failure.png` - so two
`report.xml` files in two directories are two artifacts rather than a collision.

A glob that matches nothing says so in the log rather than failing the job:
usually it is a typo or a build that wrote somewhere else, and the job has
already run either way. Nothing about the collection can fail a job that passed.

Paths must stay inside the checkout. An absolute path, or one climbing out with
`..`, is refused when the file is parsed, and each match is checked again when
it is collected: a symlink the build itself created can point anywhere, and a
job that can publish `/etc/` is a job that can put the machine's secrets on a
page anybody who can read the repository can open.

Twenty globs and two hundred files per job. An artifact nobody opens is storage
the instance pays for.

**Actions has an equivalent** in `actions/upload-artifact`, as a step - which
means `if: always()` and remembering it.

### `secrets` - which credentials this job needs

```yaml
  test:
    runs-on: ubuntu-latest
    reviewos:
      secrets: []              # this job needs none
    steps: [{ run: bun test }]

  ship:
    runs-on: ubuntu-latest
    reviewos:
      secrets: [DEPLOY_KEY]    # and this one needs exactly one
    steps: [{ run: ./ship }]
```

Least privilege, per job. Without it a trusted job receives **every** secret in
scope - which is what Actions does, and is fine right up until a test job's
dependency is compromised and reads the deploy key that job never needed.

**Saying nothing is not the same as saying none.** A job with no `secrets:` key
gets what it always got: everything in scope. That is backwards compatibility
rather than a recommendation. `secrets: []` is a job that has decided it needs
no credentials, which is worth being able to say about a job that runs somebody
else's code.

Naming a secret that does not exist is not an error. The same workflow file runs
on a clone and on an instance where nobody has set it yet, and refusing to parse
would make a workflow depend on the state of a secret store.

The rules above this one still apply, and asking by name is not a way around
them: a fork's pull request gets nothing whatever it names, and an environment's
secret still waits for the gate to open. See [secrets](./secrets.md).

The automatic job token still arrives. It is minted for this job rather than
stored, and what it may do is decided by `permissions:`.

**Actions has an equivalent only for a called workflow** - `secrets:` on a
`uses:` job, which passes values down rather than narrowing what this job holds.
Both keys exist here and they are different questions.

### `cancel-on-build-failing` - stop once the run is lost

```yaml
  browser-tests:
    runs-on: ubuntu-latest
    reviewos:
      cancel-on-build-failing: true
    steps: [{ run: ./e2e }]
```

The forty-minute browser suite that is still going when the unit tests have
already gone red. Nobody is going to read its result - the run is failed
whatever it says - and the machine it is holding is one nothing else can use.

**Off unless a job asks**, and that direction is the whole design. A job that
publishes the results, tears down a preview environment, or posts the failure to
a channel is written to run *because* something failed, and a run-wide default
would stop exactly the jobs people lean on hardest on the day a build breaks.

Different from `strategy.fail-fast`, which is scoped to one matrix and on by
default: that one stops the *siblings of the combination that broke*, this one
stops a named job when *anything* has sunk the run.

A failure the workflow tolerates does not count. `continue-on-error: true` means
this failing is fine, and a job that tolerates its own failure has not sunk
anything.

A running job is asked to stop rather than declared stopped - it is on somebody
else's machine, which has to be told and has to acknowledge - and the reason is
written on the row, because a cancelled job with no explanation is the worst row
on a run page.

**Actions has no equivalent** beyond `fail-fast` inside a matrix.

### `checkout` - how the code gets here

```yaml
  test:
    runs-on: ubuntu-latest
    reviewos:
      checkout:
        depth: 1
        sparse: [packages/api]
        submodules: recursive
        lfs: true
    steps: [{ run: bun test }]

  notify:
    runs-on: ubuntu-latest
    reviewos:
      checkout: false          # this job needs no code at all
    steps: [{ run: ./tell-somebody }]
```

The step every job has and nobody writes, and the one that decides how long half
of them take: a monorepository with ten years of history behind a two-minute
suite spends most of its wall clock cloning. Actions makes you write
`actions/checkout` with four `with:` keys; this is the same four words on the
job that already exists.

| Option | Means |
|---|---|
| `depth` | Commits of history to fetch. `1` is the commit itself; `0` is all of it, and is the default |
| `sparse` | Only these directories, cone mode |
| `submodules` | `true` for the top level, `recursive` for theirs too. Always shallow |
| `lfs` | Pull LFS objects rather than leaving pointer files |
| `skip` | No checkout at all. `checkout: false` says the same thing |

Two things are worth knowing before you use these.

**A depth on the instance's own machine clones through `file://`.** git ignores
`--depth` on a local-path clone - it hardlinks the object store instead - and
prints a warning most people never read. A workflow that asked for a shallow
clone and silently got ten years of history is an afternoon of debugging, so
this instance uses the URL form when a depth is asked for.

**Cone mode always keeps the files at the repository root.** That is git's rule
rather than this instance's: `sparse: [packages/api]` gives you `packages/api`
and the top-level files, not `packages/api` alone.

There is no `clean`, and its absence is a property of this runner rather than an
omission: every job gets a workspace of its own, so there is nothing left over
to clean.

Anything malformed is refused rather than ignored - a checkout that quietly did
something other than what the file said is a build against the wrong tree, which
is the one failure where the logs look fine.

### `concurrency-group` - a lock shared across workflows

```yaml
  deploy:
    runs-on: ubuntu-latest
    reviewos:
      concurrency-group: production
    steps: [{ run: ./deploy }]

  soak-test:
    runs-on: ubuntu-latest
    reviewos:
      concurrency-group: staging
      concurrency: 2                 # two at a time on that environment
      concurrency-method: eager      # order does not matter here
    steps: [{ run: ./soak }]
```

At most N jobs wearing this name run at once, **across every run and every
workflow in the repository**. The deploy lock, and the one staging environment
three pipelines share.

This is a different question from Actions' `concurrency:`, which groups whole
*runs* and cancels or queues them. Both exist here. A deploy that can be started
by two different workflows cannot be serialised by a run-level group at all,
because the two runs are not in the same group and never will be - and a limit
keyed on the job's own name, which is what `strategy.max-parallel` does, cannot
say that a smoke test and a deploy share one environment.

| Key | Means |
|---|---|
| `concurrency-group` | The name. Two workflows sharing it share the limit |
| `concurrency` | How many at a time. One is the default, and one is a lock |
| `concurrency-method` | `ordered` (default) or `eager` |

**`ordered` is the default and it is the reason to use this.** It hands out the
oldest waiting job in the group first, so a deploy queue lands commits in the
order they were pushed. Whichever-is-ready would make the state of production
depend on runner timing. `eager` is for the case where the group is a resource
limit rather than a sequence - four jobs sharing one licence server - and nobody
cares which goes first.

The group is repository-wide, not instance-wide. A `production` group in one
repository is not the same lock as `production` in another; making it so would
mean one team's deploy queue silently holding up another team's.

**Counted, not locked.** Two runners polling in the same instant can both take
the last slot, the same limitation `strategy.max-parallel` has here. Making it
exact costs a lock on every claim on the instance; what it leaves is one extra
job, and the alternative is a queue that serialises on a contended row.

A limit with no group is refused rather than defaulted to the job's own name: a
lock nobody else can join is the opposite of what this is for.

**Actions has no equivalent.**

### `adjustments` - one combination of a matrix, singled out

```yaml
  suite:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [20, 22, 24]
    reviewos:
      adjustments:
        - with: { node: 24 }
          soft-fail: true                     # nightly: report it, do not fail on it
        - with: { node: 22 }
          skip: Waiting on the upstream fix.  # and this one does not run
    steps: [{ run: bun test }]
```

The useful matrix is never the full cross product. One combination is
known-broken and should not run; another is expected to fail and should not fail
the run.

**Actions cannot say the second at all.** `continue-on-error` is per job, so
tolerating the nightly Node version means tolerating every version - and a
matrix that tolerates everything cannot fail a build. `soft-fail` on an
adjustment lands on that row alone.

`skip` is not a duplicate of `exclude:` either. An excluded combination is a job
that never existed and cannot explain itself; a skipped one is a row on the run
**with the reason on it**, which is what somebody scanning the screen three
weeks later needs. `skip: true` works and gets a reason written for it, but a
sentence is better.

`with:` names the combination, and a partial match is a match:
`with: { os: windows }` is every Windows combination. **The last matching entry
wins**, so a broad adjustment followed by a narrow one reads the way it looks -
tolerate Windows, except this one combination which does not run at all. An
entry with no `with:` is ignored rather than applied to everything: that is
somebody writing a job-level setting in the wrong place, and reading it as "all
combinations" would tolerate failures across a whole matrix.

Decided when the run is created, like `skip:` and `if-changed:`, so a
combination that will not run reads as skipped from the first second.

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

### `notify` - tell one person about one job

```yaml
  deploy:
    runs-on: ubuntu-latest
    reviewos:
      notify:
        - user: alex
          if: failure
        - user: sam
    steps: [{ run: ./deploy }]
```

`if:` is `failure`, `success`, or `always` (the default). A bare handle is
accepted too, so `notify: [alex]` means what it looks like.

The case the repository's own notifications cannot cover: a nightly run with
forty green jobs and one red deploy is a notification nobody reads unless it
names the job. Watching a repository tells you about runs; this tells one person
about one job.

**People on this instance, never an address.** A workflow file is editable by
anybody who can push, so a `notify:` that took an email address would make every
repository here a mail relay with a spam problem. Naming a user means their own
notification preferences decide the channel - inbox always, email and push if
they asked for them - which is also the answer to "how do I get a text message":
that is a per-person setting rather than a workflow one.

Two more rules, both refusals. Somebody who cannot read the repository is told
nothing, because a notification is not a way to learn that a private repository
exists. And **a fork's pull request notifies nobody**: the workflow comes from
the base branch, but the run is somebody else's code, and a stranger who can
open a pull request should not be able to make this instance message a
maintainer on demand.

A cancelled job counts as a failure for `if: failure`, because a deploy that was
cancelled did not happen either.

**Buildkite has this** (`notify` on a step, with email, Slack and webhooks).
Actions has notification settings per person and nothing per step.

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

## Actions, and how far they nest

Three kinds, and this runner is honest about which it has:

| Kind | Here |
|---|---|
| composite | runs, including when its steps use other actions |
| JavaScript | runs, with the runtime this host has (Bun rather than node - the log says so) |
| Docker | **refused**, with the reason: it needs a container engine this runner does not have |

A composite action's steps run in the **caller's** workspace rather than the
action's own directory. That reads as wrong until you write one: an action's
steps operate on the repository that called them, and `GITHUB_ACTION_PATH` is
how it reaches its own files.

**Nesting is five deep, and a cycle is refused with the chain.** Both failures
look identical from outside - a job that never finishes - and neither is
debuggable from a log that stops:

```
`./.reviewos/actions/loop` uses itself: ./.reviewos/actions/loop → ./.reviewos/actions/loop
```

Expressions inside a composite action are evaluated against **its own inputs**,
which is what makes a wrapper a wrapper:

```yaml
runs:
  using: composite
  steps:
    - uses: ./.reviewos/actions/greet
      with:
        who: ${{ inputs.who }}
```

A nested `uses:` goes through the same path as any other, so it gets the action
policy, the cache and the input mapping without a second implementation of any
of them.

## Calling a workflow in another repository

```yaml
jobs:
  build:
    uses: acme/shared/.github/workflows/build.yml@v2
    with:
      target: production
```

**The same owner, by default.** An organization calling its own shared workflow
is the case people have, and it is safe with no configuration: a repository
under one owner can already be read by anybody who can read that owner.

`workflow_call_scope` widens it to any **public** repository on the instance -
a real choice for a company's instance, and one a public instance should not
make. A private repository belonging to *another* owner is **never** callable,
whatever the setting says: its jobs would run against a definition nobody
outside can read, and "I cannot see the file that ran" is the shape of a
supply-chain problem rather than a convenience.

The refusal names the setting, so an administrator reading a failed run learns
which knob decides rather than concluding the feature is broken.

Everything else is the same as a local call: the called workflow must offer
itself with `on: workflow_call`, its declared inputs are checked rather than
defaulted, and its jobs appear in the run rather than collapsing into one box.
Secrets do not travel by being nearby - `secrets: inherit` is recorded and
resolved after the fork check, and a fork's pull request gets none at all.

### What a call looks like in the graph

The call is a **barrier**, not a box: `call / build` and `call / package` are
rows of the run, and `call` is a row of its own that runs nothing and finishes
when they do. Two consequences worth knowing:

- **`needs: [call]` works, and waits for the whole called workflow** - not for
  its last job, which is not the same thing when a called workflow does two
  independent things.
- **The call's own `needs:` holds the called workflow back.** `needs: [build]`
  on a call means the workflow it calls waits for `build`, which is what the
  file plainly says and what a reader assumes.

### Reading what a called workflow produced

```yaml
# the called workflow
on:
  workflow_call:
    outputs:
      version:
        value: ${{ jobs.compute.outputs.version }}
```

```yaml
# the caller
  call:
    uses: ./.github/workflows/build.yml
  ship:
    needs: [call]
    runs-on: ubuntu-latest
    steps:
      - run: ./ship ${{ needs.call.outputs.version }}
```

`jobs` is the one context that exists only here, and it is the called workflow's
own view of itself: the prefix is stripped, so an expression written against
`jobs.compute` keeps working when the caller names the call `deploy`. The values
are resolved when the barrier is released, because that is the moment its jobs
have finished, and stored on the call's row - so the caller reads them the way it
reads any other job's outputs.

An expression that cannot be resolved is left **as written** rather than becoming
an empty string, which is the rule everywhere here: a caller that reads
`${{ ... }}` back knows the value did not arrive, and one that reads nothing
cannot tell that from an empty answer.

A matrix job in a called workflow is several rows under one name, and their
outputs merge with the last row winning per key. That is Actions' behaviour and a
limitation rather than a design: two combinations that set the same output to
different values leave one answer and no record of the other.
