/**
 * Pull request state transitions.
 *
 * A pull request has one more state than an issue and it changes everything:
 * `merged` is terminal. Closed is a decision that can be revisited, merged is a
 * commit that exists, and a reopen that pretends otherwise produces a pull
 * request claiming to propose changes the base already contains.
 *
 * Draft lives here too rather than in an update endpoint, because "ready for
 * review" is a state change with consequences (reviewers get asked, checks that
 * skip drafts start running) and not an edit to a field.
 *
 * Pure, so the rules can be tested without a repository or a database.
 */

export type PullRequestState = 'open' | 'closed' | 'merged'

export type PullRequestTransition = 'close' | 'reopen'

export interface PullRequestStateInput {
  state: PullRequestState
  draft: boolean
  /**
   * Whether the head branch still points somewhere. Reopening needs something
   * to reopen: the common case is a branch deleted after the close.
   */
  headExists: boolean
}

export type StateOutcome =
  | { ok: true, state: PullRequestState, changed: boolean }
  | { ok: false, error: string, status: number }

/**
 * Close or reopen a pull request.
 *
 * Repeating a transition is not an error and does not touch the record, so a
 * double-clicked button or a retried API call does not rewrite who closed it and
 * when.
 */
export function transitionPullRequest(
  pullRequest: PullRequestStateInput,
  transition: PullRequestTransition,
): StateOutcome {
  if (pullRequest.state === 'merged') {
    return {
      ok: false,
      error: 'This pull request has been merged, so it cannot be closed or reopened',
      status: 409,
    }
  }

  if (transition === 'close') {
    return pullRequest.state === 'closed'
      ? { ok: true, state: 'closed', changed: false }
      : { ok: true, state: 'closed', changed: true }
  }

  if (pullRequest.state === 'open')
    return { ok: true, state: 'open', changed: false }

  if (!pullRequest.headExists) {
    return {
      ok: false,
      error: 'The head branch no longer exists, so there is nothing to reopen',
      status: 409,
    }
  }

  return { ok: true, state: 'open', changed: true }
}

export type DraftTransition = 'draft' | 'ready'

/**
 * Move a pull request between draft and ready.
 *
 * Only an open pull request has a meaningful draft state. Reopening something
 * closed while it was a draft brings the draft back with it, which is why this
 * refuses rather than quietly clearing the flag on a closed pull request.
 */
export function transitionDraft(
  pullRequest: PullRequestStateInput,
  transition: DraftTransition,
): { ok: true, draft: boolean, changed: boolean } | { ok: false, error: string, status: number } {
  if (pullRequest.state !== 'open') {
    return {
      ok: false,
      error: 'Only an open pull request can be marked draft or ready for review',
      status: 409,
    }
  }

  const draft = transition === 'draft'

  return { ok: true, draft, changed: draft !== pullRequest.draft }
}

/**
 * Who may close or reopen.
 *
 * The author may withdraw their own proposal without triage rights, for the same
 * reason they may close their own issue: retracting something you offered is not
 * a privileged act.
 */
export function mayTransition(input: { isAuthor: boolean, canClose: boolean }): boolean {
  return input.isAuthor || input.canClose
}

/**
 * Who may edit the title, body, or base branch.
 *
 * Narrower than closing. Rewriting somebody else's description changes what the
 * reviewers below it were responding to, so it takes write access rather than
 * triage.
 */
export function mayEdit(input: { isAuthor: boolean, canEditAny: boolean }): boolean {
  return input.isAuthor || input.canEditAny
}

export interface EditInput {
  title?: string | null
  body?: string | null
  base?: string | null
}

export type EditOutcome =
  | { ok: true, changes: { title?: string, body?: string, base_branch?: string } }
  | { ok: false, error: string, status: number }

/**
 * Validate an edit, returning only the fields that were actually supplied.
 *
 * Absent and empty are different: omitting `body` leaves it alone, sending an
 * empty one clears it. Omitting `title` leaves it alone, sending an empty one is
 * an error, because a pull request with no title is unreadable in every list it
 * appears in.
 */
export function editPullRequest(
  pullRequest: { state: PullRequestState, headBranch: string },
  edit: EditInput,
): EditOutcome {
  if (pullRequest.state === 'merged')
    return { ok: false, error: 'A merged pull request cannot be edited', status: 409 }

  const changes: { title?: string, body?: string, base_branch?: string } = {}

  if (edit.title !== undefined && edit.title !== null) {
    const title = edit.title.trim()
    if (!title)
      return { ok: false, error: 'A pull request needs a title', status: 422 }

    changes.title = title
  }

  if (edit.body !== undefined && edit.body !== null)
    changes.body = edit.body

  if (edit.base !== undefined && edit.base !== null) {
    const base = edit.base.trim()
    if (!base)
      return { ok: false, error: 'A pull request needs a base branch', status: 422 }

    // Retargeting onto its own head would make the pull request propose its
    // changes to itself, and every diff below it would come out empty.
    if (base === pullRequest.headBranch)
      return { ok: false, error: 'A pull request needs two different branches', status: 422 }

    changes.base_branch = base
  }

  return { ok: true, changes }
}
