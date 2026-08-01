/**
 * React to a metadata import finishing.
 *
 * Kept apart from `MirrorSynced` because the two say different things. That one
 * means the code moved; this one means the issues and reviews around it did.
 * A reader watching a repository cares about the second far more often, and
 * folding them together would make every commit look like new discussion.
 */
export default {
  listensTo: 'mirror:metadata-synced',

  handle(payload: {
    mirrorId: number
    repositoryId: number
    written: {
      issues: { created: number, updated: number }
      pulls: { created: number, updated: number }
      threads: { created: number, updated: number }
    }
  }): void {
    const { issues, pulls, threads } = payload.written
    const total = issues.created + pulls.created + threads.created

    // A sync that found nothing new is the normal case and not worth a line.
    if (total === 0)
      return

    console.info(
      `mirror ${payload.mirrorId} imported ${issues.created} issues, `
      + `${pulls.created} pull requests, ${threads.created} review comments`,
    )
  },
}
