import { dispatchSubject } from '../Actions/Workflow/dispatch'
import type { SubjectEventName } from '../Actions/Workflow/triggers'

/**
 * `on: issues`, `on: issue_comment` and `on: release`.
 *
 * The two things people automate first - label a new issue, publish on a
 * release - and this instance has been emitting the events for both since
 * [phase 5](../../docs/todo/05-notifications.md) with nothing reading them for
 * CI. Wiring, rather than anything new: the events already carry the
 * repository, the actor and the subject.
 *
 * Fire-and-forget, like every listener here. Opening an issue is answered when
 * the issue exists, not when CI has been thought about.
 */
export default {
  listensTo: ['issue:opened', 'issue:closed', 'comment:created', 'release:published'],

  async handle(payload: any, eventName?: string): Promise<void> {
    // Both shapes, for the reason `DispatchWebhooks` gives: the two event
    // libraries in play disagree about whether a handler is told which event
    // fired.
    await handleEvent(payload, String(payload?.event ?? eventName ?? ''))
  },
}

/** What each of this instance's events means in Actions' vocabulary. */
const TRANSLATION: Record<string, { event: SubjectEventName, activity: string }> = {
  'issue:opened': { event: 'issues', activity: 'opened' },
  'issue:closed': { event: 'issues', activity: 'closed' },
  'comment:created': { event: 'issue_comment', activity: 'created' },
  'release:published': { event: 'release', activity: 'published' },
}

/** The work, separated from the listener shape so a test can call it directly. */
export async function handleEvent(event: any, eventName = ''): Promise<void> {
  try {
    const name = eventName || String(event?.event ?? '')
    const translated = TRANSLATION[name]

    if (!translated)
      return

    const repositoryId = Number(event?.repositoryId ?? 0)

    if (!repositoryId)
      return

    /*
     * The subject in the ref keeps two issues from looking like one run
     * redelivered: the redelivery key covers version, ref, head and event, and
     * every issue event in a repository shares a head commit.
     */
    const subject = String(event?.number ?? event?.subjectId ?? '')

    if (!subject)
      return

    await dispatchSubject({
      repositoryId,
      event: translated.event,
      activity: translated.activity,
      subject,
      actorId: Number(event?.actorId ?? 0) || null,
    })
  }
  catch {
    /*
     * A listener must never fail the thing that emitted it. By the time this
     * runs the issue exists and the person who opened it has their answer; the
     * worst case here is a run that did not start, which the run list shows as
     * nothing rather than as a broken issue.
     */
  }
}
