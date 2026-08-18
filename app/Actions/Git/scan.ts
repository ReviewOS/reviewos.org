/**
 * Running the secret detectors over what a push is actually carrying.
 *
 * `./secrets.ts` decides what a credential looks like, on a string. This gets
 * the strings out of git, and the whole difficulty is in one word: quarantine.
 *
 * ## The pushed objects do not exist yet
 *
 * While `pre-receive` runs, git has written the incoming objects into a
 * temporary directory and has *not* linked them into the repository. It tells
 * the hook where they are through the environment:
 *
 *     GIT_QUARANTINE_PATH=…/objects/tmp_objdir-incoming-8kyWBa
 *     GIT_OBJECT_DIRECTORY=…/objects/tmp_objdir-incoming-8kyWBa
 *     GIT_ALTERNATE_OBJECT_DIRECTORIES=…/objects
 *
 * and that environment belongs to the hook process alone. This application is a
 * different process, so without those variables `git cat-file` on the pushed
 * commit answers `could not get object info` - and a scanner built on that
 * would find nothing, report every push clean, and look like it was working.
 *
 * So the hook forwards them and every git invocation here takes them back. When
 * they are absent - scanning history rather than a push - the same code reads
 * the ordinary object store, which is exactly what it should do.
 */

import type { Finding, SecretPattern } from './secrets'
import { isFullSha, runGit } from './git'
import { ZERO_SHA } from './push'
import { scanDiff } from './secrets'

/** The object directories a push lives in before it is accepted. */
export interface QuarantineEnv {
  GIT_OBJECT_DIRECTORY?: string
  GIT_ALTERNATE_OBJECT_DIRECTORIES?: string
}

/**
 * Keep only the two variables that matter, and only when they look like paths.
 *
 * They arrive over HTTP from the hook, which means they arrive from whatever
 * can reach the endpoint. Handing an arbitrary string to git as an object
 * directory is handing it a filesystem read, so anything that is not an
 * absolute path inside the repository root is dropped - and dropping them is
 * safe, because the worst case is a scan that reads the ordinary object store
 * and finds nothing to complain about.
 */
export function safeQuarantine(raw: unknown, repositoryPath: string): QuarantineEnv {
  const env: QuarantineEnv = {}
  if (!raw || typeof raw !== 'object')
    return env

  const root = repositoryPath.replace(/\/+$/, '')
  const acceptable = (value: unknown): value is string =>
    typeof value === 'string'
    && value.startsWith('/')
    && !value.includes('\0')
    // Every quarantine directory git creates is inside the repository it is
    // for. A path outside it did not come from git.
    && value.split(':').every(part => part.startsWith(root))

  const offered = raw as Record<string, unknown>
  if (acceptable(offered.GIT_OBJECT_DIRECTORY))
    env.GIT_OBJECT_DIRECTORY = offered.GIT_OBJECT_DIRECTORY

  if (acceptable(offered.GIT_ALTERNATE_OBJECT_DIRECTORIES))
    env.GIT_ALTERNATE_OBJECT_DIRECTORIES = offered.GIT_ALTERNATE_OBJECT_DIRECTORIES

  return env
}

/** How many commits of one push are read. Past this it is an import, not a change. */
export const SCAN_COMMIT_LIMIT = 100

/**
 * How much patch text is read per push.
 *
 * A push that adds a vendored dependency is megabytes of diff, and running
 * eighteen patterns over all of it while somebody waits at a prompt is how
 * push protection becomes the reason people stop pushing. Past this the scan
 * reports what it found so far and says it was truncated, which is honest - and
 * the pushes it truncates are the ones least likely to be a credential typed
 * into a config file.
 */
export const SCAN_BYTE_LIMIT = 4 * 1024 * 1024

export interface ScanResult {
  findings: Finding[]
  /** True when the byte or commit limit stopped the scan short. */
  truncated: boolean
}

/**
 * Scan the commits a ref update introduces.
 *
 * `--first-parent` is deliberately *not* used: a merge brings somebody else's
 * commits into this branch, and if one of them carries a credential it is
 * landing here whether it was written here or not.
 *
 * The range for a created branch excludes everything the other refs already
 * reach, for the same reason `ProcessPushJob` does it - the first push of a
 * fork should not re-scan the entire history of the project it forked.
 */
export async function scanUpdate(
  repositoryPath: string,
  before: string,
  after: string,
  options: { quarantine?: QuarantineEnv, extra?: readonly SecretPattern[], excludeRefs?: readonly string[] } = {},
): Promise<ScanResult> {
  if (!isFullSha(after))
    return { findings: [], truncated: false }

  const args = [
    'log',
    `--max-count=${SCAN_COMMIT_LIMIT}`,
    '--patch',
    // No colour, no renames, no context: the added lines are all that is read,
    // and context lines are patch text nobody scans.
    '--no-color',
    '--no-renames',
    '--unified=0',
    // A binary file has no lines to scan and its patch is noise.
    '--no-textconv',
  ]

  let input: string | undefined

  // The zero sha is forty hex characters, so it passes `isFullSha` - and a
  // created branch arrives with exactly that as its `before`. Ranging from it
  // asks git for `000…000..<new>`, which resolves to nothing at all: every
  // newly created branch was scanned as empty and reported clean, which is the
  // one case somebody pushing a secret is most likely to be in.
  if (isFullSha(before) && before !== ZERO_SHA) {
    args.push(`${before}..${after}`)
  }
  else {
    args.push('--stdin')
    input = [after, ...(options.excludeRefs ?? []).map(ref => `^${ref}`)].join('\n')
  }

  // The byte limit rides `maxBytes`, so git is killed at the boundary rather
  // than allowed to print an unbounded patch that gets sliced afterwards -
  // this runs on the push path, where the whole point is that the allocation
  // never happens while somebody waits at a prompt.
  const result = await runGit(repositoryPath, args, {
    timeoutMs: 20_000,
    input,
    maxBytes: SCAN_BYTE_LIMIT,
    env: options.quarantine as Record<string, string> | undefined,
  })

  if (!result.ok)
    return { findings: [], truncated: false }

  return { findings: scanDiff(result.stdout, options.extra), truncated: result.truncated === true }
}

/**
 * Every ref except the ones being pushed, to bound a newly created branch.
 *
 * Takes the refs under update rather than one, because a push that creates
 * three branches at once would otherwise have each of them bounded by the other
 * two and report almost nothing.
 */
export async function refsToExclude(
  repositoryPath: string,
  updating: readonly string[],
  quarantine?: QuarantineEnv,
): Promise<string[]> {
  const result = await runGit(repositoryPath, ['for-each-ref', '--format=%(refname)'], {
    env: quarantine as Record<string, string> | undefined,
  })

  if (!result.ok)
    return []

  const excluded = new Set(updating)

  return result.stdout
    .split('\n')
    .map(line => line.trim())
    .filter(ref => ref.length > 0 && !excluded.has(ref))
}

/**
 * One line per finding, as git will print it.
 *
 * Grouped by file and capped, because a `.env` committed by accident produces
 * one finding per line and a wall of forty is a wall nobody reads to the end
 * of - and the pusher only needs enough to know what to do, which is the same
 * thing in every case: take the file out of the commit.
 */
export const REPORT_LIMIT = 10

export function reportLines(findings: readonly Finding[], truncated = false): string[] {
  const lines: string[] = []

  for (const finding of findings.slice(0, REPORT_LIMIT)) {
    const where = finding.path ? `${finding.path}:${finding.line}` : `line ${finding.line}`
    lines.push(`  ${where}  looks like ${finding.name} (${finding.excerpt})`)
  }

  if (findings.length > REPORT_LIMIT)
    lines.push(`  ...and ${findings.length - REPORT_LIMIT} more`)

  if (truncated)
    lines.push('  (the push was too large to scan completely)')

  return lines
}
