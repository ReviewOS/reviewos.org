# Arriving from Buildkite

A translation rather than a rewrite. Their format is public and most of it has a
word here already - this product's job extensions were designed against that
vocabulary - so the importer is mostly a rename, and what matters is the part
that is not.

```sh
buddy import:buildkite .buildkite/pipeline.yml --out .reviewos/workflows/ci.yml
```

The workflow goes to the file; the **report goes to the terminal**, and it is the
deliverable. A silent partial translation is worse than a refusal: a workflow
with three attributes quietly dropped is one somebody trusts, pushes, and then
debugs from the wrong end. Every attribute lands in one of three buckets -
translated, translated with a change in meaning, or no equivalent - and the third
is never silent.

## The mapping

| Buildkite | Here | Fidelity |
|---|---|---|
| `label` | the job's `name` | same |
| `key` | the job id | same |
| `command`, `commands` | `steps[].run` | same; a list becomes one `run:` block, in order |
| `depends_on` | `needs` | same |
| `allow_dependency_failure` | `if: always()` | **changed**: the job runs after a failed dependency rather than being unblocked by it |
| `if` | `if` | same expression language |
| `branches` | `reviewos.branches` | same |
| `skip` | `reviewos.skip` | same |
| `soft_fail` | `continue-on-error` | **changed**: a list of tolerated exit statuses becomes a boolean, which tolerates every failure rather than the ones named |
| `timeout_in_minutes` | `timeout-minutes` | same |
| `parallelism` | `reviewos.parallelism` | same |
| `matrix` | `strategy.matrix` | same; `adjustments` become `reviewos.adjustments` |
| `agents` | `runs-on` plus `reviewos.agents` | same: a queue becomes a label, the rest becomes a tag query |
| `artifact_paths` | `reviewos.artifact-paths` | same |
| `env` | `env` | same |
| `retry` | `reviewos.retry` | **changed**: automatic retries carry a cap here, and a manual retry is a person pressing re-run |
| `concurrency`, `concurrency_group` | `reviewos.concurrency`, `reviewos.concurrency-group` | same |
| `cancel_on_build_failing` | `reviewos.cancel-on-build-failing` | same |
| `notify` | `reviewos.notify` | **changed**: a rule names somebody on this instance rather than an address or a channel |
| `priority` | `reviewos.priority` | same |
| `wait` | `reviewos.wait` | same: a barrier is a job here, and everything after it depends on it |
| `block` | `reviewos.block` | same: a gate a person opens, with the run held at `waiting` |
| `trigger` | `reviewos.trigger` | **changed**: it starts a run of another workflow on this instance |
| `group` | `reviewos.group` | **changed**: the group's steps are flattened into jobs carrying its name |
| `plugins` | - | **no equivalent**, deliberately: see below |
| `signature` | - | no equivalent: this instance signs dispatched work itself |

Steps between two barriers stay parallel. Chaining each step to the one before it
would serialise a pipeline that was not, which is a translation slower than the
original - and reads as this product being slow.

## Plugins: the position

**Their plugins do not run here, and this is a decision rather than a gap.**

Buildkite's plugin interface is hook scripts plus a parameter schema, and this
product's is hook scripts plus a manifest: close enough that compatibility was
worth deciding rather than assuming. The decision is no, for one reason -
`BUILDKITE_PLUGIN_*` environment variables and their agent's lifecycle are an
interface, and implementing half of it produces plugins that mostly work. A
plugin that mostly works is worse than one that does not: it fails on the day
its author used the half nobody implemented, in somebody else's build, with no
error that names the cause.

What to do with each is a short list:

- **A plugin that runs a command** - `docker-login`, `ecr`, `artifacts` - is a
  step here. Usually two lines, and readable by whoever inherits it.
- **A plugin that wraps the whole job** - a profiler, a proxy - is a
  [runner hook](./runner-hooks.md), which is the fleet's mechanism for exactly
  that and is not editable by a repository.
- **A plugin your organisation wrote** is a [plugin here](./plugins.md), which
  is hook scripts and a manifest: the port is mechanical.

The importer names every plugin it found rather than dropping it, so the list
above is a list of decisions somebody makes with the pipeline in front of them.

## The test history

The flaky verdict is the part a move cannot recreate: it took months of runs to
accumulate, and starting empty starts by forgetting which tests to distrust.
Buildkite Test Analytics exports one JSON object per execution, which imports
through the ordinary ingestion endpoint:

```sh
curl -sX POST "$SERVER/api/repos/tests/ingest" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d @executions.json
```

Two things are converted rather than copied. Duration is seconds there and
milliseconds here, which is the one unit that would be silently wrong - a suite
of four-second tests imported as four-millisecond ones looks like a suite that
got faster. And an execution whose result is `unknown` is dropped rather than
counted as a pass: importing it as one is how a green history gets invented.
