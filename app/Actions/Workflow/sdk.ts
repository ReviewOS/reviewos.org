/**
 * Workflows as code: the second front door, not a second product.
 *
 * The whole design constraint is in that sentence. A typed program that emitted
 * its own graph, its own scheduler and its own vocabulary would be a fork of
 * this product with a nicer editor experience - so this builds the *same*
 * document the YAML path reads, and the normalization, the conformance table
 * and every rule about what a job may do come from the one place they already
 * live.
 *
 * What it buys is what YAML cannot express: ordinary control flow. Twelve jobs
 * over a list of packages is a loop rather than twelve copies somebody keeps in
 * step, and a shared step is a function rather than an anchor.
 *
 * **It is not a runtime.** Nothing here runs a workflow, and nothing here
 * reaches the control plane. The program runs where the author is - or, when
 * this becomes a workflow that generates workflows, as an orchestrator job
 * under phase 9's rules - and its output is a document. That is what keeps the
 * determinism problem small: the only thing that has to be deterministic is the
 * *shape*, and the shape is written down.
 */

export interface StepSpec {
  name?: string
  run?: string
  uses?: string
  with?: Record<string, string | number | boolean>
  env?: Record<string, string>
  if?: string
  continueOnError?: boolean
  workingDirectory?: string
}

export interface JobSpec {
  name?: string
  runsOn?: string | string[]
  needs?: string[]
  if?: string
  env?: Record<string, string>
  timeoutMinutes?: number
  environment?: string
  strategy?: { matrix?: Record<string, Array<string | number>>, failFast?: boolean }
  /** The `reviewos:` extensions, typed rather than spelled out in a string. */
  reviewos?: Record<string, unknown>
  steps: StepSpec[]
}

export interface WorkflowSpec {
  name: string
  on: {
    push?: { branches?: string[], tags?: string[], paths?: string[] }
    pullRequest?: { branches?: string[], paths?: string[] }
    schedule?: string[]
    workflowDispatch?: boolean | { inputs?: Record<string, { description?: string, default?: string, required?: boolean, type?: 'string' | 'boolean' | 'choice' | 'environment', options?: string[] }> }
  }
  env?: Record<string, string>
  concurrency?: { group: string, cancelInProgress?: boolean }
  jobs: Record<string, JobSpec>
}

/**
 * The builder a workflow program uses.
 *
 * A function rather than a class, and it takes no clock, no environment and no
 * network: the only things in scope are the ones whose value is the same on
 * every run. That is the first half of the determinism rule, enforced by the
 * shape of what an author is handed rather than by a warning they read later.
 */
export interface WorkflowBuilder {
  /** Add a job. The id is what `needs:` refers to and what the run screen shows. */
  job: (id: string, spec: JobSpec) => WorkflowBuilder
  /** The ids added so far, so a later job can depend on all of them. */
  ids: () => string[]
}

export function defineWorkflow(
  head: Omit<WorkflowSpec, 'jobs'>,
  build: (builder: WorkflowBuilder) => void,
): WorkflowSpec {
  const jobs: Record<string, JobSpec> = {}

  const builder: WorkflowBuilder = {
    job(id, spec) {
      const key = String(id ?? '').trim()

      if (!key)
        throw new Error('a job needs an id: it is what `needs:` refers to')

      /*
       * A duplicate id is refused rather than merged. In YAML the second key
       * silently wins; in a program written with a loop it is usually a
       * template that forgot to vary, and finding that out at build time is
       * the difference between one wrong job and twelve.
       */
      if (jobs[key])
        throw new Error(`\`${key}\` is already a job in this workflow`)

      jobs[key] = spec

      return builder
    },
    ids: () => Object.keys(jobs),
  }

  build(builder)

  return { ...head, jobs }
}

/**
 * The document, as the YAML this instance already reads.
 *
 * Emitting YAML rather than normalized rows directly is the decision that keeps
 * this a front door: the parser, the conformance table, the extension rules and
 * every refusal are shared, so an SDK workflow cannot quietly express something
 * a YAML workflow may not. It also means the output is a file a person can read
 * in a review, which is the difference between a program that generates CI and
 * a black box that runs it.
 */
export function toYaml(workflow: WorkflowSpec): string {
  const lines: string[] = [`name: ${scalar(workflow.name)}`]

  lines.push('', 'on:')

  if (workflow.on.push) {
    lines.push('  push:')

    for (const [key, values] of [['branches', workflow.on.push.branches], ['tags', workflow.on.push.tags], ['paths', workflow.on.push.paths]] as const) {
      if (values && values.length > 0)
        lines.push(`    ${key}: [${values.map(scalar).join(', ')}]`)
    }

    if (!workflow.on.push.branches && !workflow.on.push.tags && !workflow.on.push.paths)
      lines[lines.length - 1] = '  push: {}'
  }

  if (workflow.on.pullRequest) {
    lines.push('  pull_request:')

    for (const [key, values] of [['branches', workflow.on.pullRequest.branches], ['paths', workflow.on.pullRequest.paths]] as const) {
      if (values && values.length > 0)
        lines.push(`    ${key}: [${values.map(scalar).join(', ')}]`)
    }

    if (!workflow.on.pullRequest.branches && !workflow.on.pullRequest.paths)
      lines[lines.length - 1] = '  pull_request: {}'
  }

  if (workflow.on.schedule && workflow.on.schedule.length > 0) {
    lines.push('  schedule:')

    for (const cron of workflow.on.schedule)
      lines.push(`    - cron: ${scalar(cron)}`)
  }

  if (workflow.on.workflowDispatch) {
    const dispatch = workflow.on.workflowDispatch

    if (dispatch === true || !dispatch.inputs) {
      lines.push('  workflow_dispatch: {}')
    }
    else {
      lines.push('  workflow_dispatch:', '    inputs:')

      for (const [name, input] of Object.entries(dispatch.inputs)) {
        lines.push(`      ${name}:`)

        if (input.description)
          lines.push(`        description: ${scalar(input.description)}`)

        if (input.type)
          lines.push(`        type: ${input.type}`)

        if (input.required !== undefined)
          lines.push(`        required: ${input.required}`)

        if (input.default !== undefined)
          lines.push(`        default: ${scalar(input.default)}`)

        if (input.options && input.options.length > 0)
          lines.push(`        options: [${input.options.map(scalar).join(', ')}]`)
      }
    }
  }

  if (workflow.env && Object.keys(workflow.env).length > 0) {
    lines.push('', 'env:')

    for (const [key, value] of Object.entries(workflow.env))
      lines.push(`  ${key}: ${scalar(value)}`)
  }

  if (workflow.concurrency) {
    lines.push('', 'concurrency:')
    lines.push(`  group: ${scalar(workflow.concurrency.group)}`)

    if (workflow.concurrency.cancelInProgress !== undefined)
      lines.push(`  cancel-in-progress: ${workflow.concurrency.cancelInProgress}`)
  }

  lines.push('', 'jobs:')

  for (const [id, job] of Object.entries(workflow.jobs))
    lines.push(...jobLines(id, job))

  return `${lines.join('\n')}\n`
}

function jobLines(id: string, job: JobSpec): string[] {
  const lines: string[] = [`  ${id}:`]

  if (job.name)
    lines.push(`    name: ${scalar(job.name)}`)

  if (job.needs && job.needs.length === 1)
    lines.push(`    needs: ${job.needs[0]}`)
  else if (job.needs && job.needs.length > 1)
    lines.push(`    needs: [${job.needs.join(', ')}]`)

  if (job.if)
    lines.push(`    if: ${scalar(job.if)}`)

  const runsOn = job.runsOn ?? 'ubuntu-latest'

  lines.push(Array.isArray(runsOn)
    ? `    runs-on: [${runsOn.map(scalar).join(', ')}]`
    : `    runs-on: ${scalar(runsOn)}`)

  if (job.environment)
    lines.push(`    environment: ${scalar(job.environment)}`)

  if (job.timeoutMinutes)
    lines.push(`    timeout-minutes: ${job.timeoutMinutes}`)

  if (job.strategy?.matrix) {
    lines.push('    strategy:')

    if (job.strategy.failFast !== undefined)
      lines.push(`      fail-fast: ${job.strategy.failFast}`)

    lines.push('      matrix:')

    for (const [key, values] of Object.entries(job.strategy.matrix))
      lines.push(`        ${key}: [${values.map(one => scalar(String(one))).join(', ')}]`)
  }

  if (job.env && Object.keys(job.env).length > 0) {
    lines.push('    env:')

    for (const [key, value] of Object.entries(job.env))
      lines.push(`      ${key}: ${scalar(value)}`)
  }

  if (job.reviewos && Object.keys(job.reviewos).length > 0) {
    lines.push('    reviewos:')
    lines.push(...mapping(job.reviewos, 6))
  }

  lines.push('    steps:')

  for (const step of job.steps) {
    const first = step.name ? `      - name: ${scalar(step.name)}` : null

    if (first)
      lines.push(first)

    const prefix = first ? '        ' : '      - '

    if (step.uses)
      lines.push(`${prefix}uses: ${scalar(step.uses)}`)

    if (step.run) {
      if (step.run.includes('\n')) {
        lines.push(`${prefix}run: |`)

        for (const line of step.run.split('\n'))
          lines.push(`          ${line}`)
      }
      else {
        lines.push(`${prefix}run: ${scalar(step.run)}`)
      }
    }

    const rest = first ? '        ' : '        '

    if (step.if)
      lines.push(`${rest}if: ${scalar(step.if)}`)

    if (step.workingDirectory)
      lines.push(`${rest}working-directory: ${scalar(step.workingDirectory)}`)

    if (step.continueOnError)
      lines.push(`${rest}continue-on-error: true`)

    if (step.with && Object.keys(step.with).length > 0) {
      lines.push(`${rest}with:`)

      for (const [key, value] of Object.entries(step.with))
        lines.push(`${rest}  ${key}: ${typeof value === 'string' ? scalar(value) : String(value)}`)
    }

    if (step.env && Object.keys(step.env).length > 0) {
      lines.push(`${rest}env:`)

      for (const [key, value] of Object.entries(step.env))
        lines.push(`${rest}  ${key}: ${scalar(value)}`)
    }
  }

  lines.push('')

  return lines
}

/** A nested mapping, for the extension block, at a given indent. */
function mapping(value: Record<string, unknown>, indent: number): string[] {
  const lines: string[] = []
  const pad = ' '.repeat(indent)

  for (const [key, one] of Object.entries(value)) {
    if (Array.isArray(one)) {
      lines.push(`${pad}${key}:`)

      for (const item of one) {
        if (item && typeof item === 'object') {
          const entries = Object.entries(item as Record<string, unknown>)

          lines.push(`${pad}  - ${entries[0]![0]}: ${scalar(String(entries[0]![1]))}`)

          for (const [nestedKey, nestedValue] of entries.slice(1))
            lines.push(`${pad}    ${nestedKey}: ${scalar(String(nestedValue))}`)

          continue
        }

        lines.push(`${pad}  - ${scalar(String(item))}`)
      }

      continue
    }

    if (one && typeof one === 'object') {
      lines.push(`${pad}${key}:`)
      lines.push(...mapping(one as Record<string, unknown>, indent + 2))
      continue
    }

    lines.push(`${pad}${key}: ${typeof one === 'string' ? scalar(one) : String(one)}`)
  }

  return lines
}

/**
 * A YAML scalar that cannot be misread.
 *
 * Quoted whenever it is not plainly a word, which covers the cases that bite:
 * a command with a colon in it, a cron expression, a version that YAML would
 * otherwise read as a number, and `${{ }}` - which starts with a brace and
 * would be read as a mapping.
 */
function scalar(value: string): string {
  const text = String(value ?? '')

  return /^[\w][\w./@-]*$/.test(text) ? text : `'${text.replace(/'/g, "''")}'`
}
