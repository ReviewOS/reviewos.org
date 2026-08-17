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

## What this costs

| | |
|---|---|
| Portability | A file using `reviewos:` does not run on GitHub. It is refused, not ignored. |
| Migration in | Nothing. An Actions workflow uses none of this and behaves identically. |
| Migration out | Delete the `reviewos:` keys. A `wait` becomes `needs:`; a `block` becomes an environment protection rule; a `trigger` becomes `workflow_call` or an API call in a step; a `group` becomes nothing, since GitHub has no grouping. |

The engine underneath is documented in
[the pipelines roadmap](https://github.com/stacksjs/reviewos/blob/main/docs/todo/15-pipelines.md),
including the attributes that exist in the model and do not yet have a key on the
surface.
