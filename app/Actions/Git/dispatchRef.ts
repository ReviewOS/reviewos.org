import { isFullSha, isSafeRef, runGit } from './git'

export type DispatchRef =
  | { ok: true, ref: string, sha: string }
  | { ok: false, status: 404 | 422 | 503, error: string }

/** Resolve a named branch or tag once; never treat a Git expression as a ref. */
export async function resolveDispatchRef(repositoryPath: string, requested: string): Promise<DispatchRef> {
  if (!isSafeRef(requested) || requested.startsWith('refs/') && !/^refs\/(?:heads|tags)\/.+/.test(requested))
    return { ok: false, status: 422, error: 'Choose a branch or tag name, not a Git revision expression.' }

  const candidates = requested.startsWith('refs/') ? [requested] : [`refs/heads/${requested}`, `refs/tags/${requested}`]
  const found: Array<{ ref: string, sha: string }> = []

  for (const ref of candidates) {
    // rev-parse alone uses DWIM lookup even for some fully qualified names.
    // Verify the exact ref, then peel its captured object id rather than its name.
    const options = { timeoutMs: 10_000, maxBytes: 1024 }
    const exists = await runGit(repositoryPath, ['show-ref', '--verify', '--quiet', '--', ref], options)
    if (!exists.ok) {
      if (exists.code === 1)
        continue
      return { ok: false, status: 503, error: 'The repository reference is temporarily unavailable.' }
    }
    const object = await runGit(repositoryPath, ['show-ref', '--verify', '--hash', '--', ref], options)
    const oid = object.stdout.trim()
    if (!object.ok || object.truncated || !isFullSha(oid))
      return { ok: false, status: 503, error: 'The repository did not return one complete object.' }
    const result = await runGit(repositoryPath, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${oid}^{commit}`], options)
    const sha = result.stdout.trim()
    if (!result.ok || result.truncated || !isFullSha(sha))
      return { ok: false, status: 503, error: 'The repository did not return one complete commit.' }
    found.push({ ref, sha })
  }

  if (!found.length)
    return { ok: false, status: 404, error: 'No such branch or tag in this repository.' }
  if (found.length !== 1)
    return { ok: false, status: 422, error: 'This name is both a branch and a tag. Use refs/heads/ or refs/tags/ explicitly.' }
  return { ok: true, ...found[0]! }
}
