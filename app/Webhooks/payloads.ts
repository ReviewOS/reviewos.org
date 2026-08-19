import type { EventSubject, NotificationEvent } from '../Notifications/definitions'

/**
 * What a webhook body looks like, for each event.
 *
 * **This is a public contract.** People build against these shapes and their
 * integrations break when a field moves, so this file is the one place in the
 * product where "obviously better" is not a good enough reason to change
 * anything. Adding a field is safe; renaming one, removing one, or changing a
 * type is a breaking change to somebody else's software, and it happens on a
 * version bump rather than quietly.
 *
 * Three rules the shapes follow, so a receiver can be written once:
 *
 * **Every payload has the same envelope.** `event`, `delivered_at`,
 * `repository`, `sender`, and one key named after what happened. A receiver
 * that has to guess which fields exist for which event is one that grows a
 * switch statement it will get wrong.
 *
 * **Numbers are numbers and times are ISO 8601 strings.** Both survive JSON,
 * both parse in every language, and neither depends on knowing our timezone.
 *
 * **Nothing here is a database row.** These are named fields chosen for the
 * receiver, so a column rename is not a breaking change to somebody's CI. That
 * is worth the transcription cost and it is the whole reason this file exists
 * rather than `JSON.stringify(row)`.
 *
 * Pure over plain values. Nothing here reads the database.
 */

/**
 * Every event that can carry a webhook.
 *
 * Mostly the same set the inbox knows, plus the two an agent needs and a person
 * does not. Webhooks are the supported way for a program to stay current, and a
 * program has different questions from a colleague watching a page.
 */
export const WEBHOOK_EVENTS = [
  'pr:opened',
  /*
   * The head moved: somebody pushed to an open pull request's branch.
   *
   * The single most important event for a reviewing agent and the one that was
   * missing. An agent that reviewed a change and is told nothing when the
   * author pushes a fix has two options, and both are bad: poll every open
   * pull request forever, or never look again. A person has neither problem -
   * they get a notification when somebody re-requests review, and they were
   * going to open the page anyway.
   *
   * Deliberately **not** a notification. Telling every reviewer about every
   * push is how an inbox becomes something people filter, and the thing they
   * filter is the channel that has to work.
   */
  'pr:synchronized',
  /*
   * A draft became ready.
   *
   * An agent configured to review what is ready has no way to notice the
   * transition otherwise: nothing about the pull request changes except a
   * boolean, so there is no push, no comment and no review request to observe.
   */
  'pr:ready_for_review',
  'pr:merged',
  'pr:closed',
  'review:requested',
  'review:submitted',
  'issue:opened',
  'issue:closed',
  'comment:created',
  'release:published',
  /*
   * A check said something about a commit.
   *
   * One event for every transition rather than three - `queued`, `in_progress`,
   * `completed` travel in `action` - because a receiver that wants only the
   * finished ones can look at one field, and a receiver that wants to know a
   * build started would otherwise have to subscribe to an event that did not
   * exist. It is what a deployment gate, a dashboard and a merge queue all
   * wait on.
   *
   * Webhook-only, deliberately. Nobody wants an inbox entry per check
   * transition, and a repository with six checks and a busy morning would send
   * a hundred.
   */
  'check:reported',
  /*
   * A run moved, and a job of one moved.
   *
   * The longest-lived thing this product has, and the two events everything
   * downstream of CI waits on: a deployment gate, a dashboard, a merge queue,
   * an agent waiting for its own check. The alternative is polling every run
   * every few seconds, which is the reason forges grow rate limits.
   *
   * The new state travels in `action`, so one subscription covers the whole
   * lifecycle and a receiver that only wants finished runs reads one field.
   */
  'run:transitioned',
  'job:transitioned',
  /*
   * A run that has stopped and is waiting for a person, or for the world.
   *
   * A transition already says the run is `waiting`, and that is not the same
   * question: a run waits behind a concurrency group, behind a gate somebody
   * has to open, behind an approval a fork's pull request needs, and behind an
   * event that has not arrived. Only two of those are anybody's to act on, and
   * a receiver that had to reconstruct which is which from the job rows would
   * be doing the control plane's reasoning in somebody else's process.
   *
   * `action` says what kind of thing is being waited for, so a chat integration
   * can post "this deploy needs an approval" without asking a second question.
   */
  'run:action_required',
  /*
   * An artifact that has passed its date and gone.
   *
   * The one webhook here that is about disappearance rather than progress, and
   * it exists because the failure it prevents is silent: a system that fetched
   * a build output nightly keeps fetching a 404, and the first person to notice
   * is whoever needed the file.
   */
  'artifact:expired',
  /*
   * The same, through the older commit-status API.
   *
   * Kept separate rather than folded into `check:reported`: the two carry
   * different fields - a status has no attempts, no annotations and no
   * output - and a receiver that has to test for the presence of half a dozen
   * keys to find out which kind it got is one that gets it wrong.
   */
  'status:reported',
  /*
   * A test monitor changed its mind.
   *
   * One event for both directions, with `alarm` or `recovered` in `action`,
   * and it is emitted **only on the transition**: the condition is true every
   * hour it is true, and a receiver told so every hour is a receiver that
   * writes a filter. The recovery is half the value - a dashboard that only
   * ever goes red is one people stop reading.
   *
   * Webhook-only, like the check and run events, and for the same reason:
   * nobody wants an inbox entry each time a suite wobbles, and this is a rule
   * somebody wrote for a program to act on.
   */
  'test:monitor',
  /*
   * A test became unreliable.
   *
   * A *transition*, like the monitor above and for the same reason: the test
   * that has been flaky for a month is not news, and a receiver told about it
   * on every run writes a filter that hides the one that broke today. It fires
   * when a test crosses from steady to flaky and not again.
   *
   * Worth its own event rather than folding into `test:monitor`: a monitor is
   * a rule somebody wrote, and this is a fact about one test that nobody had
   * to ask for.
   */
  'test:flaky',
  /*
   * A suite reported its results.
   *
   * The ingestion event, and the one a dashboard actually waits on: without it
   * the only way to know a suite has finished is to poll the API that this
   * event carries the summary of. Not a transition and not a threshold - it is
   * the fact that a run happened, with its totals.
   *
   * Webhook-only, like the rest of these: nobody wants an inbox entry per test
   * run, and a repository reporting on every push would fill one in a morning.
   */
  'test:recorded',
] as const

export type WebhookEvent = typeof WEBHOOK_EVENTS[number]

/** The `ping` a webhook receives when it is created, so it can be verified at once. */
export const PING_EVENT = 'ping'

export interface Envelope {
  /** The event name, exactly as it appears in a webhook's `events` list. */
  event: string
  /** When this payload was built, ISO 8601. */
  delivered_at: string
  repository: {
    /** `owner/name`. The one field every receiver routes on. */
    full_name: string
    owner: string
    name: string
    id: number
  }
  /**
   * Who caused it. Null when nothing did - a scheduled action, a system event.
   * A receiver that assumes a sender will crash on the day one is missing.
   */
  sender: { handle: string, id: number } | null
}

/**
 * The body for one event.
 *
 * `subject` carries what the event is about and is deliberately the same shape
 * for all nine: a receiver that only cares about "something happened to
 * pull request 42" should not have to know nine field names to find the 42.
 */
export interface WebhookPayload extends Envelope {
  subject: {
    type: 'pull_request' | 'issue' | 'repository'
    id: number
    /** The number people use. Null for a repository-level event. */
    number: number | null
    title: string
    /** A path on this host, not a full URL: the host is the receiver's to know. */
    url: string
  }
  /**
   * What specifically happened, when the event name is not enough.
   *
   * `opened`, `merged`, `closed`, `approved`, `changes_requested`,
   * `commented`, `published`. Present on every payload, so a receiver can
   * switch on one field rather than on the pair.
   */
  action: string
  /** The tag, for a release. Absent otherwise rather than empty. */
  tag?: string
  /** What a check said. Absent on every event that is not one. */
  check?: CheckDetail
  /** The workflow run, on `run:transitioned`. */
  run?: RunDetail
  /** The job, on `job:transitioned`. */
  job?: JobDetail
  /** The rule that changed its mind, on `test:monitor`. */
  monitor?: MonitorDetail
  /** The test that became unreliable, on `test:flaky`. */
  test?: TestDetail
  /** The suite that reported, on `test:recorded`. */
  suite?: SuiteDetail
  /** The artifact that has gone, on `artifact:expired`. */
  artifact?: ArtifactDetail
}

/**
 * An artifact that has expired, as a receiver reads it.
 *
 * Named and sized rather than linked: the file is gone by the time this is
 * sent, and a URL that answers 404 is worse than no URL. What a receiver can do
 * with this is decide to rebuild, or stop asking - both of which need the name
 * and the run it came from.
 */
export interface ArtifactDetail {
  id: number
  name: string
  /** How big it was, in bytes, so a receiver can say what it lost. */
  size: number
  /** The run that produced it, for asking the API what else that run made. */
  run_id: number
  run_number: number
  /** When it was due to go, which is not always when it went. */
  expires_at: string | null
}

/**
 * A suite's run, as a receiver reads it.
 *
 * The totals rather than the executions: a report of two thousand tests is two
 * thousand rows, and a webhook body that carried them would be a delivery that
 * times out on the interesting repositories. Whoever wants the detail asks the
 * API for it, which is what the `run` id is for.
 */
export interface SuiteDetail {
  /** The suite's slug, which is what the API takes. */
  suite: string
  /** The `test_runs` row, for reading the executions back. */
  run: number
  branch: string
  head_sha: string
  passed: number
  failed: number
  skipped: number
  /** Counted and not held against the run: what a mute does here. */
  muted_failures: number
  duration_ms: number
  /** The workflow run this came from, when it came from one. */
  workflow_run_id: number | null
}

/**
 * A test that just crossed from steady to flaky.
 *
 * `reason` is which of the two shapes it was - disagreeing about one commit, or
 * passing only after a retry - because they mean different things to whoever
 * reads this: the first is usually a race, the second is usually a timeout.
 */
export interface TestDetail {
  id: number
  suite: string
  /** The file or class the reporter gave. Empty when it gave none. */
  scope: string
  name: string
  reason: string
  /** The commit whose results made it flaky. */
  head_sha: string
}

/**
 * A rule about the tests, and what it now reads.
 *
 * `measurement` and `samples` travel with it because a receiver acting on an
 * alarm needs to know how much evidence is behind it: "the failure rate is 40%"
 * over nine executions is a different message from the same number over nine
 * thousand.
 */
export interface MonitorDetail {
  id: number
  /** The suite it watches, or null for all of them together. */
  suite: string | null
  /** `fail_rate`, `flaky`, or `duration`. */
  condition: string
  /** Percent, a count of tests, or milliseconds, depending on the condition. */
  threshold: number
  window_days: number
  /** `alarm` or `recovered`. Also copied into the envelope's `action`. */
  action: string
  measurement: number | null
  samples: number
}

/** A workflow run, for the receivers that wait on one. */
export interface RunDetail {
  id: number
  /** The number people say out loud, and the one in the URL. */
  number: number
  state: string
  /** What started it: `push`, `pull_request`, and so on. */
  event: string | null
  head_sha: string | null
  /** The full ref, because a receiver filtering by branch needs to parse it. */
  ref: string | null
  /** The workflow's name, when the payload's builder knew it. */
  workflow: string | null
}

/** One job of a run. */
export interface JobDetail {
  id: number
  /** The key in the workflow file, which is what `needs` refers to. */
  job_id: string
  name: string
  state: string
  run_id: number
  run_number: number
  /** Which machine holds it, when one does. */
  runner: string | null
}

/** What `action` each event means. */
const ACTIONS: Record<string, string> = {
  'pr:opened': 'opened',
  'pr:synchronized': 'synchronized',
  'pr:ready_for_review': 'ready_for_review',
  'pr:merged': 'merged',
  'pr:closed': 'closed',
  'review:requested': 'review_requested',
  'review:submitted': 'reviewed',
  'issue:opened': 'opened',
  'issue:closed': 'closed',
  'comment:created': 'commented',
  'release:published': 'published',
  /*
   * The fallback only. A real check payload carries its transition here -
   * `queued`, `in_progress`, `completed` - because that is the field a
   * deployment gate switches on, and flattening three transitions into one
   * word would make the event useless for the thing it exists for.
   */
  'check:reported': 'reported',
  'status:reported': 'reported',
  // Fallbacks only: a real payload carries the state it moved to.
  'run:transitioned': 'transitioned',
  'job:transitioned': 'transitioned',
  // A fallback: a real payload carries `approval`, `gate` or `event`.
  'run:action_required': 'required',
  'artifact:expired': 'expired',
  // Also a fallback: a real monitor payload carries `alarm` or `recovered`.
  'test:monitor': 'changed',
  'test:flaky': 'flaky',
  // A fallback: a real payload carries `passed` or `failed`.
  'test:recorded': 'recorded',
}

/**
 * What a check reported, for the receivers that exist to act on it.
 *
 * Present only on `check:reported` and `status:reported`. A commit rather than
 * an issue or a pull request is what these are about, and `subject` stays the
 * repository rather than being stretched to mean a sha - a receiver routing on
 * `subject.type` should not have to learn a fourth value to keep working.
 */
export interface CheckDetail {
  /** The name a branch rule would match on. */
  name: string
  /** The commit it is about, in full. */
  sha: string
  /** `queued`, `in_progress` or `completed`; a status reports `completed`. */
  status: string
  /** Null until there is one. Never guessed from a status that has not finished. */
  conclusion: string | null
  /** 1 unless the reporter retried. Always 1 for a commit status. */
  attempt: number
  /** Where the run's output lives, on the reporter's side. Empty when unknown. */
  details_url: string
  /** One line, when the reporter sent one. */
  summary: string
}

/**
 * Build the body for one event.
 *
 * Takes the same payload the notification listener gets, so an event has one
 * shape inside the product and one shape on the wire, and the translation
 * between them lives here rather than at nine call sites.
 */
export function webhookPayload(
  event: NotificationEvent | string,
  subject: EventSubject & { detail?: string, check?: CheckDetail, run?: RunDetail, job?: JobDetail, monitor?: MonitorDetail, test?: TestDetail },
  at: string,
): WebhookPayload {
  const owner = String(subject.owner ?? '')
  const name = String(subject.repository ?? '')
  const type = subject.subjectType === 'issue'
    ? 'issue'
    : subject.subjectType === 'pull_request' ? 'pull_request' : 'repository'

  return {
    event: String(event),
    delivered_at: at,
    repository: {
      full_name: `${owner}/${name}`,
      owner,
      name,
      id: Number(subject.repositoryId ?? 0),
    },
    sender: subject.actorId
      ? { handle: String(subject.actorHandle ?? ''), id: Number(subject.actorId) }
      : null,
    subject: {
      type,
      id: Number(subject.subjectId ?? 0),
      number: subject.number == null ? null : Number(subject.number),
      title: String(subject.title ?? ''),
      url: urlFor(owner, name, type, subject.number),
    },
    // A check's action is its own state, which is the field a receiver
    // switches on. Mapping it through ACTIONS would flatten three transitions
    // into one word and make the event useless for the thing it exists for.
    action: subject.check
      ? String(subject.check.status)
      : subject.job
        ? String(subject.job.state)
        : subject.run
          ? String(subject.run.state)
          // A monitor's action is the direction it moved, which is the field a
          // receiver switches on: an alarm and its recovery are the same event
          // name and opposite meanings.
          : subject.monitor
            ? String(subject.monitor.action)
            /*
             * And a suite's action is its verdict, so a receiver waiting for a
             * red build reads one field rather than comparing two numbers.
             */
            : subject.suite
              ? (Number(subject.suite.failed) > 0 ? 'failed' : 'passed')
              : (ACTIONS[String(event)] ?? String(event)),
    ...(subject.detail ? { tag: String(subject.detail) } : {}),
    ...(subject.check ? { check: subject.check } : {}),
    ...(subject.run ? { run: subject.run } : {}),
    ...(subject.job ? { job: subject.job } : {}),
    ...(subject.monitor ? { monitor: subject.monitor } : {}),
    ...(subject.test ? { test: subject.test } : {}),
    ...(subject.suite ? { suite: subject.suite } : {}),
  }
}

/**
 * The `ping`, sent when a webhook is created.
 *
 * The same envelope with no subject, because there is nothing it happened to.
 * A receiver that handles the envelope handles this for free, which is the
 * point: verifying an endpoint should exercise the real path, not a special
 * one.
 */
export function pingPayload(
  repository: { id: number, owner: string, name: string },
  sender: { handle: string, id: number } | null,
  at: string,
): Envelope & { zen: string } {
  return {
    event: PING_EVENT,
    delivered_at: at,
    repository: {
      full_name: `${repository.owner}/${repository.name}`,
      owner: repository.owner,
      name: repository.name,
      id: repository.id,
    },
    sender,
    // Present so a receiver has something to log that proves the body arrived
    // intact, and because a ping with an empty body is one people mistake for a
    // failure.
    zen: 'A review is the product. Everything else serves it.',
  }
}

/** A path on this host. The receiver knows its own base URL; we do not. */
function urlFor(owner: string, name: string, type: string, number: unknown): string {
  if (type === 'repository' || number == null)
    return `/${owner}/${name}`

  return type === 'pull_request'
    ? `/${owner}/${name}/pull/${number}`
    : `/${owner}/${name}/issue/${number}`
}

/**
 * Whether a webhook subscribed to this event.
 *
 * `*` means everything, which is what the interface offers as "send me
 * everything" and what most integrations actually want. An empty list means
 * nothing rather than everything: a webhook created with no events selected
 * should be silent, not a firehose.
 */
export function subscribes(events: string, event: string): boolean {
  const list = String(events ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)

  if (list.includes('*'))
    return true

  return list.includes(event)
}
