/**
 * Read a workflow file, and refuse it before it can reach a runner.
 *
 * The canonical authoring format is GitHub Actions-compatible YAML, for the
 * reason [phase 15](../../../docs/todo/15-pipelines.md) gives: the ecosystem is
 * the product, and a format nobody can leave with is a format nobody adopts.
 * This module is the front half of that - source text in, a normalized graph
 * or a list of errors out - and it runs in the control plane, which is exactly
 * why it must not evaluate anything.
 *
 * **Nothing here executes, resolves, or fetches.** It parses a document and
 * checks its shape. `run:` bodies are strings to this module and stay strings;
 * `uses:` is a reference it records and does not go and look up. That is what
 * makes it safe to run against a fork's pull request, which is the only reason
 * a forge can tell a contributor their workflow is broken instead of failing
 * silently or running it to find out.
 *
 * Errors carry a line and a fix rather than a complaint. A workflow file is
 * usually written by somebody who is guessing at the schema, so "unknown key"
 * with no suggestion is the same as no error at all.
 */

import { differencesIn } from './conformance'
import type { Combination, MatrixDefinition } from './matrix'
import { combinationLabel, expandMatrix } from './matrix'

export interface WorkflowError {
  /** 1-based line in the source, or 0 when it could not be located. */
  line: number
  /** What is wrong, in the terms the author used. */
  message: string
  /** What to do about it. */
  fix: string
}

export interface WorkflowStep {
  id: string | null
  name: string | null
  /**
   * `shell:`, which decides how `run:` is interpreted.
   *
   * Null means "inherit", not "bash": the answer comes from the job's or the
   * workflow's `defaults.run.shell`, and only if neither says anything does the
   * runner pick. Resolving it here would bake a default that the file may have
   * overridden two levels up.
   */
  shell: string | null
  /** `continue-on-error:`: the step fails and the job carries on. */
  continueOnError: boolean
  /**
   * `timeout-minutes:` on the step.
   *
   * Narrower than the job's, and the useful one: a job allowed sixty minutes
   * that hangs in a thirty-second health check spends fifty-nine of them
   * proving nothing.
   */
  timeoutMinutes: number | null
  /** The command to run. Exactly one of `run` or `uses` is set. */
  run: string | null
  /** The action to use, recorded verbatim and never resolved here. */
  uses: string | null
  with: Record<string, unknown>
  env: Record<string, string>
  workingDirectory: string | null
  if: string | null
}

export interface WorkflowJob {
  id: string
  name: string | null
  runsOn: string[]
  needs: string[]
  if: string | null
  timeoutMinutes: number | null
  /**
   * `environment:` on the job, as a name.
   *
   * Actions also accepts `{ name, url }`; the url is where a deploy ended up,
   * which nothing here records yet, so the name is read out of either form
   * rather than the object being refused.
   *
   * The name alone protects nothing - the rules live on the environment in the
   * repository. That is the point: a workflow author cannot lower the bar for
   * their own deploy by editing the file the deploy is written in.
   */
  environment: string | null
  /**
   * `services:` on the job, as name, image and env.
   *
   * Kept as what the workflow asked for rather than as anything resolved: this
   * instance starts services with pantry, and which pantry service an image
   * means is a fact about the *runner*, not about the file. A runner with a
   * container engine could read the same job differently, and neither should
   * have to re-parse the document to find out.
   */
  services: WorkflowService[]
  /** `reviewos.skip:` - the reason this job is off, or null. */
  skip: string | null
  /** `reviewos.soft-fail:` - a failure that is reported and does not fail the run. */
  softFail: { any: boolean, statuses: number[] } | null
  /** `reviewos.branches:` - which branches this job runs on, `!` to exclude. */
  branches: string[]
  /**
   * `reviewos.allow-dependency-failure:` - this job runs even when what it
   * needed did not succeed. The dependencies still have to be *finished*.
   */
  allowDependencyFailure: boolean
  env: Record<string, string>
  /**
   * `outputs:` on the job, as written.
   *
   * Expressions over this job's own steps - `${{ steps.build.outputs.name }}` -
   * which can only be resolved once those steps have run, so they travel to the
   * runner rather than being evaluated here.
   */
  outputs: Record<string, string>
  /**
   * `uses:` at the job level: this job *is* another workflow.
   *
   * A job with `uses` has no steps of its own - the called workflow's jobs are
   * what run - so it is a different kind of job rather than a job with an
   * unusual step, and it is kept as its own field for that reason.
   */
  uses: string | null
  /** `with:` for a called workflow's inputs, as written. */
  withInputs: Record<string, unknown>
  /**
   * `secrets:` on a call: either a mapping, or the word `inherit`.
   *
   * `inherit` is stored as the word rather than expanded here. Expanding it
   * would mean deciding *at parse time* what a run may read, and by the threat
   * model that decision belongs after the fork check.
   */
  secrets: unknown
  /** `permissions:` on the job, as written. Replaces the workflow's, never adds. */
  permissions: unknown
  /**
   * `defaults:` on the job, which its steps inherit unless they say otherwise.
   *
   * Kept apart from the workflow's rather than merged, for the same reason as
   * `env`: the precedence is a rule a reader has to be able to check.
   */
  defaults: { shell: string | null, workingDirectory: string | null }
  /**
   * `concurrency:` on the job.
   *
   * Its own group, independent of the workflow's: a workflow can let its runs
   * overlap while one deployment job inside it serialises, which is the shape
   * most people actually want and cannot express at the workflow level.
   */
  concurrency: WorkflowConcurrency | null
  steps: WorkflowStep[]
  /**
   * One entry per matrix combination, empty when the job has no matrix.
   *
   * Expanded here rather than at dispatch because the number of jobs a run
   * will carry is a fact about the file, and a run screen that cannot say how
   * many jobs are coming until they arrive is a progress bar with no end.
   */
  matrix: Combination[]
  /** What a run screen calls each combination: Actions' `build (ubuntu, 20)` shape. */
  matrixLabels: string[]
  /**
   * Actions defaults this to true, which is the surprising direction: one
   * failed combination cancels the rest.
   */
  failFast: boolean
  maxParallel: number | null
  /**
   * `continue-on-error:` on the job: it may fail without failing the run.
   *
   * Actions' rule, which reads stranger than it is: a job that fails this way
   * still shows as failed, and still reports `success` to the jobs that
   * `needs:` it. The point is a job somebody wants to see the result of and
   * does not want to block on - a flaky integration suite, a benchmark - and
   * treating it as fatal is what makes people delete the job instead.
   */
  continueOnError: boolean
  /**
   * What kind of job this is.
   *
   * `command` is the only kind that consumes a runner and the only one an
   * Actions workflow can write. The others are decided by the control plane -
   * a barrier is satisfied by its dependencies, a gate by a person, a trigger
   * by starting another run - which is why none of them can be claimed.
   */
  kind: JobKind
  /** The extension's own configuration, by kind. Empty for a command job. */
  settings: Record<string, unknown>
  /**
   * `reviewos.group:` - a label several jobs share so a run of two hundred
   * reads as eight things. A label rather than a container, because nesting
   * jobs inside jobs would change every query that reads a run.
   */
  group: string | null
  /**
   * `reviewos.if-changed:` - path globs this job needs one of.
   *
   * Actions filters the whole workflow on `on.push.paths`, which is the wrong
   * grain for a repository with twelve packages in it: the workflow runs, and
   * *what* it runs is the question. Empty means "always", which is every job
   * that does not say otherwise.
   */
  ifChanged: string[]
  /**
   * `reviewos.priority:` - which job leaves the queue first.
   *
   * Its own field rather than a key in `settings`, because it has its own
   * column: the claim orders by it on every poll, and a value the queue reads
   * that often does not belong inside a JSON blob.
   */
  priority: number
}

/**
 * What to do with runs that are already waiting when a newer one arrives.
 *
 * `run` is Actions' behaviour and the default: three commits in a minute is
 * three runs. `cancel` is `concurrency.cancel-in-progress`, which stops what is
 * *running*. `skip` is the third thing people actually want and neither offers:
 * let the build that has already started finish, and drop the ones that have
 * not, because only the newest commit's result is going to be read.
 */
export type IntermediateRuns = 'run' | 'skip' | 'cancel'

/** One `services:` entry: what to start beside the job. */
/** What `reviewos:` on a job adds, beyond the kind it names. */
interface ExtensionResult {
  kind: JobKind
  settings: Record<string, unknown>
  group: string | null
  ifChanged: string[]
  priority: number
  /** `skip:` - the reason, or null when the job is not skipped. */
  skip: string | null
  /** `soft-fail:` - any failure, or the exit statuses worth tolerating. */
  softFail: { any: boolean, statuses: number[] } | null
  /** `branches:` - the shorthand for the most common `if:`, negation included. */
  branches: string[]
  /** `allow-dependency-failure:` - run after a failed dependency, on purpose. */
  allowDependencyFailure: boolean
}

export interface WorkflowService {
  /** The key in the workflow, which is the hostname Actions would give it. */
  name: string
  image: string
  env: Record<string, string>
  /** `ports:` as written. Informational here - a host service listens where it listens. */
  ports: string[]
}

export interface WorkflowConcurrency {
  group: string
  cancelInProgress: boolean
}

export interface TriggerFilter {
  branches: string[]
  tags: string[]
  paths: string[]
  /**
   * The negative forms, kept apart rather than folded into the positive ones.
   *
   * `branches-ignore` is not `branches` with a flag: Actions refuses a workflow
   * that sets both, and a matcher that saw one merged list could not tell which
   * way round the author meant it.
   */
  branchesIgnore: string[]
  tagsIgnore: string[]
  pathsIgnore: string[]
  /** `types: [opened, synchronize]`, which decides which activity fires the event. */
  types: string[]
}

export interface WorkflowTriggers {
  push: TriggerFilter | null
  pullRequest: TriggerFilter | null
  /**
   * `pull_request_target`, kept apart from `pull_request` on purpose.
   *
   * It is the same event with the opposite trust: the workflow comes from the
   * base branch and runs **with the base repository's secrets, against a
   * fork's code**. It is the trigger behind most of the published Actions
   * secret-theft write-ups, and it cannot be normalized into `pullRequest`
   * without losing the one fact the fork policy needs.
   */
  pullRequestTarget: TriggerFilter | null
  /**
   * `issues`, `issue_comment` and `release`.
   *
   * The filters they carry are `types:` and nothing else - there is no branch
   * or path to filter on when the subject is an issue - so they share the
   * shape and use one field of it.
   */
  issues: TriggerFilter | null
  issueComment: TriggerFilter | null
  release: TriggerFilter | null
  /** Cron expressions, unvalidated here beyond being strings. */
  schedule: string[]
  /** Whether a person or the API may start this workflow directly. */
  dispatch: boolean
  /**
   * The inputs `workflow_dispatch` declares, in the order they were written.
   *
   * Order matters because a generated form follows it: a workflow author
   * putting `environment` first meant it to be the first question.
   */
  dispatchInputs: WorkflowDispatchInput[]
  /** `workflow_call`: startable only by another workflow, never by an event. */
  reusable: boolean
  /**
   * What a caller may pass, and what it gets back.
   *
   * The inputs reuse `workflow_dispatch`'s shape: they are the same idea with
   * the same four types, and giving them a second shape would mean two
   * validators that have to agree forever.
   */
  callInputs: WorkflowDispatchInput[]
  /** Output names a caller can read, with the expression each is bound to. */
  callOutputs: Array<{ name: string, description: string, value: string }>
  /** Secret names the called workflow declares it needs. */
  callSecrets: Array<{ name: string, description: string, required: boolean }>
  /**
   * Events that are real Actions triggers this instance does not dispatch on
   * yet. Recorded rather than rejected: a workflow that also fires on `push`
   * still runs, and refusing the file because one of its triggers is
   * unimplemented is how a format becomes one nobody can bring their
   * repository to.
   */
  unsupported: string[]
}

/**
 * One `workflow_dispatch` input.
 *
 * `type` is Actions' four: `string`, `boolean`, `choice`, `environment`. An
 * unrecognised type is read as `string` rather than refused - a workflow whose
 * only oddity is a type this does not know still runs, and the input still
 * arrives.
 */
export interface WorkflowDispatchInput {
  name: string
  description: string
  required: boolean
  type: 'string' | 'boolean' | 'choice' | 'environment'
  /** As written. A boolean's default is still text here; validation coerces. */
  default: string | null
  /** For `choice`, the permitted values. Empty for every other type. */
  options: string[]
}

export interface NormalizedWorkflow {
  name: string | null
  triggers: WorkflowTriggers
  jobs: WorkflowJob[]
  env: Record<string, string>
  /**
   * `permissions:` as written, unresolved.
   *
   * Kept raw rather than translated here: the mapping onto this instance's
   * scopes belongs with the scopes, and a stored copy of what the file said is
   * what lets a screen explain a decision later. `null` is "the key is absent",
   * which is not the same as `{}` - that is a workflow asking for nothing on
   * purpose.
   */
  permissions: unknown
  /**
   * Read rather than ignored, which is the whole point of naming Gitea in the
   * roadmap: it accepts `concurrency:` and does nothing with it, so a workflow
   * that relies on it looks like it works.
   */
  concurrency: WorkflowConcurrency | null
  defaults: { shell: string | null, workingDirectory: string | null }
  /**
   * `reviewos.intermediate:` - what to do with runs that are still waiting when
   * a newer one arrives.
   */
  intermediate: IntermediateRuns
}

/**
 * A difference this instance has from Actions, named where the file is read.
 *
 * Not an error: the workflow is valid and will be registered. It is the
 * sentence that stops a difference being a surprise - the roadmap's rule is
 * that behaviour which deliberately differs is *documented per key with the
 * reason, and the parser says so rather than quietly doing something else*.
 */
export interface WorkflowWarning {
  /** The key, as the conformance table names it. */
  key: string
  /** `differs` for a deliberate divergence, `unimplemented` for a gap. */
  status: 'differs' | 'unimplemented'
  /** What this instance does, in the same words the published table uses. */
  message: string
}

export type ParseResult =
  | { ok: true, workflow: NormalizedWorkflow, errors: [], warnings: WorkflowWarning[] }
  | { ok: false, workflow: null, errors: WorkflowError[], warnings: WorkflowWarning[] }

/** Top-level keys Actions defines. Anything else is a typo worth catching. */
const TOP_LEVEL = new Set([
  'name', 'on', 'jobs', 'env', 'defaults', 'concurrency', 'permissions', 'run-name',
  /*
   * The workflow-level half of the one extension key. The job-level half is in
   * `JOB_KEYS`, and both exist for the same reason: one word to grep for when
   * somebody asks what in a repository is not portable.
   */
  'reviewos',
])

/** `reviewos.intermediate:` at workflow level. */
const WORKFLOW_EXTENSION_KEYS = new Set(['intermediate'])

const JOB_KEYS = new Set([
  'name', 'runs-on', 'needs', 'if', 'steps', 'env', 'timeout-minutes',
  'strategy', 'continue-on-error', 'container', 'services', 'outputs',
  'permissions', 'concurrency', 'defaults', 'environment', 'uses', 'with', 'secrets',
  /*
   * The one key that is not Actions'.
   *
   * Everything this instance can do beyond Actions lives under `reviewos:`,
   * and it is one key on purpose. An extension spread across five new
   * top-level keys is five things to find and delete when a workflow moves;
   * this is one, and grepping for it finds every place a repository has
   * stepped outside the portable surface.
   *
   * It is a one-way door and the documentation says so: GitHub refuses a
   * workflow with a job key it does not know, so a file using this does not
   * run there. Refusing loudly is the right failure - the alternative is a
   * `block:` that GitHub ignores, which means a deployment gate that silently
   * is not there.
   */
  'reviewos',
])

/** What a job *is*, which Actions has one of and this engine has five. */
export type JobKind = 'command' | 'wait' | 'block' | 'trigger'

const EXTENSION_KEYS = new Set([
  'wait',
  'block',
  'trigger',
  'group',
  'if-changed',
  'retry',
  'priority',
  'agents',
  // Buildkite's step attributes, in the three shapes people actually reach for.
  'skip',
  'soft-fail',
  'branches',
  // The graph-level twin of `if: always()`, for any job rather than only a
  // barrier: the dependencies still have to be finished, and their verdict
  // stops mattering.
  'allow-dependency-failure',
])

const STEP_KEYS = new Set([
  'id', 'name', 'run', 'uses', 'with', 'env', 'if',
  'working-directory', 'shell', 'continue-on-error', 'timeout-minutes',
])

/** The events this instance can start a run from today. */
const DISPATCHED_EVENTS = new Set([
  'push', 'pull_request', 'pull_request_target', 'schedule', 'workflow_dispatch',
  // The issue and release triggers, which this instance already emits events
  // for. A workflow that labels a new issue or publishes on a release is one of
  // the two things people automate first, and there was no reason beyond
  // wiring for them to sit in the unsupported list.
  'issues', 'issue_comment', 'release',
])

/**
 * Every event Actions defines.
 *
 * Kept whole, and separately from the ones above, because the acceptance test
 * for the format is that a copied `.github/workflows` directory goes green with
 * no edits. A file triggered on `release` is not invalid because this instance
 * does not dispatch releases yet - it is a workflow with a trigger that has not
 * arrived, and telling its author it is broken is a lie that costs the adoption
 * the format was chosen for.
 */
const KNOWN_EVENTS = new Set([
  ...DISPATCHED_EVENTS,
  'workflow_call', 'workflow_run', 'repository_dispatch',
  'release', 'create', 'delete', 'fork', 'gollum', 'watch', 'public',
  'issues', 'issue_comment', 'label', 'milestone', 'project', 'project_card',
  'project_column', 'discussion', 'discussion_comment', 'status',
  'check_run', 'check_suite', 'deployment', 'deployment_status',
  'page_build', 'registry_package', 'merge_group', 'branch_protection_rule',
  'pull_request_review', 'pull_request_review_comment', 'member', 'membership',
])

/**
 * The line a key sits on, found by scanning the source.
 *
 * `Bun.YAML.parse` answers with values and no positions, and a position is what
 * makes an error actionable. Rather than carry a second YAML parser for the
 * sake of line numbers, the key is located textually: the first line whose
 * first non-space token is that key, at or after `from`.
 *
 * Approximate on purpose, and the approximation is stated because a wrong line
 * confidently reported is worse than none: a key repeated at two nesting levels
 * can match the outer one. It is a pointer into a file the author has open, not
 * a claim about the document tree.
 */
export function lineOf(source: string, key: string, from = 0): number {
  const lines = source.split('\n')
  const pattern = new RegExp(`^\\s*(?:-\\s*)?["']?${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*:`)

  for (let index = from; index < lines.length; index++) {
    if (pattern.test(lines[index]!))
      return index + 1
  }

  return 0
}

/** A YAML mapping, or null when the value is anything else. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** One string, or a list of them, or nothing - the shape Actions uses everywhere. */
function asStringList(value: unknown): string[] {
  if (typeof value === 'string')
    return [value]

  if (Array.isArray(value))
    return value.filter((item): item is string => typeof item === 'string')

  return []
}

function asStringMap(value: unknown): Record<string, string> {
  const record = asRecord(value)
  if (!record)
    return {}

  const out: Record<string, string> = {}
  for (const [key, item] of Object.entries(record)) {
    if (item === null || typeof item === 'object')
      continue
    out[key] = String(item)
  }

  return out
}

function filterFrom(value: unknown): TriggerFilter {
  const record = asRecord(value)

  return {
    branches: asStringList(record?.branches),
    tags: asStringList(record?.tags),
    paths: asStringList(record?.paths),
    branchesIgnore: asStringList(record?.['branches-ignore']),
    tagsIgnore: asStringList(record?.['tags-ignore']),
    pathsIgnore: asStringList(record?.['paths-ignore']),
    types: asStringList(record?.types),
  }
}

/**
 * `runs-on`, in all three shapes Actions accepts.
 *
 * A label, a list of labels, or `{ group, labels }`. The object form is the one
 * Gitea does not support, and the roadmap names that as a migration blocker -
 * so it is read here and flattened onto the labels a runner has to carry, with
 * the group first because a pool is a label to this product.
 */
export function runsOnFrom(value: unknown): string[] {
  const record = asRecord(value)

  if (record) {
    const group = typeof record.group === 'string' ? [record.group] : []

    return [...group, ...asStringList(record.labels)]
  }

  return asStringList(value)
}

/**
 * The `on:` block, in all three shapes Actions accepts.
 *
 * `on: push`, `on: [push, pull_request]` and the mapping form all mean the same
 * thing and all appear in real repositories, so all three are read rather than
 * the one the schema would prefer.
 */
function triggersFrom(value: unknown): WorkflowTriggers {
  const empty: TriggerFilter = { branches: [], tags: [], paths: [], branchesIgnore: [], tagsIgnore: [], pathsIgnore: [], types: [] }
  const triggers: WorkflowTriggers = {
    push: null,
    pullRequest: null,
    pullRequestTarget: null,
    issues: null,
    issueComment: null,
    release: null,
    schedule: [],
    dispatch: false,
    dispatchInputs: [],
    reusable: false,
    callInputs: [],
    callOutputs: [],
    callSecrets: [],
    unsupported: [],
  }

  const named = (name: string, filter: TriggerFilter) => {
    if (name === 'push')
      triggers.push = filter
    else if (name === 'pull_request')
      triggers.pullRequest = filter
    else if (name === 'pull_request_target')
      triggers.pullRequestTarget = filter
    else if (name === 'issues')
      triggers.issues = filter
    else if (name === 'issue_comment')
      triggers.issueComment = filter
    else if (name === 'release')
      triggers.release = filter
    else if (name === 'workflow_dispatch')
      triggers.dispatch = true
    else if (name === 'workflow_call')
      triggers.reusable = true
    else if (KNOWN_EVENTS.has(name))
      triggers.unsupported.push(name)
  }

  if (typeof value === 'string') {
    named(value, empty)
    return triggers
  }

  if (Array.isArray(value)) {
    for (const name of asStringList(value))
      named(name, empty)
    return triggers
  }

  const record = asRecord(value)
  if (!record)
    return triggers

  for (const [name, body] of Object.entries(record)) {
    if (name === 'workflow_dispatch') {
      triggers.dispatch = true
      triggers.dispatchInputs = dispatchInputsFrom(asRecord(body)?.inputs)
      continue
    }

    if (name === 'workflow_call') {
      triggers.reusable = true

      const call = asRecord(body) ?? {}

      triggers.callInputs = dispatchInputsFrom(call.inputs)
      triggers.callOutputs = callOutputsFrom(call.outputs)
      triggers.callSecrets = callSecretsFrom(call.secrets)
      continue
    }

    if (name === 'schedule') {
      for (const entry of Array.isArray(body) ? body : []) {
        const cron = asRecord(entry)?.cron
        if (typeof cron === 'string')
          triggers.schedule.push(cron)
      }
      continue
    }

    named(name, filterFrom(body))
  }

  return triggers
}

/**
 * `workflow_dispatch.inputs`, in the order written.
 *
 * The order is the form's order: a workflow author who put `environment` first
 * meant it to be the first question somebody is asked.
 */
export function dispatchInputsFrom(value: unknown): WorkflowDispatchInput[] {
  const record = asRecord(value)

  if (!record)
    return []

  const inputs: WorkflowDispatchInput[] = []

  for (const [name, body] of Object.entries(record)) {
    const definition = asRecord(body) ?? {}
    const declared = String(definition.type ?? 'string')

    // An unrecognised type reads as `string` rather than refusing the file. A
    // workflow whose only oddity is a type this does not know still runs, and
    // the input still arrives.
    const type = declared === 'boolean' || declared === 'choice' || declared === 'environment'
      ? declared
      : 'string'

    inputs.push({
      name,
      description: typeof definition.description === 'string' ? definition.description : '',
      required: definition.required === true,
      type,
      // Kept as written, including a boolean's `true`. Coercion belongs where
      // the value is used, not where it is read.
      default: definition.default === undefined || definition.default === null
        ? null
        : String(definition.default),
      options: type === 'choice' ? asStringList(definition.options) : [],
    })
  }

  return inputs
}

/** `workflow_call.outputs`: a name, a description, and the expression behind it. */
export function callOutputsFrom(value: unknown): Array<{ name: string, description: string, value: string }> {
  const record = asRecord(value)

  if (!record)
    return []

  return Object.entries(record).map(([name, body]) => {
    const definition = asRecord(body) ?? {}

    return {
      name,
      description: typeof definition.description === 'string' ? definition.description : '',
      // Stored as written. It is an expression over the called workflow's jobs,
      // and it can only be evaluated once they have run.
      value: typeof definition.value === 'string' ? definition.value : '',
    }
  })
}

/**
 * The `reviewos:` block on a job: what kind of job it is, and its settings.
 *
 * Everything here is *additive*. A job with no `reviewos:` key is a command
 * job, which is every job an Actions workflow can write, and nothing about how
 * those behave changes because this exists.
 *
 * The kinds and what decides them:
 *
 * - **wait** - a barrier. Satisfied by its dependencies rather than by a
 *   machine, and normalized into `needs:` below so the graph a reader sees is
 *   the graph that runs.
 * - **block** - a gate. Waits for a person, optionally collecting typed fields
 *   from whoever unblocks it, which become the job's outputs. Buildkite calls
 *   the second one an input step; folding it in is the honest shape, because a
 *   block with fields *is* an input step and having two names for one row is
 *   how a model grows a spelling problem.
 * - **trigger** - starts a run of another workflow, and does not consume a
 *   runner to do it.
 */
function extensionOf(
  body: Record<string, unknown>,
  id: string,
  jobLine: number,
  source: string,
  errors: WorkflowError[],
): ExtensionResult {
  const raw = asRecord(body.reviewos)

  if (!raw)
    return { kind: 'command', settings: {}, group: null, ifChanged: [], priority: 0, skip: null, softFail: null, branches: [], allowDependencyFailure: false }

  for (const key of Object.keys(raw)) {
    if (!EXTENSION_KEYS.has(key)) {
      errors.push({
        line: lineOf(source, key, jobLine),
        message: `\`${key}\` is not a \`reviewos:\` key, in job \`${id}\``,
        fix: 'The keys are `wait`, `block`, `trigger`, `group`, `if-changed`, `retry`, `priority`, `agents`, `skip`, `soft-fail`, `branches` and `allow-dependency-failure`.',
      })
    }
  }

  const group = typeof raw.group === 'string' && raw.group.trim() ? raw.group.trim() : null

  /*
   * `if-changed:` - the monorepository primitive.
   *
   * Actions filters the *whole workflow* on `on.push.paths`, which is the
   * wrong grain for a repository with twelve packages in it: the workflow has
   * to run, and what it runs depends on what moved. Per-job globs are the
   * difference between a monorepository that is usable here and one where
   * every push runs everything.
   */
  const ifChanged = asStringList(raw['if-changed'])
  const retry = retryFrom(raw.retry, id, jobLine, source, errors)
  const priority = priorityFrom(raw.priority, id, jobLine, source, errors)
  const agents = agentsFrom(raw.agents, id, jobLine, source, errors)

  const skip = skipFrom(raw.skip)
  const softFail = softFailFrom(raw['soft-fail'])
  const branches = branchesFrom(raw.branches)
  const allowDependencyFailure = raw['allow-dependency-failure'] === true

  const kinds = (['wait', 'block', 'trigger'] as const).filter(key => key in raw)

  if (kinds.length > 1) {
    errors.push({
      line: jobLine,
      message: `Job \`${id}\` is a ${kinds.join(' and a ')} at once`,
      fix: 'A job is one kind. Split it into two jobs, and have the second `needs:` the first.',
    })

    return { kind: 'command', settings: settingsWithAllowance(settingsOf(retry, agents), allowDependencyFailure), group, ifChanged, priority, skip, softFail, branches, allowDependencyFailure }
  }

  if (kinds.length === 0)
    return { kind: 'command', settings: settingsWithAllowance(settingsOf(retry, agents), allowDependencyFailure), group, ifChanged, priority, skip, softFail, branches, allowDependencyFailure }

  if (ifChanged.length > 0) {
    /*
     * A barrier or a gate that only sometimes exists would silently change the
     * shape of the graph - the jobs after a skipped barrier would have nothing
     * to wait for - and a deployment gate that vanishes because no file matched
     * is a gate that approves itself.
     */
    errors.push({
      line: lineOf(source, 'if-changed', jobLine),
      message: `Job \`${id}\` is a \`${kinds[0]}\` job, which cannot be skipped by \`if-changed\``,
      fix: 'Put `if-changed:` on the jobs that do the work, not on the barrier or gate between them.',
    })
  }

  const kind = kinds[0]!

  if (Array.isArray(body.steps) && body.steps.length > 0) {
    errors.push({
      line: jobLine,
      message: `Job \`${id}\` is a \`${kind}\` job and also has steps`,
      fix: 'A wait, block or trigger job runs no commands. Move the steps into a job of their own.',
    })
  }

  if (kind === 'wait') {
    return {
      ifChanged,
      priority,
      skip,
      softFail,
      branches,
      kind,
      settings: {
        /*
         * The variant Buildkite calls `continue_on_failure`: a barrier that
         * lets the run past it even when something before it failed, which is
         * how a "publish the results whatever happened" stage is written.
         *
         * The same flag `allow-dependency-failure` sets on an ordinary job, so
         * a barrier is not a special case in the graph - it is the one place
         * this was reachable before, and one rule reaching the graph two ways
         * is the sort of thing that disagrees with itself later.
         */
        continueOnFailure: asRecord(raw.wait)?.['continue-on-failure'] === true || allowDependencyFailure,
      },
      group,
      allowDependencyFailure,
    }
  }

  if (kind === 'trigger') {
    return {
      kind,
      settings: settingsWithAllowance(triggerFrom(raw.trigger, id, jobLine, source, errors), allowDependencyFailure),
      group,
      ifChanged,
      priority,
      skip,
      softFail,
      branches,
      allowDependencyFailure,
    }
  }

  return {
    kind,
    settings: settingsWithAllowance(blockFrom(raw.block, id, jobLine, source, errors), allowDependencyFailure),
    group,
    ifChanged,
    priority,
    skip,
    softFail,
    branches,
    allowDependencyFailure,
  }
}

/** `allow-dependency-failure:` on a job, in the shape the settler reads. */
function settingsWithAllowance(settings: Record<string, unknown>, allow: boolean): Record<string, unknown> {
  return allow ? { ...settings, continueOnFailure: true } : settings
}

/**
 * `skip:` - a job the file itself turns off.
 *
 * `true` or a sentence, and the sentence is why this is not just a commented
 * out job: a skipped step that says *why* is one somebody can decide about
 * three weeks later, and a commented one is a diff nobody reads.
 *
 * The reason shows on the run beside the job, which is where the question is
 * asked.
 */
export function skipFrom(value: unknown): string | null {
  if (value === true)
    return 'Skipped by the workflow.'

  if (typeof value === 'string' && value.trim())
    return value.trim()

  return null
}

/**
 * `soft-fail:` - a failure that is reported and does not fail the run.
 *
 * `true` for any failure, or a list of exit statuses for the ones worth
 * tolerating. The list is the shape that earns its place: a linter exiting 1 on
 * findings is a soft failure, and the same linter exiting 127 because it is not
 * installed is a broken pipeline pretending to be a clean one.
 *
 * Distinct from Actions' `continue-on-error`, which is all-or-nothing, and
 * stored separately so a run screen can say *tolerated* rather than *passed*.
 */
export function softFailFrom(value: unknown): { any: boolean, statuses: number[] } | null {
  if (value === true)
    return { any: true, statuses: [] }

  if (Array.isArray(value)) {
    const statuses = value
      .map(one => Number(asRecord(one)?.['exit-status'] ?? one))
      .filter(one => Number.isInteger(one) && one >= 0 && one <= 255)

    return statuses.length > 0 ? { any: false, statuses } : null
  }

  const record = asRecord(value)

  if (record) {
    const statuses = asStringList(record['exit-status']).map(Number).filter(one => Number.isInteger(one))

    return statuses.length > 0 ? { any: false, statuses } : { any: record.any === true, statuses: [] }
  }

  return null
}

/**
 * `branches:` - the shorthand for the most common `if:`.
 *
 * `[main, 'release/*']`, and `!wip` to exclude. Buildkite's own shape, and it
 * exists because `if: github.ref == 'refs/heads/main'` is the expression
 * everybody writes and half of them get wrong - `refs/heads/` is easy to forget
 * and the failure is silent, since a condition nobody matches is a job that
 * simply never runs.
 */
export function branchesFrom(value: unknown): string[] {
  return asStringList(value).map(one => one.trim()).filter(Boolean)
}

/** `reviewos.block:` - the prompt, and the fields collected on the way through. */
function blockFrom(
  value: unknown,
  id: string,
  jobLine: number,
  source: string,
  errors: WorkflowError[],
): Record<string, unknown> {
  // `block: Deploy?` is the short form, because a gate with nothing to collect
  // is most of them.
  if (typeof value === 'string')
    return { prompt: value, fields: [] }

  const body = asRecord(value) ?? {}
  const prompt = typeof body.prompt === 'string' ? body.prompt : 'Continue?'
  const fields: Array<Record<string, unknown>> = []

  for (const [index, entry] of (Array.isArray(body.fields) ? body.fields : []).entries()) {
    const field = asRecord(entry)
    const where = `field ${index + 1} of job \`${id}\``

    if (!field) {
      errors.push({
        line: jobLine,
        message: `${where} is not a mapping`,
        fix: 'Each field is a `-` item with `key:` and `type:` under it.',
      })
      continue
    }

    const key = typeof field.key === 'string' ? field.key.trim() : ''
    const type = typeof field.type === 'string' ? field.type.trim() : 'string'

    if (!key) {
      errors.push({
        line: jobLine,
        message: `${where} has no \`key\``,
        fix: 'Give it a `key:`, which is the name later jobs read it by.',
      })
      continue
    }

    if (!['string', 'boolean', 'select'].includes(type)) {
      errors.push({
        line: lineOf(source, 'type', jobLine),
        message: `\`${type}\` is not a field type, in ${where}`,
        fix: 'The types are `string`, `boolean` and `select`.',
      })
      continue
    }

    const options = (Array.isArray(field.options) ? field.options : []).map(option => String(option))

    if (type === 'select' && options.length === 0) {
      errors.push({
        line: jobLine,
        message: `${where} is a \`select\` with no options`,
        fix: 'Add `options:` with the values somebody may choose.',
      })
      continue
    }

    fields.push({
      key,
      type,
      label: typeof field.label === 'string' ? field.label : key,
      required: field.required === true,
      default: field.default === undefined ? null : String(field.default),
      options,
    })
  }

  return { prompt, fields }
}

/** The extension settings a command job carries, omitting what it did not say. */
function settingsOf(retry: Record<string, unknown> | null, agents: string[]): Record<string, unknown> {
  const settings: Record<string, unknown> = {}

  if (retry)
    settings.retry = retry

  if (agents.length > 0)
    settings.agents = agents

  return settings
}

/**
 * `reviewos.agents:` - a tag query selecting which machines may take this job.
 *
 * `runs-on:` is a set membership test, which is the right shape for
 * `ubuntu-latest` and the wrong one for anything with a value in it. A fleet
 * with four GPU models ends up with labels called `gpu-a100` and `gpu-a10g`,
 * and a job that wants "any GPU with at least 40GB" cannot say so. A tag query
 * says `gpu=a100` and means it.
 *
 * Both shapes are accepted, because both are what people write: a list of
 * `key=value` strings, and a mapping. They normalize to the same thing.
 */
function agentsFrom(
  value: unknown,
  id: string,
  jobLine: number,
  source: string,
  errors: WorkflowError[],
): string[] {
  if (value === undefined || value === null)
    return []

  const entries: string[] = []

  if (Array.isArray(value)) {
    for (const entry of value)
      entries.push(String(entry))
  }
  else {
    const mapping = asRecord(value)

    if (!mapping) {
      errors.push({
        line: lineOf(source, 'agents', jobLine),
        message: `\`agents:\` in job \`${id}\` is neither a list nor a mapping`,
        fix: 'Write `agents: [gpu=a100]`, or `agents: { gpu: a100 }`.',
      })

      return []
    }

    for (const [key, entry] of Object.entries(mapping))
      entries.push(`${key}=${String(entry)}`)
  }

  const selectors: string[] = []

  for (const entry of entries) {
    const text = entry.trim()

    if (!text.includes('=')) {
      /*
       * Refused rather than read as a label. A selector that silently became a
       * label would match a different set of machines than the file says, and
       * the failure - a job running somewhere it should not - is invisible.
       */
      errors.push({
        line: lineOf(source, 'agents', jobLine),
        message: `\`${text}\` is not a tag query, in job \`${id}\``,
        fix: 'A tag query is `key=value`. For a plain label, use `runs-on:`.',
      })

      continue
    }

    selectors.push(text)
  }

  return selectors
}

/**
 * `reviewos.priority:` - which job leaves the queue first.
 *
 * Higher goes first, zero is the default, and negative is allowed and means
 * "after everything else". The case it exists for is one line long: a deploy
 * behind two hundred pull request checks waits for all of them, and the deploy
 * is the one somebody is watching.
 *
 * It orders a *queue*, it does not preempt: a job already running is not
 * stopped for a more important one. Preemption would mean killing work
 * somebody is waiting on to start work somebody else is waiting on, which
 * needs a policy rather than a number.
 */
function priorityFrom(
  value: unknown,
  id: string,
  jobLine: number,
  source: string,
  errors: WorkflowError[],
): number {
  if (value === undefined || value === null)
    return 0

  const priority = Number(value)

  if (!Number.isInteger(priority)) {
    errors.push({
      line: lineOf(source, 'priority', jobLine),
      message: `\`priority:\` in job \`${id}\` is not a whole number`,
      fix: 'Write `priority: 10`. Higher goes first; the default is 0.',
    })

    return 0
  }

  return Math.max(-1000, Math.min(1000, priority))
}

/**
 * `reviewos.retry:` - run a failed job again, automatically.
 *
 * The feature every CI system grows and the one that has to be bounded from the
 * first line: a retry with no cap is a job that fails forever on somebody
 * else's machine, and a retry that hides *everything* is a flaky test nobody
 * ever fixes. So the cap is required (the shorthand `retry: 2` is the cap), and
 * the run keeps every attempt rather than overwriting the last one.
 *
 * `exit-status:` narrows it to the failures worth repeating. A test suite that
 * exits 1 because an assertion failed is not worth running again; a step that
 * exits 137 because the machine ran out of memory, or a network fetch that
 * exits 7, is exactly what this is for. Naming the statuses is how a workflow
 * says which of those it means.
 */
function retryFrom(
  value: unknown,
  id: string,
  jobLine: number,
  source: string,
  errors: WorkflowError[],
): Record<string, unknown> | null {
  if (value === undefined || value === null)
    return null

  if (typeof value === 'number')
    return attemptsOf(value, id, jobLine, source, errors)

  const body = asRecord(value)

  if (!body) {
    errors.push({
      line: lineOf(source, 'retry', jobLine),
      message: `\`retry:\` in job \`${id}\` is neither a number nor a mapping`,
      fix: 'Write `retry: 2`, or `retry: { attempts: 2, exit-status: [137] }`.',
    })

    return null
  }

  const parsed = attemptsOf(body.attempts, id, jobLine, source, errors)

  if (!parsed)
    return null

  const statuses = (Array.isArray(body['exit-status']) ? body['exit-status'] : [])
    .map(entry => Number(entry))
    .filter(entry => Number.isInteger(entry))

  return { ...parsed, exitStatus: statuses }
}

/** The cap, which is required and bounded. */
function attemptsOf(
  value: unknown,
  id: string,
  jobLine: number,
  source: string,
  errors: WorkflowError[],
): Record<string, unknown> | null {
  const attempts = Number(value)

  if (!Number.isInteger(attempts) || attempts < 1) {
    errors.push({
      line: lineOf(source, 'retry', jobLine),
      message: `\`retry:\` in job \`${id}\` needs a number of extra attempts`,
      fix: 'Write `retry: 2` to try twice more after the first failure.',
    })

    return null
  }

  if (attempts > MAX_RETRY_ATTEMPTS) {
    errors.push({
      line: lineOf(source, 'retry', jobLine),
      message: `\`retry: ${attempts}\` in job \`${id}\` is more than this instance allows`,
      fix: `The ceiling is ${MAX_RETRY_ATTEMPTS}. A job that fails ${MAX_RETRY_ATTEMPTS} times in a row is not flaky, it is broken.`,
    })

    return null
  }

  return { attempts, exitStatus: [] }
}

/**
 * How many extra attempts a workflow may ask for.
 *
 * Five, and the refusal says why: a job that fails five times in a row is not
 * flaky, it is broken, and the retries are spending machines to postpone the
 * moment somebody looks at it.
 */
export const MAX_RETRY_ATTEMPTS = 5

/** `reviewos.trigger:` - which workflow to start, and what to pass it. */
function triggerFrom(
  value: unknown,
  id: string,
  jobLine: number,
  source: string,
  errors: WorkflowError[],
): Record<string, unknown> {
  if (typeof value === 'string')
    return { workflow: value, inputs: {}, await: false }

  const body = asRecord(value) ?? {}
  const workflow = typeof body.workflow === 'string' ? body.workflow.trim() : ''

  if (!workflow) {
    errors.push({
      line: lineOf(source, 'trigger', jobLine),
      message: `Job \`${id}\` triggers nothing`,
      fix: 'Name the workflow to start, for example `workflow: release.yml`.',
    })
  }

  return {
    workflow,
    inputs: asRecord(body.inputs) ?? {},
    /*
     * Async by default, which is Buildkite's default and the right one: a
     * trigger that waits turns one stuck run into two, and the common use -
     * "start the deploy pipeline" - has nothing to wait for.
     */
    await: body.await === true,
  }
}

/** `workflow_call.secrets`: names the called workflow says it needs. */
export function callSecretsFrom(value: unknown): Array<{ name: string, description: string, required: boolean }> {
  const record = asRecord(value)

  if (!record)
    return []

  return Object.entries(record).map(([name, body]) => {
    const definition = asRecord(body) ?? {}

    return {
      name,
      description: typeof definition.description === 'string' ? definition.description : '',
      required: definition.required === true,
    }
  })
}

/**
 * `concurrency:`, in both shapes.
 *
 * A bare string is the group with no cancellation; the mapping form carries
 * `cancel-in-progress`. Read rather than ignored: this is the key the roadmap
 * names Gitea for accepting and doing nothing with, which is how a workflow
 * that relies on it looks like it works.
 */
export function concurrencyFrom(value: unknown): WorkflowConcurrency | null {
  if (typeof value === 'string' && value.length > 0)
    return { group: value, cancelInProgress: false }

  const record = asRecord(value)

  if (!record || typeof record.group !== 'string')
    return null

  return { group: record.group, cancelInProgress: record['cancel-in-progress'] === true }
}

/** `defaults.run`, which every step inherits unless it says otherwise. */
/**
 * `environment:` as a name.
 *
 * A string, or Actions' object form where the name sits under `name` beside a
 * `url` this instance does not record. Read rather than refused, because a
 * workflow that already runs elsewhere should not have to be edited to run
 * here - and the url is a fact about a finished deploy, not a rule about
 * whether one may happen.
 */
export function environmentFrom(value: unknown): string | null {
  if (typeof value === 'string')
    return value.trim() || null

  const record = asRecord(value)
  const name = record?.name

  return typeof name === 'string' && name.trim() ? name.trim() : null
}

/**
 * `services:` into a list.
 *
 * Actions' shape is a map of name to definition, and the name matters: it is
 * what a step uses to reach the thing. A service with no `image` is dropped
 * rather than refused - the key alone says nothing about what to start, and a
 * parse error would fail a workflow over a line that means nothing either way.
 */
export function servicesFrom(value: unknown): WorkflowService[] {
  const record = asRecord(value)

  if (!record)
    return []

  const services: WorkflowService[] = []

  for (const [name, raw] of Object.entries(record)) {
    const body = asRecord(raw)
    const image = typeof body?.image === 'string' ? body.image.trim() : ''

    if (!image)
      continue

    services.push({
      name: String(name),
      image,
      env: asStringMap(body?.env),
      ports: asStringList(body?.ports),
    })
  }

  return services
}

export function defaultsFrom(value: unknown): { shell: string | null, workingDirectory: string | null } {
  const run = asRecord(asRecord(value)?.run)

  return {
    shell: typeof run?.shell === 'string' ? run.shell : null,
    workingDirectory: typeof run?.['working-directory'] === 'string' ? run['working-directory'] : null,
  }
}

/**
 * Jobs that cannot run because they wait on each other.
 *
 * Depth-first with a colour per node: grey while its subtree is being walked,
 * black when it is done. An edge back into a grey node is a cycle. Returned as
 * the job ids involved so the error can name them rather than say "a cycle
 * exists somewhere".
 */
export function cyclicJobs(jobs: readonly WorkflowJob[]): string[] {
  const byId = new Map(jobs.map(job => [job.id, job]))
  const state = new Map<string, 'open' | 'closed'>()
  const cycle: string[] = []

  const walk = (id: string, trail: string[]): boolean => {
    if (state.get(id) === 'closed')
      return false

    if (state.get(id) === 'open') {
      cycle.push(...trail.slice(trail.indexOf(id)), id)
      return true
    }

    state.set(id, 'open')

    for (const next of byId.get(id)?.needs ?? []) {
      if (byId.has(next) && walk(next, [...trail, id]))
        return true
    }

    state.set(id, 'closed')
    return false
  }

  for (const job of jobs) {
    if (walk(job.id, []))
      return [...new Set(cycle)]
  }

  return []
}

/**
 * Parse and check a workflow document.
 *
 * Every error it can find is reported in one pass rather than the first one
 * being thrown: somebody fixing a workflow file wants the list, and a parser
 * that reveals one problem per push is a parser people work around by pushing.
 */
/**
 * Options that change what a valid document *is*, rather than how it is read.
 *
 * There is exactly one, and it exists for uploaded steps: a job generated
 * mid-run may depend on a job that is already in the run and therefore not in
 * the document being parsed. Without this the parser would refuse the whole
 * upload, and the alternative - a second, laxer validator for uploaded steps -
 * would be the one an attacker reads.
 */
export interface ParseOptions {
  /** Job ids that exist outside this document and may be named in `needs:`. */
  knownJobs?: readonly string[]
}

export function parseWorkflow(source: string, path = 'workflow.yml', options: ParseOptions = {}): ParseResult {
  const errors: WorkflowError[] = []
  /*
   * A refused workflow carries no warnings.
   *
   * Its author has errors to fix, and a list of "by the way, `container:`
   * behaves differently here" underneath them is noise on top of a problem -
   * the differences matter once the file is valid enough to run.
   */
  const fail = (): ParseResult => ({ ok: false, workflow: null, errors, warnings: [] })

  let document: unknown
  try {
    document = Bun.YAML.parse(source)
  }
  catch (error) {
    errors.push({
      line: 0,
      message: `${path} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
      fix: 'Check the indentation. A tab character where spaces are expected is the usual cause.',
    })
    return fail()
  }

  const root = asRecord(document)
  if (!root) {
    errors.push({
      line: 1,
      message: `${path} does not describe a workflow`,
      fix: 'A workflow is a mapping with at least `on:` and `jobs:` at the top level.',
    })
    return fail()
  }

  for (const key of Object.keys(root)) {
    if (!TOP_LEVEL.has(key)) {
      errors.push({
        line: lineOf(source, key),
        message: `\`${key}\` is not a workflow key`,
        fix: `Remove it, or move it inside a job. The top level takes ${[...TOP_LEVEL].join(', ')}.`,
      })
    }
  }

  /*
   * Read here rather than in the return below, which is where it was written
   * first and where its errors went nowhere: the `errors.length > 0` gate runs
   * before the returned object is built, so a refusal pushed while building it
   * is a refusal nobody ever sees. A validator whose complaints are discarded
   * is worse than none - it reads like a check.
   */
  const intermediate = intermediateFrom(root.reviewos, source, errors)

  if (!('on' in root)) {
    errors.push({
      line: 1,
      message: 'This workflow has no `on:`, so nothing can start it',
      fix: 'Add a trigger, for example `on: push` or `on: { pull_request: {} }`.',
    })
  }

  const triggers = triggersFrom(root.on)

  // Recognised is the bar, not dispatched. A workflow triggered only on
  // `release` is a valid workflow whose trigger has not been implemented here
  // yet, and a reusable one is started by another workflow rather than by an
  // event at all - neither is a broken file, and calling them broken is how a
  // repository fails to move.
  const recognised = triggers.push !== null
    || triggers.pullRequest !== null
    || triggers.pullRequestTarget !== null
    // The subject triggers. Left out of this list when they were added, which
    // meant a workflow triggered *only* on issues - a labeller, the second
    // thing anybody automates - was refused as naming no event at all.
    || triggers.issues !== null
    || triggers.issueComment !== null
    || triggers.release !== null
    || triggers.schedule.length > 0
    || triggers.dispatch
    || triggers.reusable
    || triggers.unsupported.length > 0

  if ('on' in root && !recognised) {
    errors.push({
      line: lineOf(source, 'on'),
      message: 'Nothing in `on:` is an event GitHub Actions defines',
      fix: `Check the spelling. Common ones are ${[...DISPATCHED_EVENTS].join(', ')}.`,
    })
  }

  const jobsRecord = asRecord(root.jobs)
  if (!jobsRecord || Object.keys(jobsRecord).length === 0) {
    errors.push({
      line: lineOf(source, 'jobs') || 1,
      message: 'This workflow has no jobs',
      fix: 'Add `jobs:` with at least one job, each with `runs-on:` and `steps:`.',
    })
    return fail()
  }

  const jobs: WorkflowJob[] = []

  for (const [id, raw] of Object.entries(jobsRecord)) {
    const jobLine = lineOf(source, id)
    const body = asRecord(raw)

    if (!body) {
      errors.push({
        line: jobLine,
        message: `Job \`${id}\` is empty`,
        fix: 'Give it `runs-on:` and `steps:`, or remove it.',
      })
      continue
    }

    if (!/^[A-Za-z_][\w-]*$/.test(id)) {
      errors.push({
        line: jobLine,
        message: `\`${id}\` is not a usable job id`,
        fix: 'Use letters, digits, underscores and dashes, starting with a letter or underscore.',
      })
    }

    for (const key of Object.keys(body)) {
      if (!JOB_KEYS.has(key)) {
        errors.push({
          line: lineOf(source, key, jobLine),
          message: `\`${key}\` is not a job key, in job \`${id}\``,
          fix: 'Check the spelling. `runs-on` and `timeout-minutes` are hyphenated, not camel case.',
        })
      }
    }

    const runsOn = runsOnFrom(body['runs-on'])
    const callsAnother = typeof body.uses === 'string' && body.uses.length > 0
    const extension = extensionOf(body, id, jobLine, source, errors)

    /*
     * A job that calls another workflow has no `runs-on`, and requiring one
     * refused every reusable-workflow caller ever written. Its jobs run on
     * whatever the *called* workflow says, which is the point of calling it.
     *
     * Nor does a wait, block or trigger job: none of them reaches a machine at
     * all, so asking which machine would be asking about something that does
     * not happen.
     */
    if (runsOn.length === 0 && !callsAnother && extension.kind === 'command') {
      errors.push({
        line: jobLine,
        message: `Job \`${id}\` does not say what it runs on`,
        fix: 'Add `runs-on:` with a runner label, for example `runs-on: ubuntu-latest`.',
      })
    }

    const rawSteps = Array.isArray(body.steps) ? body.steps : []
    if (rawSteps.length === 0 && !('uses' in body) && extension.kind === 'command') {
      errors.push({
        line: jobLine,
        message: `Job \`${id}\` has no steps`,
        fix: 'Add `steps:` with at least one `run:` or `uses:`, or `uses:` a reusable workflow.',
      })
    }

    const steps: WorkflowStep[] = []

    rawSteps.forEach((rawStep, index) => {
      const step = asRecord(rawStep)
      const position = `step ${index + 1} of job \`${id}\``

      if (!step) {
        errors.push({
          line: jobLine,
          message: `${position} is not a mapping`,
          fix: 'Each step is a `-` item with `run:` or `uses:` under it.',
        })
        return
      }

      for (const key of Object.keys(step)) {
        if (!STEP_KEYS.has(key)) {
          errors.push({
            line: lineOf(source, key, jobLine),
            message: `\`${key}\` is not a step key, in ${position}`,
            fix: 'Arguments to an action go under `with:`; environment variables go under `env:`.',
          })
        }
      }

      const hasRun = typeof step.run === 'string' && step.run.length > 0
      const hasUses = typeof step.uses === 'string' && step.uses.length > 0

      if (hasRun && hasUses) {
        errors.push({
          line: lineOf(source, 'run', jobLine),
          message: `${position} has both \`run\` and \`uses\``,
          fix: 'A step either runs a command or uses an action. Split it into two steps.',
        })
      }

      if (!hasRun && !hasUses) {
        errors.push({
          line: jobLine,
          message: `${position} does nothing`,
          fix: 'Give it a `run:` command or a `uses:` action.',
        })
      }

      steps.push({
        id: typeof step.id === 'string' ? step.id : null,
        name: typeof step.name === 'string' ? step.name : null,
        run: hasRun ? String(step.run) : null,
        uses: hasUses ? String(step.uses) : null,
        with: asRecord(step.with) ?? {},
        env: asStringMap(step.env),
        workingDirectory: typeof step['working-directory'] === 'string' ? step['working-directory'] : null,
        shell: typeof step.shell === 'string' ? step.shell : null,
        // Only a literal `true`. An expression here - `${{ inputs.soft }}` -
        // needs the expression engine, and reading it as truthy text would make
        // every such step unfailable.
        continueOnError: step['continue-on-error'] === true,
        timeoutMinutes: typeof step['timeout-minutes'] === 'number' && Number.isFinite(step['timeout-minutes'])
          ? Number(step['timeout-minutes'])
          : null,
        if: typeof step.if === 'string' ? step.if : null,
      })
    })

    const timeout = body['timeout-minutes']
    const strategy = asRecord(body.strategy) ?? {}
    const matrix = expandMatrix(strategy.matrix as MatrixDefinition | undefined)

    if (matrix.problem) {
      errors.push({
        line: lineOf(source, 'matrix', jobLine),
        message: `Job \`${id}\`: ${matrix.problem}`,
        fix: 'Reduce the matrix, or split the workflow into more than one.',
      })
    }

    const maxParallel = strategy['max-parallel']

    jobs.push({
      id,
      name: typeof body.name === 'string' ? body.name : null,
      runsOn,
      needs: asStringList(body.needs),
      if: typeof body.if === 'string' ? body.if : null,
      timeoutMinutes: typeof timeout === 'number' && Number.isFinite(timeout) ? timeout : null,
      environment: environmentFrom(body.environment),
      services: servicesFrom(body.services),
      skip: extension.skip,
      softFail: extension.softFail,
      branches: extension.branches,
      allowDependencyFailure: extension.allowDependencyFailure,
      env: asStringMap(body.env),
      outputs: asStringMap(body.outputs),
      uses: typeof body.uses === 'string' && body.uses.length > 0 ? body.uses : null,
      withInputs: asRecord(body.with) ?? {},
      secrets: body.secrets ?? null,
      permissions: body.permissions ?? null,
      defaults: defaultsFrom(body.defaults),
      concurrency: concurrencyFrom(body.concurrency),
      steps,
      matrix: matrix.combinations,
      matrixLabels: matrix.combinations.map(combinationLabel),
      // Actions' default, and the surprising direction: one failed combination
      // cancels the rest unless the workflow says otherwise.
      failFast: strategy['fail-fast'] !== false,
      maxParallel: typeof maxParallel === 'number' && Number.isFinite(maxParallel) ? maxParallel : null,
      // Literal `true` only, for the same reason as the step-level one: an
      // expression here is read by nothing yet, and reading `${{ inputs.soft }}`
      // as truthy text would make a job unfailable by accident.
      continueOnError: body['continue-on-error'] === true,
      kind: extension.kind,
      settings: extension.settings,
      group: extension.group,
      ifChanged: extension.ifChanged,
      priority: extension.priority,
    })
  }

  /*
   * A barrier is sugar for `needs:`, resolved here.
   *
   * Buildkite's wait step is positional - everything before it finishes before
   * anything after it starts - and this turns that into edges: the barrier
   * needs every job declared before it, and every job declared after it needs
   * the barrier unless it named its own dependencies.
   *
   * Done once, at parse time, so **the graph a reader sees is the graph that
   * runs**. The alternative is a dispatcher that knows about positions, which
   * means a run page that cannot explain why a job is waiting without
   * re-deriving the file.
   */
  for (const [index, job] of jobs.entries()) {
    if (job.kind !== 'wait')
      continue

    const before = jobs.slice(0, index).map(other => other.id)
    const after = jobs.slice(index + 1)

    job.needs = [...new Set([...job.needs, ...before])]

    for (const later of after) {
      if (later.needs.length === 0)
        later.needs = [job.id]
    }
  }

  /*
   * Jobs this document declares, plus any the caller says already exist. The
   * second half is empty for a workflow file and holds the run's jobs for an
   * upload.
   */
  const known = new Set([...jobs.map(job => job.id), ...(options.knownJobs ?? [])])

  for (const job of jobs) {
    for (const need of job.needs) {
      if (!known.has(need)) {
        errors.push({
          line: lineOf(source, 'needs', lineOf(source, job.id)),
          message: `Job \`${job.id}\` needs \`${need}\`, which is not a job in this workflow`,
          fix: `Check the spelling. This workflow has ${[...known].join(', ')}.`,
        })
      }
    }

    if (job.needs.includes(job.id)) {
      errors.push({
        line: lineOf(source, 'needs', lineOf(source, job.id)),
        message: `Job \`${job.id}\` needs itself`,
        fix: 'Remove it from its own `needs:`.',
      })
    }
  }

  const cycle = cyclicJobs(jobs)
  if (cycle.length > 0) {
    errors.push({
      line: lineOf(source, 'jobs'),
      message: `These jobs wait on each other and none can start: ${cycle.join(' → ')}`,
      fix: 'Break the loop by removing one of those `needs:` entries.',
    })
  }

  if (errors.length > 0)
    return fail()

  return {
    ok: true,
    errors: [],
    /*
     * Read from the same table the published page renders, so a difference
     * cannot be documented one way and warned about another - and so adding a
     * divergence without writing down its reason is impossible rather than
     * merely discouraged.
     */
    warnings: differencesIn(root).map(difference => ({
      key: difference.key,
      status: difference.status as 'differs' | 'unimplemented',
      message: difference.behaviour,
    })),
    workflow: {
      name: typeof root.name === 'string' ? root.name : null,
      triggers,
      jobs,
      env: asStringMap(root.env),
      permissions: root.permissions ?? null,
      concurrency: concurrencyFrom(root.concurrency),
      defaults: defaultsFrom(root.defaults),
      intermediate,
    },
  }
}

/**
 * `reviewos.intermediate:` - what to do with runs still waiting when a newer
 * one arrives.
 *
 * The third option neither Actions nor Gitea offers, and the one people
 * actually want when three commits land in a minute: let the build that has
 * already started finish, and drop the ones that have not, because only the
 * newest commit's result is going to be read. `cancel` is
 * `concurrency.cancel-in-progress` said in one word, and `run` is the default
 * because it is Actions' behaviour and changing it silently would mean a run
 * somebody expected simply not existing.
 */
function intermediateFrom(value: unknown, source: string, errors: WorkflowError[]): IntermediateRuns {
  const raw = asRecord(value)

  if (!raw)
    return 'run'

  for (const key of Object.keys(raw)) {
    if (!WORKFLOW_EXTENSION_KEYS.has(key)) {
      errors.push({
        line: lineOf(source, key, lineOf(source, 'reviewos')),
        message: `\`${key}\` is not a workflow-level \`reviewos:\` key`,
        fix: 'The only one is `intermediate`. The rest go on a job.',
      })
    }
  }

  const intermediate = String(raw.intermediate ?? 'run').trim()

  if (!['run', 'skip', 'cancel'].includes(intermediate)) {
    errors.push({
      line: lineOf(source, 'intermediate', lineOf(source, 'reviewos')),
      message: `\`intermediate: ${intermediate}\` is not one of \`run\`, \`skip\` or \`cancel\``,
      fix: '`skip` drops runs that have not started, `cancel` stops ones that have, `run` is Actions\' behaviour.',
    })

    return 'run'
  }

  return intermediate as IntermediateRuns
}
