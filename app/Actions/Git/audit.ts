/**
 * Writing to the audit log.
 *
 * One function, because the value of an audit log is that everything reaches it
 * the same way. A caller that builds its own row is a caller that will one day
 * forget the actor, or the reason, or record the finding it overrode in a shape
 * nothing else can read.
 *
 * Never throws, and that is a real decision rather than a convenience. The
 * alternative - failing the operation when the log write fails - means a
 * database hiccup refuses a push that was allowed, which is the sort of thing
 * that gets audit logging removed. The record is worth a great deal and it is
 * not worth more than the thing it describes.
 */

export interface AuditEntry {
  action: string
  subject?: { type: string, id: number } | null
  actorId?: number | null
  externalActor?: string | null
  reason?: string | null
  detail?: unknown
  ip?: string | null
}

export async function recordAudit(entry: AuditEntry): Promise<boolean> {
  try {
    await db
      .insertInto('audit_events')
      .values({
        action: entry.action.slice(0, 80),
        subject_type: entry.subject?.type?.slice(0, 40) ?? null,
        subject_id: entry.subject?.id ?? null,
        actor_id: entry.actorId ?? null,
        external_actor: entry.externalActor?.slice(0, 120) ?? null,
        reason: entry.reason ?? null,
        // Serialized here rather than at the call site, so every row's `detail`
        // is JSON and a reader never has to guess which ones are.
        detail: entry.detail === undefined ? null : JSON.stringify(entry.detail),
        ip_address: entry.ip?.slice(0, 45) ?? null,
      })
      .execute()

    return true
  }
  catch {
    return false
  }
}
