/**
 * React to a metadata import falling short.
 *
 * A partial import is the common outcome rather than the exception: a rate
 * limit stops it mid-way and the next sweep continues. So this reports what did
 * land alongside what went wrong, because "rate limited" on its own reads as
 * "nothing happened" when usually most of it did.
 */
export default {
  listensTo: 'mirror:metadata-failed',

  handle(payload: {
    mirrorId: number
    repositoryId: number
    error: string | null
    written: {
      issues: { created: number, updated: number }
      pulls: { created: number, updated: number }
      threads: { created: number, updated: number }
    }
  }): void {
    const { issues, pulls, threads } = payload.written
    const landed = issues.created + pulls.created + threads.created

    console.warn(
      `mirror ${payload.mirrorId} metadata sync incomplete (${payload.error ?? 'unknown'}); `
      + `${landed} rows imported before it stopped`,
    )
  },
}
