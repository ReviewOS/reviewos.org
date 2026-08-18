/**
 * Moving an operation through its states, from the worker doing the work.
 *
 * The other half of the pattern. `startOperation` creates the row and answers
 * the caller; this is what the job calls so that what the caller polls is true.
 *
 * **Nothing here throws.** A job that failed because it could not write a status
 * row has turned a reporting problem into a work problem, and the work is the
 * part that matters. A status that is silently stale is bad; a sync that did not
 * happen because the status could not be written is worse.
 */

/** The work has been picked up. */
export async function markRunning(operationId: number | null | undefined): Promise<void> {
  if (!operationId)
    return

  try {
    await db
      .updateTable('operations')
      .set({ status: 'running', started_at: new Date().toISOString() })
      .where('id', '=', Number(operationId))
      // Only from `queued`. A retry of a job whose first attempt already
      // finished must not drag a terminal operation back to running, which
      // would have a client that saw `succeeded` start polling again.
      .where('status', '=', 'queued')
      .execute()
  }
  catch {}
}

/** It finished, and this is what it produced. */
export async function markSucceeded(operationId: number | null | undefined, result: unknown): Promise<void> {
  await finish(operationId, 'succeeded', { result: JSON.stringify(result ?? null) })
}

/** It failed, and this is what a caller can do about it. */
export async function markFailed(operationId: number | null | undefined, error: string): Promise<void> {
  // Bounded: an error is a sentence for a person, and a stack trace pasted into
  // a status endpoint is a stack trace on somebody's dashboard.
  await finish(operationId, 'failed', { error: String(error).slice(0, 2000) })
}

/** It stopped because somebody asked it to. */
export async function markCancelled(operationId: number | null | undefined): Promise<void> {
  await finish(operationId, 'cancelled', {})
}

/**
 * Whether a stop has been asked for.
 *
 * Called at whatever checkpoints the work has. Cancelling is a request rather
 * than an act - the work is running here and nothing else can interrupt it - so
 * a job that never asks is a job that cannot be cancelled, and that is a
 * property of the job rather than of the pattern.
 */
export async function cancelRequested(operationId: number | null | undefined): Promise<boolean> {
  if (!operationId)
    return false

  try {
    const row = await db
      .selectFrom('operations')
      .select(['cancel_requested_at'])
      .where('id', '=', Number(operationId))
      .executeTakeFirst()

    return Boolean(row?.cancel_requested_at)
  }
  catch {
    // Unknown reads as "not cancelled". The alternative - stopping work because
    // a status query failed - is the wrong direction to guess in.
    return false
  }
}

async function finish(
  operationId: number | null | undefined,
  status: 'succeeded' | 'failed' | 'cancelled',
  extra: Record<string, unknown>,
): Promise<void> {
  if (!operationId)
    return

  try {
    await db
      .updateTable('operations')
      .set({ status, finished_at: new Date().toISOString(), ...extra })
      .where('id', '=', Number(operationId))
      .execute()
  }
  catch {}
}
