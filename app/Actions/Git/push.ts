/**
 * What a push is, as data.
 *
 * git hands a `post-receive` hook one line per ref on stdin:
 *
 *     <old-sha> <new-sha> <refname>
 *
 * and that is the whole vocabulary. Everything the application wants to know -
 * which branch moved, whether it was created or deleted, whether the default
 * branch is now somewhere else - is derived from those three fields, so the
 * deriving is here, pure, and the job below it does database work against
 * answers it did not have to work out itself.
 *
 * Nothing in this file runs git. Whether a push was a *force* push is the one
 * question that cannot be answered from the line alone - it needs to know
 * whether the old commit is still reachable from the new one - so it is asked
 * of git in `ProcessPushJob` and passed back in.
 */

/** git's "this ref does not exist" sha, on both sides of a create and a delete. */
export const ZERO_SHA = '0'.repeat(40)

export type RefKind = 'branch' | 'tag' | 'other'
export type RefChange = 'created' | 'deleted' | 'updated'

export interface RefUpdate {
  before: string
  after: string
  ref: string
  kind: RefKind
  change: RefChange
  /** The branch or tag name, without its `refs/heads/` or `refs/tags/` prefix. */
  name: string
}

/**
 * Whether a string is a sha git would have written.
 *
 * The hook's input arrives over HTTP from a process this application started,
 * which is not the same as arriving from a process it can vouch for: the hook
 * posts to a URL, and a URL can be posted to by anything that learns the
 * secret. So the shape is checked rather than assumed, and a line that does not
 * look like git wrote it is dropped rather than turned into a repository
 * update.
 */
function isSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value)
}

/**
 * A ref name safe to hand back to git.
 *
 * Deliberately stricter than git's own rules. These names reach a command line,
 * and while every call site passes arguments as an array rather than a shell
 * string, a name beginning with `-` would still be read as an option.
 */
function isSafeRefName(ref: string): boolean {
  if (ref.length === 0 || ref.length > 255)
    return false

  if (ref.startsWith('-') || ref.includes('..') || ref.includes('@{') || ref.endsWith('/'))
    return false

  return /^[\w.\-/]+$/.test(ref)
}

function kindOf(ref: string): RefKind {
  if (ref.startsWith('refs/heads/'))
    return 'branch'

  if (ref.startsWith('refs/tags/'))
    return 'tag'

  return 'other'
}

function nameOf(ref: string, kind: RefKind): string {
  if (kind === 'branch')
    return ref.slice('refs/heads/'.length)

  if (kind === 'tag')
    return ref.slice('refs/tags/'.length)

  return ref
}

/**
 * One line into an update, or null when the line is not one.
 *
 * A push that both creates and deletes a ref is not expressible - git would
 * have sent two lines - so the zero sha on both sides is nonsense and is
 * dropped rather than being given a meaning.
 */
export function parseRefUpdate(line: string): RefUpdate | null {
  const parts = line.trim().split(/\s+/)
  if (parts.length !== 3)
    return null

  const [before, after, ref] = parts as [string, string, string]

  if (!isSha(before) || !isSha(after) || !isSafeRefName(ref))
    return null

  if (before === ZERO_SHA && after === ZERO_SHA)
    return null

  const kind = kindOf(ref)

  return {
    before,
    after,
    ref,
    kind,
    change: before === ZERO_SHA ? 'created' : (after === ZERO_SHA ? 'deleted' : 'updated'),
    name: nameOf(ref, kind),
  }
}

/** Every update in a hook's stdin, in the order git sent them. */
export function parseRefUpdates(input: string): RefUpdate[] {
  return input
    .split('\n')
    .map(line => parseRefUpdate(line))
    .filter((update): update is RefUpdate => update !== null)
}

/** The branches a push touched, which is what most of the work is about. */
export function branchUpdates(updates: readonly RefUpdate[]): RefUpdate[] {
  return updates.filter(update => update.kind === 'branch')
}

/**
 * The range to ask git for the new commits in.
 *
 * `before..after` for an ordinary push. A newly created branch has no `before`,
 * and asking for every commit reachable from it would walk the whole history on
 * the first push of a fork - so the caller is told to exclude what is already
 * reachable from the other refs instead, which is what `--not --all` does.
 *
 * A deletion introduces no commits and has no range at all.
 */
export function commitRange(update: RefUpdate): { from: string | null, to: string } | null {
  if (update.change === 'deleted')
    return null

  return { from: update.change === 'created' ? null : update.before, to: update.after }
}

/**
 * Whether this push moved the repository's default branch.
 *
 * Answered by name rather than by asking git what HEAD points at: the row is
 * what the rest of the application reads, and the question being asked is
 * whether that row is now stale.
 */
export function movesDefaultBranch(updates: readonly RefUpdate[], defaultBranch: string): boolean {
  return branchUpdates(updates).some(update => update.name === defaultBranch && update.change !== 'deleted')
}

/**
 * The default branch a repository should now have, or null to leave it alone.
 *
 * Only relevant on the first push into an empty repository, where the row says
 * `main` and the pusher pushed `master`. Changing it at any other time would
 * mean a push could silently repoint what everybody sees when they open the
 * repository, so it is only offered when the branch the row names does not
 * exist and exactly one branch was created.
 */
export function adoptedDefaultBranch(
  updates: readonly RefUpdate[],
  currentDefault: string,
  existingBranches: readonly string[],
): string | null {
  if (existingBranches.includes(currentDefault))
    return null

  const created = branchUpdates(updates).filter(update => update.change === 'created')
  if (created.length !== 1)
    return null

  return created[0]!.name === currentDefault ? null : created[0]!.name
}
