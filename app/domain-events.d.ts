/**
 * This instance's own events.
 *
 * `AppEvents` is the framework's augmentation target, and declaring on it is
 * the whole mechanism: the event map used to carry a `[key: string]: string[]`
 * index signature, which made every name legal, so `dispatch('push:recieved')`
 * compiled and reached nobody. That is the failure an event bus is least able
 * to report, because a dispatch nothing listens for looks exactly like a
 * dispatch that had nothing to do. The index signature is gone as of stacks
 * 0.75, and an event this application fires has to be named here instead.
 *
 * Model events arrive separately. `'user:created'` and its seven siblings come
 * from `storage/framework/types/model-events.d.ts`, which derives them from the
 * models barrel rather than listing them, so a new model is a new event without
 * anything here changing.
 *
 * Payloads are permissive on purpose where the emitter spreads an options
 * object into them: a spread does not get excess-property checking, so a
 * narrower declaration here would only be a second description of a shape that
 * already has one.
 */

import type { AuditEventName, AuditPayload } from './Audit/events'
import type { EventSubject, NotificationEvent } from './Notifications/definitions'
import type { ProgramEvent } from './Notifications/emit'

/**
 * Every audited action, each pointed at the one listener that writes the log.
 *
 * Mapped from `AuditEventName` rather than listed, for the same reason
 * `app/Events.ts` spreads its registration from the catalogue: the list was
 * written twice once already, and three audit events were added to one copy and
 * not the other, so that family read as wired in part.
 */
type AuditEvents = {
  [K in AuditEventName]: AuditPayload & { event: AuditEventName }
}

/** The events a person can be notified about, and subscribed to. */
type NotificationEvents = {
  [K in NotificationEvent]: EventSubject & { event: NotificationEvent }
}

/** The events only programs hear: they reach the webhook listener and stop. */
type ProgramEvents = {
  [K in ProgramEvent]: EventSubject & { event: ProgramEvent }
}

/**
 * A mirror reports what it did rather than the job deciding who cares.
 *
 * Refs and metadata are separate events because one means the code moved and
 * the other means the discussion around it did, and a reader cares about them
 * at different times.
 */
interface MirrorEvents {
  'mirror:synced': {
    mirrorId: number
    repositoryId: number
    changes: number
    summary: string
    rewroteHistory: boolean
  }
  'mirror:failed': {
    mirrorId: number
    repositoryId: number
    error?: string | null
  }
  'mirror:metadata-synced': {
    mirrorId: number
    repositoryId: number
    written: MetadataWritten
  }
  'mirror:metadata-failed': {
    mirrorId: number
    repositoryId: number
    error?: string | null
    written: MetadataWritten
  }
}

/**
 * What a metadata sync actually wrote, per kind.
 *
 * Counted rather than summed, because the interesting number differs by kind:
 * an import is mostly `created` and a re-sync is mostly `updated`, and one
 * total cannot tell those apart. The repository's own row reports which fields
 * moved instead, since there is only ever one of it.
 */
interface MetadataWritten {
  issues: { created: number, updated: number }
  pulls: { created: number, updated: number }
  threads: { created: number, updated: number }
  repository: { updated: string[] }
  labels: { created: number, updated: number }
}

/**
 * What a push left behind, reported once the refs have actually moved.
 *
 * Counts rather than the rows themselves: a listener that wants the commits can
 * read them, and a payload carrying every commit of a thousand-commit push is
 * one the queue has to serialize.
 */
interface PushEvents {
  'push:received': {
    repositoryId: number
    /** `null` when the repository's owner row could not be resolved. */
    owner: string | null
    repository: string
    defaultBranch: string
    updates: unknown
    commits: number
    /** The issues this push closed, by number, not how many. */
    closedIssues: number[]
    pullRequestsRefreshed: number
  }
}

declare module '@stacksjs/events' {
  interface AppEvents extends AuditEvents, NotificationEvents, ProgramEvents, MirrorEvents, PushEvents {}
}
