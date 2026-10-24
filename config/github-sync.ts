import process from 'node:process'

/** Opt-in account discovery. Secrets use the mirror credential file resolver. */
export default {
  user: String(process.env.GITHUB_SYNC_USER ?? ''),
  credential: String(process.env.GITHUB_SYNC_CREDENTIAL ?? 'github_account'),
}
