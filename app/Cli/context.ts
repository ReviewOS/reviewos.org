/**
 * Where the CLI is pointed, and what repository it is standing in.
 *
 * Both are read from git rather than asked for. A command run inside a checkout
 * already knows which forge and which repository it is about, and a CLI that
 * makes somebody type `--owner acme --repo api` on every invocation is one they
 * wrap in a shell alias that hard-codes the wrong repository.
 *
 * **This file, and everything under `app/Cli/`, talks to the API over HTTP and
 * to git over its binary. Nothing here imports a model or touches the
 * database.** The CLI is a client of the public API, which is the constraint
 * that keeps parity honest: an endpoint it needs and does not have gets built,
 * rather than reached around.
 */

import process from 'node:process'

export interface Standing {
  /** The instance origin, e.g. `https://reviewos.org`. */
  instance: string
  owner: string
  repository: string
  /** The branch checked out right now, or null in a detached head. */
  branch: string | null
}

/** Run git and return stdout, or null when it failed. */
export async function git(...args: string[]): Promise<string | null> {
  try {
    const child = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'pipe' })
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])

    return code === 0 ? out.trim() : null
  }
  catch {
    return null
  }
}

/**
 * Split a git remote URL into its instance, owner and repository.
 *
 * Handles the three spellings the same remote has - `https://host/o/r.git`,
 * `git@host:o/r.git`, `ssh://git@host/o/r` - because a contributor who cloned
 * over ssh and a contributor who cloned over https are working on the same
 * repository and the CLI must not disagree about that.
 *
 * Exported for its own test: URL parsing is the part of this that is wrong in
 * an edge case somebody will hit, and a test is cheaper than the report.
 */
export function parseRemote(url: string): { instance: string, owner: string, repository: string } | null {
  const trimmed = url.trim().replace(/\.git$/, '')
  if (!trimmed)
    return null

  // scp-like: git@host:owner/repo
  const scp = /^(?:([^@]+)@)?([^:/]+):(.+)$/.exec(trimmed)
  if (scp && !trimmed.includes('://')) {
    const [, , host, path] = scp
    const parts = String(path).split('/').filter(Boolean)

    if (parts.length < 2 || !host)
      return null

    return {
      // https, not the ssh host it was cloned from. The API is served over
      // HTTP; assuming the same host is right, assuming the same scheme is not.
      instance: `https://${host}`,
      owner: String(parts[parts.length - 2]),
      repository: String(parts[parts.length - 1]),
    }
  }

  try {
    const parsed = new URL(trimmed)
    const parts = parsed.pathname.split('/').filter(Boolean)

    if (parts.length < 2)
      return null

    return {
      // A localhost remote keeps its scheme and port: that is a development
      // instance, and rewriting it to https would point the CLI at nothing.
      instance: parsed.protocol === 'http:' ? parsed.origin : `https://${parsed.host}`,
      owner: String(parts[parts.length - 2]),
      repository: String(parts[parts.length - 1]),
    }
  }
  catch {
    return null
  }
}

/**
 * Where this checkout points.
 *
 * `REVIEWOS_URL` overrides the remote's host, for the case the remote is
 * behind a different name from the API - a proxy, a tunnel, a development
 * instance on a port.
 */
export async function standing(
  remoteName: string = 'origin',
  environment: Record<string, string | undefined> = process.env,
): Promise<Standing | null> {
  const remote = await git('remote', 'get-url', remoteName)
  if (!remote)
    return null

  const parsed = parseRemote(remote)
  if (!parsed)
    return null

  const branch = await git('rev-parse', '--abbrev-ref', 'HEAD')

  return {
    instance: String(environment.REVIEWOS_URL ?? '').trim() || parsed.instance,
    owner: parsed.owner,
    repository: parsed.repository,
    // `HEAD` is what `--abbrev-ref` prints in a detached head, and it is not a
    // branch name. Reported as null so a caller says "you are not on a branch"
    // rather than trying to open a pull request from one called HEAD.
    branch: branch && branch !== 'HEAD' ? branch : null,
  }
}
