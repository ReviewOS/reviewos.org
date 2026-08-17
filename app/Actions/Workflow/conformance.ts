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
 * The table is the source of truth for three things - the published page, the
 * conformance test, and **the warnings the parser puts on a workflow that uses
 * one of these keys**. One table for all three is the point: a difference
 * documented on a page nobody opens is a difference nobody knows about, and a
 * warning that disagrees with the documentation is worse than either alone.
 *
 * It lives here rather than under `app/Docs/` because it is domain data that
 * happens to be published, not documentation that happens to be checked.
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
  { key: 'jobs.<id>.needs', level: 'job', status: 'supported', behaviour: 'Orders the graph, refuses a cycle by name, and skips a job whose dependency did not succeed rather than leaving it blocked forever. A matrix is every combination of it: `needs: build` waits for all of them and is held back by any one that failed.' },
  { key: 'jobs.<id>.if', level: 'job', status: 'supported', behaviour: 'Evaluated when the run is created; a job whose condition is false is `skipped` with the reason recorded.' },
  { key: 'jobs.<id>.strategy.matrix', level: 'job', status: 'supported', behaviour: 'Expanded at parse time, including `include` and `exclude`; each combination is its own job.' },
  { key: 'jobs.<id>.strategy.fail-fast', level: 'job', status: 'supported', behaviour: 'Defaults to true, as it does on Actions: one combination failing cancels the queued siblings and asks the running ones to stop, with the reason on each row. `fail-fast: false` leaves them alone.' },
  { key: 'jobs.<id>.strategy.max-parallel', level: 'job', status: 'differs', behaviour: 'Honoured at claim time by counting the combinations already running, which is a check rather than a lock: two runners polling in the same instant can both take the last slot. Making it exact would mean a lock held across every claim on the instance.' },
  { key: 'jobs.<id>.env', level: 'job', status: 'supported', behaviour: 'Overrides the workflow\'s for this job\'s steps.' },
  { key: 'jobs.<id>.permissions', level: 'job', status: 'supported', behaviour: 'Replaces the workflow\'s rather than adding to it, which is Actions\' rule.' },
  { key: 'jobs.<id>.concurrency', level: 'job', status: 'supported', behaviour: 'A group of its own, resolved against the run and the matrix combination.' },
  { key: 'jobs.<id>.uses', level: 'job', status: 'differs', behaviour: 'Local reusable workflows are called and their jobs shown in the run. A cross-repository call is refused with a reason rather than half done.' },
  { key: 'jobs.<id>.timeout-minutes', level: 'job', status: 'supported', behaviour: 'Enforced twice: the runner stops between steps and says which step it was about to run, and the control plane sweeps a job that overran whether or not its runner is listening. Six hours when the workflow does not say, which is Actions\' default.' },
  { key: 'jobs.<id>.container', level: 'job', status: 'unimplemented', behaviour: 'Parsed and refused at run time: this instance has no container isolation yet, and pretending otherwise would run the steps on the host.' },
  { key: 'jobs.<id>.services', level: 'job', status: 'unimplemented', behaviour: 'Parsed; no service containers are started, and a job that needs one is told rather than failing on a closed port.' },
  { key: 'jobs.<id>.environment', level: 'job', status: 'unimplemented', behaviour: 'Parsed; deployment environments and their protection rules are phase 9 work.' },
  { key: 'jobs.<id>.continue-on-error', level: 'job', status: 'supported', behaviour: 'The job still shows as failed and the run is not failed by it, and the jobs that `needs:` it are told `success` - which is Actions\' rule and the only shape that keeps a flaky suite visible instead of deleted.' },
  { key: 'jobs.<id>.outputs', level: 'job', status: 'supported', behaviour: 'Resolved by the runner once the steps they read have run, stored on the run\'s job, and handed to the jobs that `needs:` it as `needs.<job>.outputs.<name>` alongside `needs.<job>.result`.' },

  // -------------------------------------------------------------------- step
  { key: 'steps[*].run', level: 'step', status: 'supported', behaviour: 'Executed by the runner, in the workspace, with the job\'s environment and with its `${{ }}` expressions filled in first - which is what makes `echo "${{ steps.build.outputs.name }}"` work.' },
  { key: 'steps[*].uses', level: 'step', status: 'supported', behaviour: 'Local, composite and JavaScript actions run; remote ones are fetched and cached, under a policy that allows no host by default.' },
  { key: 'steps[*].with', level: 'step', status: 'supported', behaviour: 'Passed to an action as `INPUT_*`, with the action\'s declared defaults filled in.' },
  { key: 'steps[*].env', level: 'step', status: 'supported', behaviour: 'The narrowest environment level, applied over the job\'s and the workflow\'s.' },
  { key: 'steps[*].working-directory', level: 'step', status: 'supported', behaviour: 'Resolved against the workspace.' },
  { key: 'steps[*].continue-on-error', level: 'step', status: 'differs', behaviour: 'Honoured as a literal `true` only. An expression needs the expression engine at step time, and reading it as truthy text would make every such step unfailable.' },
  { key: 'steps[*].shell', level: 'step', status: 'differs', behaviour: 'Recorded and inherited, and the local runner runs `sh` regardless. A runner that only has one shell should say so rather than refuse a file for naming another.' },
  { key: 'steps[*].id', level: 'step', status: 'supported', behaviour: 'Recorded, and what `steps.<id>.outputs`, `.outcome` and `.conclusion` are keyed on.' },
  { key: 'steps[*].if', level: 'step', status: 'supported', behaviour: 'Evaluated by the runner against what the steps before it produced, so `steps.<id>.outputs`, `job.status`, `needs` and `always()` all work. A condition naming no status function carries the implied `success() &&`, and no condition means `success()` - so a step after a failure is skipped unless it asked not to be. A skipped step says which condition skipped it rather than vanishing.' },
  { key: 'steps[*].timeout-minutes', level: 'step', status: 'unimplemented', behaviour: 'Parsed; the runner\'s own ceiling applies instead.' },

  // ------------------------------------------------------------- expressions
  { key: '${{ }} operators', level: 'workflow', status: 'supported', behaviour: 'Comparison, `&&`, `||`, `!`, indexing and the star filter, with Actions\' coercion rules copied deliberately.' },
  { key: '${{ }} functions', level: 'workflow', status: 'differs', behaviour: '`contains`, `startsWith`, `endsWith`, `format`, `join`, `toJSON`, `fromJSON` and the status functions all work. `hashFiles` is refused rather than answered: it reads a checked-out tree the control plane does not have, and a wrong hash restores the wrong cache.' },
  { key: 'workflow commands', level: 'step', status: 'supported', behaviour: '`::error::`, `::warning::`, `::notice::`, `::group::`, `::add-mask::` and `::stop-commands::`. An `::error file=…::` becomes an annotation on the diff.' },
  { key: 'GITHUB_ENV, GITHUB_PATH, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY', level: 'step', status: 'supported', behaviour: 'Written per step and applied to the steps after it; `GITHUB_OUTPUT` is what fills `steps.<id>.outputs`, and `GITHUB_STEP_SUMMARY` is rendered as markdown on the run and on the pull request\'s checks.' },
  { key: 'default environment variables', level: 'step', status: 'supported', behaviour: 'The set a workflow expects - `GITHUB_REPOSITORY`, `GITHUB_REF`, `GITHUB_REF_NAME`, `GITHUB_HEAD_REF`, `GITHUB_BASE_REF`, `GITHUB_SHA`, `GITHUB_ACTOR`, `GITHUB_WORKFLOW`, `GITHUB_JOB`, `GITHUB_RUN_ID`, `GITHUB_RUN_NUMBER`, `GITHUB_EVENT_NAME`, `GITHUB_EVENT_PATH`, `GITHUB_SERVER_URL`, `GITHUB_API_URL`, `RUNNER_OS` and the rest - each also set as `REVIEWOS_*`. `GITHUB_SERVER_URL` is the address the runner actually reached rather than a configured one, because a URL that does not resolve from a runner is worse than none.' },
  { key: 'GITHUB_EVENT_PATH', level: 'step', status: 'differs', behaviour: 'Written per job and populated. The shapes are this instance\'s webhook payloads rather than GitHub\'s, so one integration sees one set of shapes whether it arrived over a webhook or in a job - the common fields (`ref`, `after`, `repository`, `sender`, `pull_request.base.ref`) line up, and the rest do not. Nothing in it carries a URL.' },
  { key: 'reviewos.wait / block / trigger / group / if-changed / retry', level: 'job', status: 'differs', behaviour: 'This instance\'s own extensions, and the only keys here that are not Actions\': a barrier, a gate a person opens, a job that starts another run, a label that groups jobs on the screen, per-job path gating for a monorepository, and an automatic retry with a required cap. All four live under one `reviewos:` key so there is one thing to delete, and **GitHub refuses a file that uses them** rather than ignoring them - which is the right failure, since a `block:` that GitHub ignored would be a deployment approval that approves itself. Documented in [extensions](./extensions.md).' },
  { key: 'contexts', level: 'workflow', status: 'differs', behaviour: '`github`, `env`, `job`, `steps`, `needs`, `matrix`, `inputs` and `runner` are readable, and `reviewos` is `github` under this forge\'s own name. `secrets`, `vars`, `strategy` and `jobs` are not populated yet, and an expression reading one is left as written rather than becoming an empty string.' },
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


/**
 * The keys in a workflow that behave differently here, or not yet at all.
 *
 * Walked over the raw document rather than the normalized one, because the
 * question is *what the file says* and normalizing has already dropped the
 * keys this instance does not implement - which are exactly the ones worth
 * warning about.
 *
 * Only `differs` and `unimplemented` produce a warning. A `supported` key needs
 * no note, and a `refused` one is not silently different - it is refused where
 * it is used, in the log, with the same sentence.
 */
export function differencesIn(root: unknown): Array<{ key: string, status: ConformanceStatus, behaviour: string }> {
  if (!root || typeof root !== 'object' || Array.isArray(root))
    return []

  const document = root as Record<string, any>
  const found = new Map<string, ConformanceEntry>()

  const note = (key: string): void => {
    const entry = CONFORMANCE.find(row => row.key === key)

    if (entry && (entry.status === 'differs' || entry.status === 'unimplemented'))
      found.set(entry.key, entry)
  }

  // Triggers, in both the mapping and the list form people write.
  const on = document.on

  if (typeof on === 'string')
    note(`on.${on}`)

  if (Array.isArray(on)) {
    for (const name of on)
      note(`on.${String(name)}`)
  }

  if (on && typeof on === 'object' && !Array.isArray(on)) {
    for (const name of Object.keys(on))
      note(`on.${name}`)
  }

  for (const key of ['permissions', 'run-name'])
    if (key in document)
      note(key)

  const jobs = document.jobs && typeof document.jobs === 'object' ? document.jobs : {}

  for (const job of Object.values(jobs as Record<string, any>)) {
    if (!job || typeof job !== 'object')
      continue

    for (const key of ['uses', 'container', 'services', 'environment'])
      if (key in job)
        note(`jobs.<id>.${key}`)

    const strategy = job.strategy && typeof job.strategy === 'object' ? job.strategy : {}

    for (const key of ['max-parallel'])
      if (key in strategy)
        note(`jobs.<id>.strategy.${key}`)

    for (const step of Array.isArray(job.steps) ? job.steps : []) {
      if (!step || typeof step !== 'object')
        continue

      for (const key of ['continue-on-error', 'shell', 'if', 'timeout-minutes'])
        if (key in step)
          note(`steps[*].${key}`)
    }
  }

  /*
   * Sorted by key rather than by discovery order, so two workflows that use the
   * same keys warn in the same order - a diff of a run's warnings should show
   * what changed rather than what moved.
   */
  return [...found.values()]
    .sort((one, two) => one.key.localeCompare(two.key))
    .map(entry => ({ key: entry.key, status: entry.status, behaviour: entry.behaviour }))
}
