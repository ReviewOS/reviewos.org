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
  env: Record<string, string>
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
   * Read rather than ignored, which is the whole point of naming Gitea in the
   * roadmap: it accepts `concurrency:` and does nothing with it, so a workflow
   * that relies on it looks like it works.
   */
  concurrency: WorkflowConcurrency | null
  defaults: { shell: string | null, workingDirectory: string | null }
}

export type ParseResult =
  | { ok: true, workflow: NormalizedWorkflow, errors: [] }
  | { ok: false, workflow: null, errors: WorkflowError[] }

/** Top-level keys Actions defines. Anything else is a typo worth catching. */
const TOP_LEVEL = new Set(['name', 'on', 'jobs', 'env', 'defaults', 'concurrency', 'permissions', 'run-name'])

const JOB_KEYS = new Set([
  'name', 'runs-on', 'needs', 'if', 'steps', 'env', 'timeout-minutes',
  'strategy', 'continue-on-error', 'container', 'services', 'outputs',
  'permissions', 'concurrency', 'defaults', 'environment', 'uses', 'with', 'secrets',
])

const STEP_KEYS = new Set([
  'id', 'name', 'run', 'uses', 'with', 'env', 'if',
  'working-directory', 'shell', 'continue-on-error', 'timeout-minutes',
])

/** The events this instance can start a run from today. */
const DISPATCHED_EVENTS = new Set([
  'push', 'pull_request', 'pull_request_target', 'schedule', 'workflow_dispatch',
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
    schedule: [],
    dispatch: false,
    dispatchInputs: [],
    reusable: false,
    unsupported: [],
  }

  const named = (name: string, filter: TriggerFilter) => {
    if (name === 'push')
      triggers.push = filter
    else if (name === 'pull_request')
      triggers.pullRequest = filter
    else if (name === 'pull_request_target')
      triggers.pullRequestTarget = filter
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
export function parseWorkflow(source: string, path = 'workflow.yml'): ParseResult {
  const errors: WorkflowError[] = []
  const fail = (): ParseResult => ({ ok: false, workflow: null, errors })

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
    if (runsOn.length === 0) {
      errors.push({
        line: jobLine,
        message: `Job \`${id}\` does not say what it runs on`,
        fix: 'Add `runs-on:` with a runner label, for example `runs-on: ubuntu-latest`.',
      })
    }

    const rawSteps = Array.isArray(body.steps) ? body.steps : []
    if (rawSteps.length === 0 && !('uses' in body)) {
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
      env: asStringMap(body.env),
      steps,
      matrix: matrix.combinations,
      matrixLabels: matrix.combinations.map(combinationLabel),
      // Actions' default, and the surprising direction: one failed combination
      // cancels the rest unless the workflow says otherwise.
      failFast: strategy['fail-fast'] !== false,
      maxParallel: typeof maxParallel === 'number' && Number.isFinite(maxParallel) ? maxParallel : null,
    })
  }

  const known = new Set(jobs.map(job => job.id))

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
    workflow: {
      name: typeof root.name === 'string' ? root.name : null,
      triggers,
      jobs,
      env: asStringMap(root.env),
      concurrency: concurrencyFrom(root.concurrency),
      defaults: defaultsFrom(root.defaults),
    },
  }
}
