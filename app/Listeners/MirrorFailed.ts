/**
 * React to a mirror failing.
 *
 * The failure is already on the mirror row, which is what the repository page
 * reads. This exists so it can also reach a person: a mirror nobody is told
 * about is one nobody fixes.
 */
export default {
  listensTo: 'mirror:failed',

  handle(payload: { mirrorId: number, repositoryId: number, error: string | null }): void {
    console.error(`mirror ${payload.mirrorId} failed to sync: ${payload.error ?? 'unknown error'}`)
  },
}
