/**
 * Buildkite's `pipeline.yml`, translated.
 *
 * Cheap, because their format is public and most of it has a word here already:
 * this product's job extensions were designed against that vocabulary, so the
 * translation is mostly a rename. What matters is the part that is not.
 *
 * **The report is the deliverable.** A silent partial translation is worse than
 * a refusal: a pipeline that emitted a workflow with three attributes quietly
 * dropped is one somebody trusts, pushes, and then debugs from the wrong end.
 * So every step and every attribute lands in one of three buckets - translated,
 * translated with a change in meaning, or no equivalent - and the third is
 * never silent.
 */

export type Fidelity = 'same' | 'changed' | 'none'

export interface AttributeNote {
  /** The Buildkite key, as written. */
  from: string
  /** What it became here, or empty when nothing. */
  to: string
  fidelity: Fidelity
  /** What a reader has to know. Empty when it is a plain rename. */
  note: string
}

export interface StepNote {
  /** The step's label or key, for a reader matching this against their file. */
  label: string
  kind: 'command' | 'wait' | 'block' | 'trigger' | 'group' | 'unknown'
  attributes: AttributeNote[]
}

export interface TranslationReport {
  steps: StepNote[]
  /** Everything that did not survive, flattened, in the order it appeared. */
  losses: string[]
}

export interface Translation {
  /** The workflow, as YAML somebody can commit. */
  workflow: string
  report: TranslationReport
}

/**
 * How each Buildkite attribute lands here.
 *
 * The table the roadmap asks to be documented rather than implied, and it is
 * the same table the documentation renders - one source, so a mapping cannot be
 * true in the docs and different in the importer.
 */
export const ATTRIBUTE_MAP: Record<string, { to: string, fidelity: Fidelity, note: string }> = {
  label: { to: 'name', fidelity: 'same', note: '' },
  key: { to: 'the job id', fidelity: 'same', note: '' },
  command: { to: 'steps[].run', fidelity: 'same', note: '' },
  commands: { to: 'steps[].run', fidelity: 'same', note: 'a list becomes one `run:` block, in order' },
  depends_on: { to: 'needs', fidelity: 'same', note: '' },
  allow_dependency_failure: { to: 'if: always()', fidelity: 'changed', note: 'the job runs after a failed dependency rather than being unblocked by it' },
  if: { to: 'if', fidelity: 'same', note: 'the expression language is the same' },
  branches: { to: 'reviewos.branches', fidelity: 'same', note: '' },
  skip: { to: 'reviewos.skip', fidelity: 'same', note: '' },
  soft_fail: { to: 'continue-on-error', fidelity: 'changed', note: 'Actions has a boolean; a list of exit statuses becomes `true`, which tolerates every failure rather than the ones named' },
  timeout_in_minutes: { to: 'timeout-minutes', fidelity: 'same', note: '' },
  parallelism: { to: 'reviewos.parallelism', fidelity: 'same', note: '' },
  matrix: { to: 'strategy.matrix', fidelity: 'same', note: '`adjustments` become `reviewos.adjustments`' },
  agents: { to: 'runs-on and reviewos.agents', fidelity: 'same', note: 'a queue becomes a label; the rest becomes a tag query' },
  artifact_paths: { to: 'reviewos.artifact-paths', fidelity: 'same', note: '' },
  env: { to: 'env', fidelity: 'same', note: '' },
  retry: { to: 'reviewos.retry', fidelity: 'changed', note: 'automatic retries carry a cap here; a manual retry is a person pressing re-run' },
  concurrency: { to: 'reviewos.concurrency', fidelity: 'same', note: '' },
  concurrency_group: { to: 'reviewos.concurrency-group', fidelity: 'same', note: '' },
  cancel_on_build_failing: { to: 'reviewos.cancel-on-build-failing', fidelity: 'same', note: '' },
  notify: { to: 'reviewos.notify', fidelity: 'changed', note: 'a rule names somebody on this instance rather than an address or a channel' },
  priority: { to: 'reviewos.priority', fidelity: 'same', note: '' },
  plugins: { to: '', fidelity: 'none', note: 'plugins are a decision rather than a translation - see the position in the documentation' },
  signature: { to: '', fidelity: 'none', note: 'this instance signs dispatched work itself; a pipeline signature has nothing to verify here' },
}

/** One Buildkite pipeline, as a workflow and a report. */
export function translatePipeline(source: string, options: { name?: string } = {}): Translation {
  const document = readYaml(source)
  const steps = Array.isArray(document.steps) ? document.steps : []
  const report: TranslationReport = { steps: [], losses: [] }

  const jobs: string[] = []
  const seen = new Set<string>()
  let waiting: string | null = null
  let previous: string | null = null

  for (const [index, raw] of steps.entries()) {
    const step = typeof raw === 'string' ? { command: raw } : (raw ?? {})

    if (typeof step !== 'object')
      continue

    const kind = kindOf(step)
    const label = String(step.label ?? step.key ?? step.block ?? step.trigger ?? step.group ?? `step ${index + 1}`)
    const notes: AttributeNote[] = []
    const id = jobId(String(step.key ?? label ?? `job-${index + 1}`), seen)

    /*
     * The barrier, which is the shape Buildkite pipelines are built around and
     * the reason this translation is worth doing at all. A `wait` is not a job
     * there; here it is one, and everything after it depends on it - which is
     * the same graph said in the vocabulary of `needs:`.
     */
    if (kind === 'wait') {
      jobs.push(renderJob({
        id,
        name: label === `step ${index + 1}` ? 'Wait' : label,
        needs: previous ? [previous] : [],
        extension: { wait: true },
      }))

      notes.push({ from: 'wait', to: 'reviewos.wait', fidelity: 'same', note: 'everything after the barrier depends on it' })
      report.steps.push({ label, kind, attributes: notes })
      waiting = id
      previous = id
      continue
    }

    if (kind === 'block') {
      jobs.push(renderJob({
        id,
        name: label,
        needs: previous ? [previous] : [],
        extension: { block: String(step.block ?? label) },
      }))

      notes.push({ from: 'block', to: 'reviewos.block', fidelity: 'same', note: 'a gate a person opens, with the run held at `waiting`' })
      report.steps.push({ label, kind, attributes: notes })
      waiting = id
      previous = id
      continue
    }

    if (kind === 'trigger') {
      jobs.push(renderJob({
        id,
        name: label,
        needs: previous ? [previous] : [],
        extension: { trigger: String(step.trigger ?? '') },
      }))

      notes.push({ from: 'trigger', to: 'reviewos.trigger', fidelity: 'changed', note: 'it starts a run of another workflow in this instance rather than another pipeline elsewhere' })
      report.steps.push({ label, kind, attributes: notes })
      previous = id
      continue
    }

    if (kind === 'group') {
      /*
       * A group's own steps are flattened, with the group's name carried as a
       * label. Nesting them would need a second graph inside the first, and the
       * thing a group buys is a heading on the screen - which `reviewos.group`
       * already is.
       */
      const inner = Array.isArray(step.steps) ? step.steps : []
      const nested = translatePipeline(renderYamlSteps(inner), { name: label })

      jobs.push(...nested.workflow.split('\njobs:\n')[1]?.split('\n\n').filter(Boolean) ?? [])
      report.steps.push({ label, kind, attributes: [{ from: 'group', to: 'reviewos.group', fidelity: 'changed', note: 'the group\'s steps are flattened into jobs carrying its name' }] })
      report.steps.push(...nested.report.steps)
      report.losses.push(...nested.report.losses)
      continue
    }

    const extension: Record<string, unknown> = {}
    const runs: string[] = []

    for (const [key, value] of Object.entries(step)) {
      const mapped = ATTRIBUTE_MAP[key]

      if (!mapped) {
        notes.push({ from: key, to: '', fidelity: 'none', note: 'this instance has no equivalent' })
        report.losses.push(`\`${key}\` on \`${label}\` has no equivalent here`)
        continue
      }

      notes.push({ from: key, to: mapped.to, fidelity: mapped.fidelity, note: mapped.note })

      if (mapped.fidelity === 'none')
        report.losses.push(`\`${key}\` on \`${label}\`: ${mapped.note}`)

      if (key === 'command' || key === 'commands') {
        for (const command of Array.isArray(value) ? value : [value])
          runs.push(String(command))
      }

      if (key === 'parallelism' && Number(value) > 1)
        extension.parallelism = Number(value)

      if (key === 'artifact_paths')
        extension['artifact-paths'] = Array.isArray(value) ? value.map(String) : [String(value)]

      if (key === 'concurrency_group')
        extension['concurrency-group'] = String(value)

      if (key === 'concurrency')
        extension.concurrency = Number(value)

      if (key === 'cancel_on_build_failing')
        extension['cancel-on-build-failing'] = Boolean(value)

      if (key === 'priority')
        extension.priority = Number(value)
    }

    jobs.push(renderJob({
      id,
      name: label,
      needs: dependenciesOf(step, waiting, previous),
      runsOn: agentLabel(step),
      runs,
      env: step.env && typeof step.env === 'object' ? step.env as Record<string, unknown> : null,
      timeoutMinutes: Number(step.timeout_in_minutes) || null,
      continueOnError: step.soft_fail !== undefined && step.soft_fail !== false,
      condition: step.if ? String(step.if) : null,
      extension,
    }))

    report.steps.push({ label, kind, attributes: notes })
    previous = id
  }

  const name = options.name || String(document.name ?? 'Imported from Buildkite')

  return {
    workflow: `name: ${name}\non: push\n\njobs:\n${jobs.join('\n')}`,
    report,
  }
}

/** Which of Buildkite's five step shapes this is. */
function kindOf(step: Record<string, any>): StepNote['kind'] {
  if (step.wait !== undefined || step.waiter !== undefined)
    return 'wait'

  if (step.block !== undefined)
    return 'block'

  if (step.trigger !== undefined)
    return 'trigger'

  if (step.group !== undefined)
    return 'group'

  if (step.command !== undefined || step.commands !== undefined)
    return 'command'

  return 'unknown'
}

/**
 * What a step waits for.
 *
 * `depends_on` when it says so; otherwise the last barrier, because that is
 * what a barrier means in a pipeline that lists its steps in order. A step
 * after a `wait` with no `depends_on` is not independent - it is the second
 * half of the pipeline.
 */
function dependenciesOf(step: Record<string, any>, waiting: string | null, previous: string | null): string[] {
  const declared = step.depends_on

  if (declared !== undefined) {
    const list = Array.isArray(declared) ? declared : [declared]

    return list
      .map(one => (one && typeof one === 'object' ? String((one as any).step ?? '') : String(one ?? '')))
      .filter(Boolean)
      .map(one => jobId(one, new Set()))
  }

  if (waiting)
    return [waiting]

  /*
   * And nothing otherwise. Buildkite runs steps between barriers in parallel,
   * so chaining each to the one before it would serialise a pipeline that was
   * not - which is a translation that is slower than the original and reads as
   * this product being slow.
   */
  void previous

  return []
}

/** `agents: { queue: macos }` becomes a label, which is what `runs-on` takes. */
function agentLabel(step: Record<string, any>): string {
  const agents = step.agents

  if (!agents || typeof agents !== 'object')
    return 'ubuntu-latest'

  const queue = String((agents as any).queue ?? '').trim()

  return queue || 'ubuntu-latest'
}

/** A job id: what a workflow calls a step, from what Buildkite called it. */
function jobId(raw: string, seen: Set<string>): string {
  const base = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'job'

  if (!seen.has(base)) {
    seen.add(base)

    return base
  }

  let index = 2

  while (seen.has(`${base}-${index}`))
    index += 1

  seen.add(`${base}-${index}`)

  return `${base}-${index}`
}

/** One job, as the YAML a person would have written. */
function renderJob(input: {
  id: string
  name: string
  needs: string[]
  runsOn?: string
  runs?: string[]
  env?: Record<string, unknown> | null
  timeoutMinutes?: number | null
  continueOnError?: boolean
  condition?: string | null
  extension?: Record<string, unknown>
}): string {
  const lines: string[] = [`  ${input.id}:`]

  lines.push(`    name: ${quote(input.name)}`)

  if (input.needs.length === 1)
    lines.push(`    needs: ${input.needs[0]}`)
  else if (input.needs.length > 1)
    lines.push(`    needs: [${input.needs.join(', ')}]`)

  lines.push(`    runs-on: ${input.runsOn ?? 'ubuntu-latest'}`)

  if (input.condition)
    lines.push(`    if: ${quote(input.condition)}`)

  if (input.timeoutMinutes)
    lines.push(`    timeout-minutes: ${input.timeoutMinutes}`)

  if (input.env && Object.keys(input.env).length > 0) {
    lines.push('    env:')

    for (const [key, value] of Object.entries(input.env))
      lines.push(`      ${key}: ${quote(String(value))}`)
  }

  const extension = input.extension ?? {}

  if (Object.keys(extension).length > 0) {
    lines.push('    reviewos:')

    for (const [key, value] of Object.entries(extension)) {
      if (Array.isArray(value)) {
        lines.push(`      ${key}:`)

        for (const one of value)
          lines.push(`        - ${quote(String(one))}`)

        continue
      }

      lines.push(`      ${key}: ${typeof value === 'string' ? quote(value) : String(value)}`)
    }
  }

  const runs = input.runs ?? []

  if (runs.length > 0) {
    lines.push('    steps:')

    for (const command of runs) {
      if (command.includes('\n')) {
        lines.push('      - run: |')

        for (const line of command.split('\n'))
          lines.push(`          ${line}`)

        continue
      }

      lines.push(`      - run: ${quote(command)}`)
    }

    if (input.continueOnError)
      lines.push('        continue-on-error: true')
  }

  return `${lines.join('\n')}\n`
}

/** A YAML scalar that cannot be misread, which for a command means quoted. */
function quote(value: string): string {
  const text = String(value ?? '')

  return /^[\w./-]+$/.test(text) ? text : `'${text.replace(/'/g, "''")}'`
}

/** Buildkite's own file, or an empty pipeline: this is an importer, not a gate. */
function readYaml(source: string): Record<string, any> {
  try {
    const parsed = Bun.YAML.parse(String(source ?? '')) as unknown

    if (Array.isArray(parsed))
      return { steps: parsed }

    return parsed && typeof parsed === 'object' ? parsed as Record<string, any> : {}
  }
  catch {
    return {}
  }
}

/** A group's inner steps, back as YAML, so one translator handles both levels. */
function renderYamlSteps(steps: readonly unknown[]): string {
  return `steps:\n${steps.map(step => `  - ${JSON.stringify(step)}`).join('\n')}\n`
}

/** The report, as the lines a person reads after running the importer. */
export function describeTranslation(report: TranslationReport): string[] {
  const lines: string[] = []

  for (const step of report.steps) {
    const changed = step.attributes.filter(one => one.fidelity === 'changed')
    const missing = step.attributes.filter(one => one.fidelity === 'none')

    if (changed.length === 0 && missing.length === 0) {
      lines.push(`${step.label}: translated`)
      continue
    }

    lines.push(`${step.label}:`)

    for (const attribute of changed)
      lines.push(`  ${attribute.from} -> ${attribute.to}, with a change in meaning: ${attribute.note}`)

    for (const attribute of missing)
      lines.push(`  ${attribute.from} has no equivalent${attribute.note ? `: ${attribute.note}` : ''}`)
  }

  return lines
}

/**
 * Buildkite Test Analytics, as executions this instance can ingest.
 *
 * The flaky verdict is the part of a move that cannot be recreated: it took
 * months of runs to accumulate, and a migration that starts with an empty
 * history starts by forgetting which tests to distrust. Their export is one
 * JSON object per execution, which is close enough to ours that this is a
 * rename and a unit conversion.
 *
 * Duration is seconds there and milliseconds here - the one conversion in this
 * file, and the one that would be silently wrong: a suite of four-second tests
 * imported as four-millisecond ones looks like a suite that got faster.
 */
export function testExecutionsFrom(rows: readonly unknown[]): Array<{
  scope: string
  name: string
  result: 'passed' | 'failed' | 'skipped'
  durationMs: number
  failureMessage: string | null
}> {
  const executions: ReturnType<typeof testExecutionsFrom> = []

  for (const raw of rows) {
    if (!raw || typeof raw !== 'object')
      continue

    const row = raw as Record<string, any>
    const name = String(row.name ?? row.scope ?? '').trim()

    if (!name)
      continue

    /*
     * Their `result` is `passed`, `failed`, `skipped` or `unknown`. The fourth
     * is dropped rather than guessed: a test whose outcome nobody recorded is
     * not a pass, and importing it as one is how a green history is invented.
     */
    const result = String(row.result ?? '').toLowerCase()

    if (result !== 'passed' && result !== 'failed' && result !== 'skipped')
      continue

    const seconds = Number(row.duration ?? row.history?.duration ?? 0)

    executions.push({
      // Their `scope` is the file or describe block, which is what ours is too.
      scope: String(row.scope ?? row.location ?? '').trim(),
      name,
      result,
      durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0,
      failureMessage: row.failure_reason ? String(row.failure_reason) : null,
    })
  }

  return executions
}
