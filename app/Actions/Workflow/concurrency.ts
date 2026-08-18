/**
 * Concurrency groups: which runs may exist at once.
 *
 * This is the key [the roadmap](../../../docs/todo/15-pipelines.md) names Gitea
 * for accepting and ignoring, which is how a workflow that depends on it looks
 * like it works. A group with `cancel-in-progress` is how a branch stops
 * spending runners on commits nobody is waiting for any more: push three times
 * in a minute and the first two runs should stop, not finish.
 *
 * The group is written as a template, so it has to be resolved against the
 * event that started the run rather than stored resolved.
 */

import { evaluateExpression } from './expression'

/** What a run needs to know about itself to resolve a group. */
export interface ConcurrencyContext {
  /** The workflow's `name:`, or its file path when it has none. */
  workflow: string
  /** `push`, `pull_request`, `pull_request_target`, `schedule`, ... */
  eventName: string
  /** The full ref, `refs/heads/main` or `refs/pull/12/head`. */
  ref: string
  /** The head commit. */
  sha: string
  /** For a pull request, the source branch. Empty for a push. */
  headRef?: string
  /** For a pull request, the base branch. Empty for a push. */
  baseRef?: string
  /** The pull request's number, when there is one. */
  number?: number | null
  /**
   * The paths this run's event touched, for per-job `if-changed`.
   *
   * Empty means *unknown* rather than "nothing changed", which is the same
   * convention the trigger filters use: a job whose globs cannot be checked
   * runs, because the visible failure is better than the invisible one.
   */
  changed?: readonly string[]
  /**
   * The head commit's message, when the event carried one.
   *
   * Part of the documented set a job's `if:` may read - and nothing more than
   * that: an expression here reads the event, never the control plane.
   */
  message?: string
  /** `workflow_dispatch` inputs, for a job's `if:`. */
  inputs?: Record<string, unknown>
  /**
   * This job's matrix combination, when it has one.
   *
   * Offered to a *job's* group expression, because a matrix job whose group
   * names none of its values puts every combination in one group - and under
   * `cancel-in-progress` they then cancel each other. Actions behaves the same
   * way; what it does not do is withhold the values, so neither does this.
   */
  matrix?: Record<string, unknown> | null
}

/**
 * The context values a group template may refer to.
 *
 * Deliberately a small, closed set: these are the ones dispatch actually knows
 * at the moment a run is created, and they cover every group expression in
 * common use. A reference to anything else is left in the group as written -
 * see `resolveGroup` for why that is the safe direction.
 */
function contextValues(context: ConcurrencyContext): Record<string, string> {
  const ref = context.ref ?? ''

  return {
    'github.workflow': context.workflow ?? '',
    'github.event_name': context.eventName ?? '',
    'github.ref': ref,
    'github.ref_name': ref.replace(/^refs\/(?:heads|tags)\//, ''),
    'github.sha': context.sha ?? '',
    'github.head_ref': context.headRef ?? '',
    'github.base_ref': context.baseRef ?? '',
    'github.run_id': '',
    'github.event.number': context.number ? String(context.number) : '',
    'github.event.pull_request.number': context.number ? String(context.number) : '',
    ...matrixValues(context.matrix),
  }
}

/** `matrix.node` and friends, flattened for substitution. */
function matrixValues(matrix: Record<string, unknown> | null | undefined): Record<string, string> {
  if (!matrix)
    return {}

  const values: Record<string, string> = {}

  for (const [name, value] of Object.entries(matrix)) {
    values[`matrix.${name}`] = value !== null && typeof value === 'object'
      ? JSON.stringify(value)
      : String(value ?? '')
  }

  return values
}

/**
 * A group template with its context references filled in.
 *
 * Only the closed set above is substituted; `${{ ... }}` holding anything else
 * - a function call, a secret, an `||` fallback - is left exactly as written.
 *
 * That is the safe direction and worth being explicit about. An unresolved
 * expression groups every run of that workflow together, which under
 * `cancel-in-progress` would cancel runs that should have been independent. So
 * a group that still contains `${{` after substitution is treated as *no
 * group* by `resolveGroup`, and the runs stay independent. Grouping too little
 * wastes runners; grouping too much cancels somebody's build.
 */
export function fillGroup(template: string, context: ConcurrencyContext): string {
  const values = contextValues(context)

  return template.replace(/\$\{\{([^}]*)\}\}/g, (whole: string, inner: string) => {
    const key = String(inner).trim()

    if (Object.hasOwn(values, key))
      return String(values[key] ?? '')

    /*
     * Anything beyond a plain context read goes to the expression engine -
     * `${{ github.head_ref || github.ref }}` is the fallback idiom, and it was
     * previously left unresolved, which meant no group at all.
     *
     * Still no group when the engine cannot answer either: an expression this
     * side cannot evaluate must not become one literal string shared by every
     * run of the workflow. Grouping too little wastes runners; grouping too
     * much cancels somebody's build.
     */
    const result = evaluateExpression(key, expressionContext(context))

    return result.ok && result.value !== null ? String(result.value) : whole
  })
}

/** The same facts, in the shape the expression language reads. */
function expressionContext(context: ConcurrencyContext): Record<string, unknown> {
  const ref = context.ref ?? ''

  return {
    github: {
      workflow: context.workflow ?? '',
      event_name: context.eventName ?? '',
      ref,
      ref_name: ref.replace(/^refs\/(?:heads|tags)\//, ''),
      sha: context.sha ?? '',
      head_ref: context.headRef ?? '',
      base_ref: context.baseRef ?? '',
      event: context.number ? { number: context.number, pull_request: { number: context.number } } : {},
    },
    matrix: context.matrix ?? {},
  }
}

/**
 * The group this run belongs to, or null when it belongs to none.
 *
 * Null for a workflow with no `concurrency:`, and null for a group whose
 * expression could not be fully resolved - see `fillGroup`.
 */
export function resolveGroup(
  template: string | null | undefined,
  context: ConcurrencyContext,
): string | null {
  const text = String(template ?? '').trim()

  if (!text)
    return null

  const filled = fillGroup(text, context).trim()

  if (!filled || filled.includes('${{'))
    return null

  /*
   * Namespaced by event, the way Actions does *not*.
   *
   * Actions groups a push and a pull request together when they resolve to the
   * same string, and people rely on that: `group: ${{ github.ref }}` is meant
   * to stop a branch's push run and its pull request run from both running.
   * So this does not namespace either - the string is the group, exactly as
   * written. Recorded here because the temptation to add the event name is
   * strong and it would quietly break the most common group in existence.
   */
  return filled.slice(0, 500)
}
