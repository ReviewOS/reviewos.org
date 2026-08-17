/**
 * Three of Buildkite's step attributes, decided where each one belongs.
 *
 * `skip` and `branches` decide **at dispatch**, because they are statements
 * about whether a job should exist in this run at all - and a job that will
 * never run should be visible as skipped from the first second, not sit in the
 * queue looking like work nobody has got to.
 *
 * `soft-fail` decides **at the report**, because it is a statement about a
 * failure that has already happened, and the exit status it keys on does not
 * exist until then.
 *
 * All three are pure here, and that is the point: each is a rule somebody will
 * read back off the run screen and check against the file, so it has to be a
 * rule rather than a behaviour spread across three writes.
 */

export interface AttributeDecision {
  run: boolean
  /** Why not, in the words the run screen shows beside the job. */
  reason: string
}

/**
 * `skip:` - the workflow turned this job off.
 *
 * Nothing to decide, and that is why it is here rather than inline: a skip with
 * a reason is a job somebody can make a decision about three weeks later, and
 * one without is a commented-out block nobody reads. The reason travels to the
 * run.
 */
export function skipDecision(skip: string | null): AttributeDecision {
  return skip ? { run: false, reason: skip } : { run: true, reason: '' }
}

/**
 * `branches:` - which branches this job runs on.
 *
 * Buildkite's shape, `!` to exclude, `*` to glob. It exists because
 * `if: github.ref == 'refs/heads/main'` is the expression everybody writes and
 * a good share get wrong: `refs/heads/` is easy to forget, and the failure is
 * silent - a condition nobody matches is a job that simply never runs, with no
 * error anywhere.
 *
 * **An exclusion beats an inclusion**, which is the rule people expect from
 * every other tool that has both, and the safer direction: a list that says
 * `['*', '!release/*']` means "not release", and reading it the other way would
 * run a deploy on exactly the branch it was told to avoid.
 */
export function branchDecision(patterns: readonly string[], ref: string): AttributeDecision {
  if (patterns.length === 0)
    return { run: true, reason: '' }

  const branch = ref.startsWith('refs/heads/')
    ? ref.slice('refs/heads/'.length)
    : ref.startsWith('refs/tags/') ? ref.slice('refs/tags/'.length) : ref

  const excluded = patterns.filter(one => one.startsWith('!')).map(one => one.slice(1))
  const included = patterns.filter(one => !one.startsWith('!'))

  if (excluded.some(pattern => branchMatches(pattern, branch))) {
    return {
      run: false,
      // Named, because "this job did not run" without a reason on a branch
      // somebody is actively working on reads as a broken pipeline.
      reason: `\`${branch}\` is excluded by \`${patterns.join(', ')}\`.`,
    }
  }

  /*
   * A list of exclusions only means "everywhere except these", which is what
   * `branches: ['!wip/*']` plainly says and what somebody writing it means.
   */
  if (included.length === 0)
    return { run: true, reason: '' }

  return included.some(pattern => branchMatches(pattern, branch))
    ? { run: true, reason: '' }
    : { run: false, reason: `\`${branch}\` is not in \`${included.join(', ')}\`.` }
}

/** `main`, `release/*`, `*`. Deliberately not a regular expression. */
export function branchMatches(pattern: string, branch: string): boolean {
  const clean = String(pattern ?? '').trim()

  if (!clean)
    return false

  if (clean === '*')
    return true

  if (!clean.includes('*'))
    return clean === branch

  const escaped = clean.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')

  return new RegExp(`^${escaped}$`).test(branch)
}

export interface SoftFailOutcome {
  /** Whether the run still counts this as a failure. */
  tolerated: boolean
  /** What the job's state should read, so a screen can say *tolerated* rather than *passed*. */
  reason: string
}

/**
 * `soft-fail:` - a failure reported without failing the run.
 *
 * `true` tolerates any failure; a list of exit statuses tolerates the ones
 * worth tolerating. The list is what earns the attribute its place: a linter
 * exiting 1 on findings is a soft failure, and the same linter exiting 127
 * because it is not installed is a broken pipeline wearing a green tick.
 *
 * **An unknown status is not tolerated**, the same rule the retry attribute
 * follows: tolerating "we do not know why it failed" is how a narrow allowance
 * becomes a blanket one, and the blanket version is `continue-on-error`, which
 * a workflow can already ask for by name.
 */
export function softFailOutcome(
  soft: { any: boolean, statuses: number[] } | null,
  exitStatus: number | null,
): SoftFailOutcome {
  if (!soft)
    return { tolerated: false, reason: '' }

  if (soft.any)
    return { tolerated: true, reason: 'Failed, and the workflow tolerates any failure here.' }

  if (exitStatus === null) {
    return {
      tolerated: false,
      // Said rather than silently refused: a job that failed for a reason with
      // no exit status - a lost runner, a timeout - is exactly the failure a
      // status list was not written for.
      reason: `Failed without an exit status, and \`soft-fail\` names ${soft.statuses.join(', ')}.`,
    }
  }

  return soft.statuses.includes(exitStatus)
    ? { tolerated: true, reason: `Exited ${exitStatus}, which \`soft-fail\` tolerates.` }
    : { tolerated: false, reason: `Exited ${exitStatus}, which \`soft-fail\` does not name.` }
}
