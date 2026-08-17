/**
 * What `GITHUB_EVENT_PATH` points at.
 *
 * Half the Actions ecosystem reads the event payload rather than the
 * environment: a label-the-issue action wants `event.issue.number`, a
 * changed-files action wants `event.pull_request.base.ref`, and an action that
 * finds neither does nothing and says nothing. Handing a step an empty file is
 * the shape of compatibility that looks present and is not.
 *
 * **The shapes are this instance's webhook payloads**, not GitHub's, and that
 * is [phase 15](../../../docs/todo/15-pipelines.md)'s decision rather than a
 * shortcut: an integration written against this forge should see one set of
 * shapes whether it arrived over a webhook or through a job's environment.
 * `Webhooks/payloads.ts` is the public contract, and this file follows its
 * envelope - `event`, `repository`, `sender`, and one key named after what
 * happened.
 *
 * **Built from what the run recorded**, so the fields that must not drift do
 * not: the event, the ref, the commit, the run number and who started it all
 * come from the run's own row rather than from the repository as it is today. A
 * re-run of an old run sees the commit it was created for. What *is* read
 * fresh - the repository's description, an issue's current title - is named in
 * the field list below rather than left for somebody to discover.
 *
 * Pure over plain values. Nothing here reads the database; the claim endpoint
 * gathers the facts and this turns them into the document.
 */

export interface EventRepository {
  /** `owner/name`, which is what nearly everything actually keys on. */
  full_name: string
  name: string
  owner: string
  visibility: string
  default_branch: string
}

export interface EventActor {
  handle: string
  name: string | null
}

export interface EventPullRequest {
  number: number
  title: string
  state: string
  draft: boolean
  head_ref: string
  base_ref: string
  head_sha: string
}

export interface EventFacts {
  /** `push`, `pull_request`, `schedule`, `workflow_dispatch`, `issues`, ... */
  event: string
  /** The ref the run was created against, as written on the run. */
  ref: string
  sha: string
  runNumber: number
  runId: number
  repository: EventRepository
  /** Who caused it, when this instance recorded somebody. */
  sender: EventActor | null
  pullRequest?: EventPullRequest | null
  /** `workflow_dispatch` inputs, as they were supplied. */
  inputs?: Record<string, unknown> | null
  /**
   * The subject an `issues` / `issue_comment` / `release` run was started by.
   *
   * Thin on purpose, and the thinness is honest: these runs are recorded
   * against a subject *number* and an activity, which is all the dispatcher is
   * given. A payload that invented a full issue object here would be inventing
   * it from the issue as it is now, which is not what the event said.
   */
  subject?: { kind: string, id: string, action: string } | null
}

/** The name a payload's own key takes, per event. */
function subjectKey(event: string): string {
  if (event === 'issue_comment')
    return 'comment'

  if (event === 'issues')
    return 'issue'

  if (event === 'release')
    return 'release'

  return 'subject'
}

/**
 * The document a step reads.
 *
 * Every event carries the same envelope, so an action can be written once: a
 * receiver that has to guess which fields exist for which event grows a switch
 * statement it will get wrong.
 */
export function eventPayload(facts: EventFacts): Record<string, unknown> {
  const base: Record<string, unknown> = {
    event: facts.event,
    /*
     * `ref` and `after` under the names a push payload uses, because that is
     * what the ecosystem's scripts reach for first. `sha` is the same value
     * under the name the environment uses, so somebody comparing the two never
     * has to wonder whether they differ.
     */
    ref: facts.ref,
    after: facts.sha,
    sha: facts.sha,
    repository: {
      ...facts.repository,
      /*
       * No URLs. This instance does not know its own public address from
       * inside a job - it may be behind a proxy, a tunnel or a different host
       * name for the fleet - and a payload carrying a URL that does not resolve
       * is worse than one carrying none. `GITHUB_SERVER_URL` in the
       * environment is where a runner is told, by whoever configured it.
       */
    },
    sender: facts.sender,
    workflow_run: {
      id: facts.runId,
      number: facts.runNumber,
    },
  }

  if (facts.pullRequest) {
    base.pull_request = {
      number: facts.pullRequest.number,
      title: facts.pullRequest.title,
      state: facts.pullRequest.state,
      draft: facts.pullRequest.draft,
      // Nested the way a webhook nests them, because `base.ref` is the path
      // every existing script already writes.
      head: { ref: facts.pullRequest.head_ref, sha: facts.pullRequest.head_sha },
      base: { ref: facts.pullRequest.base_ref },
    }
  }

  if (facts.inputs && Object.keys(facts.inputs).length > 0)
    base.inputs = facts.inputs

  if (facts.subject) {
    base[subjectKey(facts.subject.kind)] = {
      id: facts.subject.id,
      action: facts.subject.action,
    }

    // Actions puts the activity type in `action`, and enough scripts branch on
    // it that leaving it only inside the subject would break them.
    base.action = facts.subject.action
  }

  return base
}
