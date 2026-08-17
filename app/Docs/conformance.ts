/**
 * What this instance does with every key a workflow can contain.
 *
 * The roadmap's own standard, and the reason it exists: *silence about a gap is
 * how Gitea's ignored `concurrency:` surprised people*. A forge that accepts a
 * key and does nothing with it has not implemented it - it has hidden the fact
 * that it has not.
 *
 * So every key has a status and a sentence, and the sentence is the point. Four
 * statuses, and the difference between the last two is the one that matters:
 *
 * - **`supported`** - it does what Actions does.
 * - **`differs`** - it works, and *deliberately not the way Actions does it*.
 *   Every one of these is a decision somebody should be able to disagree with,
 *   so the reason is written next to it.
 * - **`unimplemented`** - it is read and does nothing yet, and a workflow using
 *   it is told rather than left to wonder.
 * - **`refused`** - it will not be implemented in this form, and why.
 *
 * The table is the source of truth for the published page and for the
 * conformance test, so a key that changes behaviour without changing its line
 * here fails a test rather than drifting quietly.
 */

export type ConformanceStatus = 'supported' | 'differs' | 'unimplemented' | 'refused'

export interface ConformanceEntry {
  /** The key, as it is written in a workflow. */
  key: string
  /** Where it appears: `workflow`, `job`, `step`, or `on`. */
  level: 'workflow' | 'job' | 'step' | 'on'
  status: ConformanceStatus
  /** What this instance does. One sentence, in the present tense. */
  behaviour: string
}

/**
 * Every key, and what happens to it.
 *
 * Ordered by level and then by how often people write it, because this is read
 * top to bottom by somebody deciding whether to move a repository here.
 */
export const CONFORMANCE: ConformanceEntry[] = [
  // ---------------------------------------------------------------- triggers
  { key: 'on.push', level: 'on', status: 'supported', behaviour: 'Starts runs, with `branches`, `tags`, `paths` and their `-ignore` forms.' },
  { key: 'on.pull_request', level: 'on', status: 'supported', behaviour: 'Starts runs on opened, synchronize and reopened, with `types`, `branches` and `paths`. The definition comes from the base branch.' },
  { key: 'on.pull_request_target', level: 'on', status: 'supported', behaviour: 'Asked as its own question against the same version, so a workflow naming only `pull_request` is never started as this.' },
  { key: 'on.workflow_dispatch', level: 'on', status: 'supported', behaviour: 'Startable by hand or by API, with inputs of every type checked against what the workflow declared.' },
  { key: 'on.schedule', level: 'on', status: 'supported', behaviour: 'Swept every minute; a workflow never swept before waits for its next occurrence rather than firing immediately.' },
  { key: 'on.issues', level: 'on', status: 'supported', behaviour: 'Starts runs on opened and closed, with `types`.' },
  { key: 'on.issue_comment', level: 'on', status: 'supported', behaviour: 'Starts runs when a comment is created, with `types`.' },
  {
    key: 'on.release',
    level: 'on',
    status: 'differs',
    behaviour: 'Defaults to `published` only, where Actions defaults to every activity type. A draft release starting a deployment is the surprise nobody wants; naming `types` opts back in.',
  },
  { key: 'on.workflow_call', level: 'on', status: 'supported', behaviour: 'Declares inputs, outputs and secrets, and makes the workflow callable by another in the same repository.' },
  { key: 'on.workflow_run', level: 'on', status: 'unimplemented', behaviour: 'Recognised and recorded; no run is started, and the workflow page says so.' },
  { key: 'on.repository_dispatch', level: 'on', status: 'unimplemented', behaviour: 'Recognised and recorded; there is no endpoint to send one yet.' },

  // ---------------------------------------------------------------- workflow
  { key: 'name', level: 'workflow', status: 'supported', behaviour: 'Names the workflow everywhere it appears.' },
  { key: 'env', level: 'workflow', status: 'supported', behaviour: 'Inherited by every job and step, with the narrowest level winning.' },
  { key: 'defaults.run', level: 'workflow', status: 'supported', behaviour: '`shell` and `working-directory` are inherited by steps; nothing declared anywhere leaves the choice to the runner.' },
  { key: 'concurrency', level: 'workflow', status: 'supported', behaviour: 'Groups runs and cancels superseded ones with `cancel-in-progress`. A group whose expression cannot be resolved is no group at all.' },
  {
    key: 'permissions',
    level: 'workflow',
    status: 'differs',
    behaviour: 'Mapped onto this instance\'s token scopes, and the default is read-only rather than depending on an organization setting, so a workflow behaves the same on every instance. `write-all` does not grant administration.',
  },
  { key: 'run-name', level: 'workflow', status: 'unimplemented', behaviour: 'Accepted and not yet used; runs are named for their workflow.' },

  // --------------------------------------------------------------------- job
  { key: 'jobs.<id>.runs-on', level: 'job', status: 'supported', behaviour: 'Matched against a runner\'s labels, as a string, a list, or a `group`/`labels` mapping.' },
  { key: 'jobs.<id>.needs', level: 'job', status: 'supported', behaviour: 'Orders the graph, refuses a cycle by name, and skips a job whose dependency did not succeed rather than leaving it blocked forever.' },
  { key: 'jobs.<id>.if', level: 'job', status: 'supported', behaviour: 'Evaluated when the run is created; a job whose condition is false is `skipped` with the reason recorded.' },
  { key: 'jobs.<id>.strategy.matrix', level: 'job', status: 'supported', behaviour: 'Expanded at parse time, including `include` and `exclude`; each combination is its own job.' },
  { key: 'jobs.<id>.strategy.fail-fast', level: 'job', status: 'unimplemented', behaviour: 'Stored; cancelling the siblings of a failed combination needs the execution plane.' },
  { key: 'jobs.<id>.strategy.max-parallel', level: 'job', status: 'unimplemented', behaviour: 'Stored; nothing limits how many combinations run at once yet.' },
  { key: 'jobs.<id>.env', level: 'job', status: 'supported', behaviour: 'Overrides the workflow\'s for this job\'s steps.' },
  { key: 'jobs.<id>.permissions', level: 'job', status: 'supported', behaviour: 'Replaces the workflow\'s rather than adding to it, which is Actions\' rule.' },
  { key: 'jobs.<id>.concurrency', level: 'job', status: 'supported', behaviour: 'A group of its own, resolved against the run and the matrix combination.' },
  { key: 'jobs.<id>.uses', level: 'job', status: 'differs', behaviour: 'Local reusable workflows are called and their jobs shown in the run. A cross-repository call is refused with a reason rather than half done.' },
  { key: 'jobs.<id>.timeout-minutes', level: 'job', status: 'unimplemented', behaviour: 'Stored; the runner enforces its own two-hour ceiling per step.' },
  { key: 'jobs.<id>.container', level: 'job', status: 'unimplemented', behaviour: 'Parsed and refused at run time: this instance has no container isolation yet, and pretending otherwise would run the steps on the host.' },
  { key: 'jobs.<id>.services', level: 'job', status: 'unimplemented', behaviour: 'Parsed; no service containers are started, and a job that needs one is told rather than failing on a closed port.' },
  { key: 'jobs.<id>.environment', level: 'job', status: 'unimplemented', behaviour: 'Parsed; deployment environments and their protection rules are phase 9 work.' },
  { key: 'jobs.<id>.outputs', level: 'job', status: 'unimplemented', behaviour: 'Parsed; reading one from a dependent job needs the steps to have run.' },

  // -------------------------------------------------------------------- step
  { key: 'steps[*].run', level: 'step', status: 'supported', behaviour: 'Executed by the runner, in the workspace, with the job\'s environment.' },
  { key: 'steps[*].uses', level: 'step', status: 'supported', behaviour: 'Local, composite and JavaScript actions run; remote ones are fetched and cached, under a policy that allows no host by default.' },
  { key: 'steps[*].with', level: 'step', status: 'supported', behaviour: 'Passed to an action as `INPUT_*`, with the action\'s declared defaults filled in.' },
  { key: 'steps[*].env', level: 'step', status: 'supported', behaviour: 'The narrowest environment level, applied over the job\'s and the workflow\'s.' },
  { key: 'steps[*].working-directory', level: 'step', status: 'supported', behaviour: 'Resolved against the workspace.' },
  { key: 'steps[*].continue-on-error', level: 'step', status: 'differs', behaviour: 'Honoured as a literal `true` only. An expression needs the expression engine at step time, and reading it as truthy text would make every such step unfailable.' },
  { key: 'steps[*].shell', level: 'step', status: 'differs', behaviour: 'Recorded and inherited, and the local runner runs `sh` regardless. A runner that only has one shell should say so rather than refuse a file for naming another.' },
  { key: 'steps[*].id', level: 'step', status: 'supported', behaviour: 'Recorded, and used to key a step\'s outputs.' },
  { key: 'steps[*].if', level: 'step', status: 'unimplemented', behaviour: 'Stored as written; step-level conditions need the contexts a step produces, which arrive with step outputs.' },
  { key: 'steps[*].timeout-minutes', level: 'step', status: 'unimplemented', behaviour: 'Parsed; the runner\'s own ceiling applies instead.' },

  // ------------------------------------------------------------- expressions
  { key: '${{ }} operators', level: 'workflow', status: 'supported', behaviour: 'Comparison, `&&`, `||`, `!`, indexing and the star filter, with Actions\' coercion rules copied deliberately.' },
  { key: '${{ }} functions', level: 'workflow', status: 'differs', behaviour: '`contains`, `startsWith`, `endsWith`, `format`, `join`, `toJSON`, `fromJSON` and the status functions all work. `hashFiles` is refused rather than answered: it reads a checked-out tree the control plane does not have, and a wrong hash restores the wrong cache.' },
  { key: 'workflow commands', level: 'step', status: 'supported', behaviour: '`::error::`, `::warning::`, `::notice::`, `::group::`, `::add-mask::` and `::stop-commands::`. An `::error file=…::` becomes an annotation on the diff.' },
  { key: 'GITHUB_ENV, GITHUB_PATH, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY', level: 'step', status: 'supported', behaviour: 'Written per step and applied to the steps after it.' },
  { key: '::set-output::, ::save-state::', level: 'step', status: 'refused', behaviour: 'The deprecated command forms are logged as ordinary text rather than honoured. The file protocol replaced them, and a line that vanished is worse than one that did nothing.' },
]

/** The counts a summary line needs. */
export function conformanceCounts(): Record<ConformanceStatus, number> {
  const counts: Record<ConformanceStatus, number> = {
    supported: 0,
    differs: 0,
    unimplemented: 0,
    refused: 0,
  }

  for (const entry of CONFORMANCE)
    counts[entry.status]++

  return counts
}

const TITLES: Record<ConformanceStatus, string> = {
  supported: 'Supported',
  differs: 'Different on purpose',
  unimplemented: 'Not implemented yet',
  refused: 'Refused',
}

const NOTES: Record<ConformanceStatus, string> = {
  supported: 'These do what Actions does. A workflow using only these keys behaves the same here.',
  differs: 'These work, and deliberately not the way Actions does. Every one is a decision you should be able to disagree with, so the reason is next to it.',
  unimplemented: 'These are read and do nothing yet. A workflow using one is told - on its run, or on the workflow page - rather than left to wonder why nothing happened.',
  refused: 'These will not be implemented in this form.',
}

/**
 * The published page.
 *
 * Generated rather than written, so a key whose behaviour changes without its
 * line changing fails the drift test rather than misleading somebody quietly
 * for a year.
 */
export function renderConformance(at: string): string {
  const counts = conformanceCounts()

  const lines = [
    '# Workflow conformance',
    '',
    'What this instance does with every key a workflow can contain.',
    '',
    'The point of publishing it: **silence about a gap is how a forge surprises people.** A key that',
    'is accepted and does nothing has not been implemented - the fact that it has not has been',
    'hidden. So every key here has a status and a sentence, including the ones that are missing and',
    'the ones that are deliberately different.',
    '',
    `${counts.supported} keys behave as Actions does, ${counts.differs} differ on purpose, `
    + `${counts.unimplemented} ${counts.unimplemented === 1 ? 'is' : 'are'} not implemented yet, `
    + `and ${counts.refused} ${counts.refused === 1 ? 'is' : 'are'} refused.`,
    '',
    `Generated ${at}.`,
    '',
  ]

  for (const status of ['supported', 'differs', 'unimplemented', 'refused'] as ConformanceStatus[]) {
    const entries = CONFORMANCE.filter(entry => entry.status === status)

    if (entries.length === 0)
      continue

    lines.push(`## ${TITLES[status]}`, '', NOTES[status], '', '| Key | Where | What this instance does |', '| --- | --- | --- |')

    for (const entry of entries)
      lines.push(`| \`${entry.key}\` | ${entry.level} | ${entry.behaviour} |`)

    lines.push('')
  }

  return lines.join('\n')
}
