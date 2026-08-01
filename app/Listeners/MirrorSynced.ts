/**
 * React to a mirror finishing a sync.
 *
 * Separate from the job so what happens *after* a sync - search reindexing,
 * notifying watchers, warming a cache - can grow without the job that fetches
 * git learning about any of it.
 */
export default {
  listensTo: 'mirror:synced',

  handle(payload: {
    mirrorId: number
    repositoryId: number
    changes: number
    summary: string
    rewroteHistory: boolean
  }): void {
    if (payload.changes === 0)
      return

    // A rewrite is reported rather than absorbed silently: anyone reading a
    // mirror deserves to know the history moved under them.
    if (payload.rewroteHistory)
      console.warn(`mirror ${payload.mirrorId}: upstream rewrote history on the default branch`)

    console.info(`mirror ${payload.mirrorId} synced: ${payload.summary}`)
  },
}
