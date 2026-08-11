/**
 * Find the workflow files in a commit.
 *
 * `.github/workflows/*.yml`, read out of the bare repository with plumbing, the
 * way everything else in this codebase reads a tree. Nothing is checked out and
 * nothing is executed - these are bytes on their way to a parser that also does
 * not execute them.
 *
 * **Read from the trusted ref, always.** The caller passes the sha, and for a
 * pull request from a fork that has to be the base branch's rather than the
 * fork's. That is the fork rule from [the threat
 * model](../../../docs/ci-threat-model.md), and it is stated here as well as
 * there because this is the function somebody would otherwise hand a fork's
 * head to without noticing what it means.
 */

import { isSafeRevision, runGit } from '../Git/git'

/** Where Actions keeps them, and where a repository being imported will have them. */
export const WORKFLOW_DIRECTORY = '.github/workflows'

export interface DiscoveredWorkflow {
  path: string
  source: string
}

/**
 * A ceiling on how many files are read from one commit.
 *
 * A repository can contain a thousand workflow files, and reading all of them
 * on every push is a cost the pusher pays. The limit is high enough that no
 * honest repository meets it and low enough that a hostile one cannot use it as
 * an amplifier.
 */
export const MAX_WORKFLOW_FILES = 100

/** Bigger than any workflow anybody writes, small enough not to matter. */
export const MAX_WORKFLOW_BYTES = 512 * 1024

/** `.yml` and `.yaml`, which Actions treats alike and repositories mix freely. */
function isWorkflowFile(name: string): boolean {
  return /\.ya?ml$/i.test(name)
}

/**
 * The workflow files present at a commit.
 *
 * An empty list is the ordinary answer - most repositories have no workflows -
 * so a missing directory is not an error and is not logged as one.
 */
export async function discoverWorkflows(
  gitDir: string,
  sha: string,
): Promise<DiscoveredWorkflow[]> {
  if (!isSafeRevision(sha))
    return []

  const listing = await runGit(gitDir, [
    'ls-tree',
    '--name-only',
    '-z',
    `${sha}:${WORKFLOW_DIRECTORY}`,
  ], { timeoutMs: 30_000 })

  // No `.github/workflows` in this commit, which is most repositories.
  if (!listing.ok)
    return []

  const names = listing.stdout
    .split('\0')
    .map(name => name.trim())
    .filter(name => name.length > 0 && isWorkflowFile(name))
    .slice(0, MAX_WORKFLOW_FILES)

  const found: DiscoveredWorkflow[] = []

  for (const name of names) {
    const path = `${WORKFLOW_DIRECTORY}/${name}`

    const file = await runGit(gitDir, ['show', `${sha}:${path}`], { timeoutMs: 30_000 })
    if (!file.ok)
      continue

    // Truncating would hand the parser a document that ends mid-mapping and
    // produce an error about YAML rather than about size, which is a worse
    // thing to tell somebody than nothing.
    if (file.stdout.length > MAX_WORKFLOW_BYTES)
      continue

    found.push({ path, source: file.stdout })
  }

  return found
}
