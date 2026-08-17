/**
 * `uses:` - what a step is asking to run, and whether it may.
 *
 * Four forms, and they are not variations on one idea: a local path is a
 * directory in the tree that was just checked out, a remote reference is
 * somebody else's repository fetched over the network, a container reference is
 * an image pulled from a registry, and a reusable workflow is not an action at
 * all. Reading them apart is the whole of this file, because every decision
 * after it - what to fetch, what to trust, what to refuse - turns on which one
 * it is.
 *
 * **The policy lives here too.** An action is code from somewhere else that a
 * repository's workflow runs on this instance's runners, which makes "where may
 * it come from" a security question rather than a convenience one. The default
 * is the closed one: local actions always, and nothing else unless an operator
 * has said so.
 */

export type ActionKind = 'local' | 'remote' | 'container' | 'unknown'

export interface ActionReference {
  kind: ActionKind
  /** The whole thing, as written. */
  raw: string
  /** For a local action, the path relative to the workspace. */
  path: string | null
  /** For a remote action, the host it comes from. */
  host: string | null
  /** `owner/name`, for a remote action. */
  repository: string | null
  /** A subdirectory inside that repository, when the reference names one. */
  subdirectory: string | null
  /** The tag, branch or commit. Null when the reference gave none. */
  ref: string | null
  /** Whether `ref` is a full commit sha, which is the only pinned form. */
  pinned: boolean
  /** For a container action, the image. */
  image: string | null
}

const SHA = /^[0-9a-f]{40}$/i

/**
 * Read a `uses:` value.
 *
 * Never throws and never guesses: a reference it does not understand is
 * `unknown`, which the runner reports as a skipped step with the text in it.
 * Guessing would mean running something other than what was asked for, and the
 * failure mode of that is not a broken build but the wrong code executing.
 */
export function parseActionRef(uses: string): ActionReference {
  const raw = String(uses ?? '').trim()

  const empty: ActionReference = {
    kind: 'unknown',
    raw,
    path: null,
    host: null,
    repository: null,
    subdirectory: null,
    ref: null,
    pinned: false,
    image: null,
  }

  if (!raw)
    return empty

  if (raw.startsWith('docker://'))
    return { ...empty, kind: 'container', image: raw.slice('docker://'.length) || null }

  /*
   * A local action is a path, and only a path that stays inside the workspace.
   *
   * `../` is refused rather than normalised: a step that reaches out of the
   * checkout is asking for a directory the runner put there, which on a host
   * runner is the rest of the machine.
   */
  if (raw.startsWith('./') || raw.startsWith('.\\')) {
    const path = raw.replace(/^\.[\\/]/, '')

    if (!path || path.split(/[\\/]/).includes('..'))
      return empty

    return { ...empty, kind: 'local', path }
  }

  const [reference, ref] = splitRef(raw)

  // A fully qualified URL, which is how somebody names an action on a host
  // that is not the instance's default.
  const url = /^https?:\/\/([^/]+)\/(.+)$/.exec(reference)

  if (url) {
    const parts = String(url[2]).replace(/\.git$/, '').split('/').filter(Boolean)

    if (parts.length < 2)
      return empty

    return {
      ...empty,
      kind: 'remote',
      host: String(url[1]).toLowerCase(),
      repository: `${parts[0]}/${parts[1]}`,
      subdirectory: parts.length > 2 ? parts.slice(2).join('/') : null,
      ref,
      pinned: ref !== null && SHA.test(ref),
    }
  }

  const parts = reference.split('/').filter(Boolean)

  if (parts.length < 2)
    return empty

  return {
    ...empty,
    kind: 'remote',
    host: null,
    repository: `${parts[0]}/${parts[1]}`,
    subdirectory: parts.length > 2 ? parts.slice(2).join('/') : null,
    ref,
    pinned: ref !== null && SHA.test(ref),
  }
}

/** `owner/name@v4` into its two halves, with no ref allowed to be empty. */
function splitRef(reference: string): [string, string | null] {
  const at = reference.lastIndexOf('@')

  if (at <= 0)
    return [reference, null]

  const ref = reference.slice(at + 1).trim()

  return [reference.slice(0, at), ref || null]
}

export interface ActionPolicy {
  /**
   * Hosts a remote action may come from.
   *
   * Empty means none, which is the default: an instance that has not been told
   * where actions may come from does not fetch code from the internet because a
   * repository asked it to. `*` means any, for an operator who has decided that
   * on purpose.
   */
  allowedHosts: string[]
  /** The host an unqualified `owner/name` means. Null when there is none. */
  defaultHost: string | null
  /**
   * Whether a remote action must be named by commit sha.
   *
   * A tag is a moving target that the person who published it can repoint after
   * a review has read it, which is the supply-chain attack this option exists
   * to close. Off by default because it breaks every workflow copied from
   * GitHub, and on is the right answer for anywhere that matters.
   */
  requirePinnedSha: boolean
  /** Whether container actions may run at all. */
  allowContainers: boolean
}

export interface PolicyDecision {
  allowed: boolean
  /** Why not, in words for the person who wrote the workflow. */
  reason: string
}

/** The closed default: local actions, nothing else. */
export function defaultPolicy(): ActionPolicy {
  return { allowedHosts: [], defaultHost: null, requirePinnedSha: false, allowContainers: false }
}

/**
 * May this reference be used here?
 *
 * A local action is always allowed: it is code from the repository whose
 * workflow is running, which is the same code the steps themselves are. Nothing
 * is gained by asking whether a repository may run its own files.
 */
export function checkPolicy(reference: ActionReference, policy: ActionPolicy): PolicyDecision {
  switch (reference.kind) {
    case 'local':
      return { allowed: true, reason: 'a local action, from the repository that is running' }

    case 'container': {
      if (!policy.allowContainers)
        return { allowed: false, reason: 'container actions are not enabled on this instance' }

      return { allowed: true, reason: 'container actions are enabled' }
    }

    case 'remote': {
      const host = reference.host ?? policy.defaultHost

      if (!host) {
        return {
          allowed: false,
          reason: `\`${reference.raw}\` names no host, and this instance has no default action host configured`,
        }
      }

      const allowed = policy.allowedHosts.some(entry => entry === '*' || entry.toLowerCase() === host)

      if (!allowed) {
        return {
          allowed: false,
          reason: `actions from \`${host}\` are not allowed on this instance`,
        }
      }

      if (!reference.ref)
        return { allowed: false, reason: `\`${reference.raw}\` names no version; add \`@\` and a tag or a commit` }

      if (policy.requirePinnedSha && !reference.pinned) {
        return {
          allowed: false,
          reason: `this instance requires actions to be pinned to a commit sha, and \`${reference.ref}\` is not one`,
        }
      }

      return { allowed: true, reason: `\`${host}\` is an allowed action host` }
    }

    default:
      return { allowed: false, reason: `\`${reference.raw}\` is not a form of \`uses:\` this instance understands` }
  }
}
