/**
 * Handles.
 *
 * A handle is the URL segment for a user or an organization, so the two share
 * one namespace: `/chris` and `/reviewos` cannot both be taken by different
 * kinds of owner. Every path that creates or renames one comes through here, so
 * the rules live in exactly one place.
 *
 * The reserved list is the other half of that: a handle that collides with a
 * top-level route would make the route or the profile unreachable, and which
 * one wins depends on registration order, which is not a thing to leave to
 * chance.
 */

/** Top-level paths that are not owner profiles. */
export const RESERVED_HANDLES = new Set([
  'about',
  'admin',
  'api',
  'assets',
  'blog',
  'contact',
  'dashboard',
  'docs',
  'explore',
  'favicon.ico',
  // The git wire protocol's mount. See `GIT_MOUNT` in
  // `app/Actions/Git/storage.ts`: `/git/{owner}/{repository}.git` is how a
  // clone reaches the API process through the page server, and an owner called
  // `git` would make the two indistinguishable.
  'git',
  'help',
  'issues',
  'login',
  'logout',
  'new',
  'notifications',
  'organizations',
  'pricing',
  'privacy',
  'pulls',
  'register',
  'robots.txt',
  'search',
  'security',
  'settings',
  'sitemap.xml',
  'static',
  'status',
  'support',
  'terms',
  'user',
  'users',
])

export type HandleRejection =
  | 'empty'
  | 'too-long'
  | 'invalid-characters'
  | 'leading-or-trailing-hyphen'
  | 'consecutive-hyphens'
  | 'reserved'

export interface HandleCheck {
  ok: boolean
  reason?: HandleRejection
  message?: string
}

const MAX_HANDLE_LENGTH = 39

const MESSAGES: Record<HandleRejection, string> = {
  'empty': 'A handle is required.',
  'too-long': `A handle can be at most ${MAX_HANDLE_LENGTH} characters.`,
  'invalid-characters': 'A handle can contain only letters, numbers, and hyphens.',
  'leading-or-trailing-hyphen': 'A handle cannot start or end with a hyphen.',
  'consecutive-hyphens': 'A handle cannot contain two hyphens in a row.',
  'reserved': 'That handle is reserved.',
}

/**
 * Whether a handle is well formed and not reserved.
 *
 * Says nothing about whether it is taken: that needs the database, and keeping
 * this pure is what makes the rules testable without one.
 */
export function checkHandle(raw: string): HandleCheck {
  const handle = raw.trim().toLowerCase()

  if (handle.length === 0)
    return reject('empty')

  if (handle.length > MAX_HANDLE_LENGTH)
    return reject('too-long')

  if (!/^[a-z0-9-]+$/.test(handle))
    return reject('invalid-characters')

  if (handle.startsWith('-') || handle.endsWith('-'))
    return reject('leading-or-trailing-hyphen')

  // Two hyphens in a row make near-identical handles easy to confuse, which is
  // the whole attack in an impersonation attempt.
  if (handle.includes('--'))
    return reject('consecutive-hyphens')

  if (RESERVED_HANDLES.has(handle))
    return reject('reserved')

  return { ok: true }
}

function reject(reason: HandleRejection): HandleCheck {
  return { ok: false, reason, message: MESSAGES[reason] }
}

/** The stored form of a handle. Comparisons and uniqueness use this. */
export function normalizeHandle(raw: string): string {
  return raw.trim().toLowerCase()
}
