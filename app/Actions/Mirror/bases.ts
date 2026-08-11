/**
 * The base commit a mirrored pull request can actually be diffed against.
 *
 * Upstream tells us `base.sha`, and it is the wrong commit to store. It is the
 * base branch's tip at the moment the pull request was opened, and a mirror
 * never fetches that: the proposal arrives under `refs/pull/<n>/head` and
 * nothing brings the historical base along with it. Stored unchanged it gives
 * a row that looks complete and a diff that dies -
 * `fatal: Invalid symmetric difference expression` - which reads as a broken
 * page rather than as a missing object.
 *
 * So the recorded base is one this repository has: upstream's when the object
 * is present, and the local tip of the base branch when it is not. The diff is
 * a three-dot one and computes the merge base itself, so against the branch
 * tip it lands on the same commit a reader sees upstream.
 *
 * Both lookups are batched. A repository with two thousand pull requests would
 * otherwise pay two thousand `cat-file` processes to answer a question git can
 * answer for all of them at once, and an import that takes a minute per sweep
 * is an import nobody leaves switched on.
 */

import type { MappedPull } from './github'
import { isSafeRevision, runGit } from '../Git/git'

/** A full 40-character object name, which is what upstream sends. */
function isObjectName(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value)
}

/**
 * Which of these object names the repository actually holds.
 *
 * One `cat-file --batch-check` for the whole set. Missing objects are reported
 * on stdout as `<name> missing`, so a failure to find one is a line rather
 * than a non-zero exit, and the command succeeds either way.
 */
export async function presentObjects(
  diskPath: string,
  names: readonly string[],
): Promise<Set<string>> {
  const wanted = [...new Set(names.filter(isObjectName))]
  if (wanted.length === 0)
    return new Set()

  const result = await runGit(diskPath, ['cat-file', '--batch-check'], {
    input: `${wanted.join('\n')}\n`,
    timeoutMs: 60_000,
  })

  if (!result.ok)
    return new Set()

  const present = new Set<string>()

  for (const line of result.stdout.split('\n')) {
    const [name, type] = line.trim().split(/\s+/)
    if (name && type === 'commit')
      present.add(name.toLowerCase())
  }

  return present
}

/**
 * The local tip of each named branch, for the ones that resolve.
 *
 * `for-each-ref` rather than `rev-parse`, because the interesting case is a
 * branch that is not there: `rev-parse` fails the whole call on the first
 * missing ref, so one deleted base branch would cost every other answer in
 * the batch. `for-each-ref` treats its arguments as patterns and simply does
 * not list what does not exist, which is the same question asked in a way
 * that survives the answer being no.
 */
export async function branchTips(
  diskPath: string,
  branches: readonly string[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(branches.filter(name => name && isSafeRevision(name)))]
  const tips = new Map<string, string>()
  if (wanted.length === 0)
    return tips

  const result = await runGit(diskPath, [
    'for-each-ref',
    '--format=%(refname:short) %(objectname)',
    ...wanted.map(name => `refs/heads/${name}`),
  ], { timeoutMs: 30_000 })

  if (!result.ok)
    return tips

  for (const line of result.stdout.split('\n')) {
    const [name, sha] = line.trim().split(/\s+/)
    if (name && isObjectName(sha))
      tips.set(name, sha.toLowerCase())
  }

  return tips
}

/**
 * The base sha to store per pull request number.
 *
 * Null when neither upstream's commit nor the base branch resolves here, which
 * is honest: the alternative is a row pointing at something the repository
 * cannot show, and a page that fails at read time instead of importing a gap.
 */
export async function resolveBaseShas(
  diskPath: string,
  pulls: readonly MappedPull[],
): Promise<Map<number, string | null>> {
  const resolved = new Map<number, string | null>()
  if (pulls.length === 0)
    return resolved

  const present = await presentObjects(diskPath, pulls.map(pull => pull.baseSha ?? ''))

  const needBranch = pulls.filter(pull =>
    !(isObjectName(pull.baseSha) && present.has(pull.baseSha.toLowerCase())))

  const tips = await branchTips(diskPath, needBranch.map(pull => pull.baseRef ?? ''))

  for (const pull of pulls) {
    if (isObjectName(pull.baseSha) && present.has(pull.baseSha.toLowerCase())) {
      resolved.set(pull.number, pull.baseSha.toLowerCase())
      continue
    }

    resolved.set(pull.number, tips.get(String(pull.baseRef ?? '')) ?? null)
  }

  return resolved
}
