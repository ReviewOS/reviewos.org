/**
 * Where mirrored actions live, and which requests may reach them.
 *
 * `storage/actions/{host}/{owner}/{name}.git`, kept apart from
 * `storage/repos/` on purpose: a mirrored action is not a repository somebody
 * owns here. It has no issues, no pull requests, no collaborators and no
 * settings page, and putting it in the repository table would mean every
 * listing, permission check and quota in the product growing a "but not those
 * ones" clause.
 *
 * The path is built from three untrusted strings, so this file is mostly about
 * refusing the ones that are not what they claim to be.
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'

/**
 * Where the store is rooted.
 *
 * `storage/actions` unless an operator says otherwise, because the mirrors of a
 * busy instance are the one part of `storage/` that grows without anybody
 * adding anything - and putting them on a different disk should not need a
 * patch.
 *
 * **Read when it is used, not when this module loads.** A constant evaluated at
 * import time is decided by whichever file imported this one first, which is
 * unknowable from here and wrong the moment anything sets the variable later -
 * a test, a worker with its own configuration, a reload.
 */
export function actionStore(): string {
  return process.env.REVIEWOS_ACTION_STORE || 'storage/actions'
}

export interface StorePath {
  ok: boolean
  /** The absolute path to the bare repository. */
  path: string | null
  /** The path relative to the store, for logging and for the interface. */
  relative: string | null
  reason: string
}

/**
 * A host name that is a host name.
 *
 * Letters, digits, dots, dashes and an optional port. Not because a stricter
 * grammar is impossible, but because everything else - a slash, a colon, a
 * percent-encoded anything - is a path traversal wearing a hostname's clothes.
 */
const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i

/** One path segment: no dots that mean "up", no separators, nothing empty. */
const SEGMENT = /^[a-z0-9]([\w.-]*[a-z0-9])?$/i

/**
 * The bare repository for one action, or the reason there is not one.
 *
 * Every rejection here is a request that could not have come from a workflow
 * this instance parsed - the reference parser has already refused anything with
 * a `..` in it - which means anything reaching this check came from somewhere
 * else, and that is exactly when a path check earns its place.
 */
export function actionPath(host: string, repository: string, root?: string): StorePath {
  const cleanHost = String(host ?? '').trim().toLowerCase()

  if (!HOST.test(cleanHost))
    return { ok: false, path: null, relative: null, reason: `\`${host}\` is not a host name` }

  const raw = String(repository ?? '').trim()

  /*
   * `owner/name`, and nothing that only looks like it after tidying.
   *
   * `/etc/passwd` would survive a split-and-filter as owner `etc`, name
   * `passwd`, land inside the store, and be perfectly harmless - and that is
   * exactly why it is refused rather than accepted. A caller passing an
   * absolute path is confused about what this function takes, and answering
   * "fine, I read it as something else" hides the confusion until it matters.
   */
  if (raw.startsWith('/') || raw.endsWith('/') || raw.includes('//'))
    return { ok: false, path: null, relative: null, reason: `\`${repository}\` is not \`owner/name\`` }

  const parts = raw.split('/')

  if (parts.length !== 2)
    return { ok: false, path: null, relative: null, reason: `\`${repository}\` is not \`owner/name\`` }

  for (const part of parts) {
    if (!SEGMENT.test(part) || part === '.' || part === '..')
      return { ok: false, path: null, relative: null, reason: `\`${part}\` is not a name` }
  }

  const relative = join(cleanHost, parts[0]!, `${parts[1]}.git`)
  const base = resolve(root ?? actionStore())
  const path = resolve(base, relative)

  /*
   * The belt to the braces above.
   *
   * Two independent checks on one decision is usually a smell; here it is the
   * point. The grammar could be loosened one day by somebody who has not
   * thought about traversal, and this line does not care what the grammar
   * allows - it only cares that the answer is inside the store.
   */
  if (!path.startsWith(`${base}/`))
    return { ok: false, path: null, relative: null, reason: 'that path is not inside the action store' }

  return { ok: true, path, relative, reason: 'inside the store' }
}

/** Whether this action has been mirrored yet. */
export function isMirrored(host: string, repository: string, root?: string): boolean {
  const resolved = actionPath(host, repository, root)

  return resolved.ok && existsSync(join(String(resolved.path), 'HEAD'))
}

/**
 * Read a request path back into a host and a repository.
 *
 * `/actions/github.com/actions/checkout.git/info/refs` is the shape a runner's
 * git asks for when the origins map points at this instance, and the rest of
 * the path is the git service being requested.
 */
export function parseActionUrl(pathname: string): { host: string, repository: string, rest: string } | null {
  const trimmed = String(pathname ?? '').replace(/^\/+/, '')

  if (!trimmed.startsWith('actions/'))
    return null

  const parts = trimmed.slice('actions/'.length).split('/')

  if (parts.length < 3)
    return null

  const [host, owner, rawName, ...rest] = parts

  if (!host || !owner || !rawName)
    return null

  return {
    host,
    repository: `${owner}/${rawName.replace(/\.git$/, '')}`,
    rest: rest.join('/'),
  }
}
