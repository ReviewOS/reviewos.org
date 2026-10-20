import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { initBare } from '../../app/Actions/Git/git'
import { repositoryPath } from '../../app/Actions/Git/storage'
import { createCommit } from '../../app/Actions/Git/write'

/** A real named ref for HTTP dispatch fixtures; database metadata is not a Git ref. */
export async function workflowRepository(owner: string, name: string, files: Record<string, string> = { 'README.md': 'Workflow fixture\n' }): Promise<{ path: string, sha: string }> {
  const resolved = repositoryPath(owner, name)
  assert(resolved.ok && resolved.path)
  mkdirSync(resolved.path, { recursive: true })
  assert((await initBare(resolved.path)).ok)
  const commit = await createCommit(resolved.path, { branch: 'main', parentSha: null, expectedBranchSha: null, message: 'Initial fixture', author: { name: 'Workflow fixture', email: 'workflow@example.test' }, files })
  assert(commit.ok)
  return { path: resolved.path, sha: commit.sha }
}
