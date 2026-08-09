/**
 * Where the CLI keeps a token.
 *
 * **The operating system's keychain, not a dotfile.** A token in
 * `~/.reviewos/token` is readable by every process the user runs, ends up in
 * backups, and survives in a synced home directory long after somebody thought
 * they had removed it. A keychain entry is gated by the login session and can
 * be audited and revoked with the tools people already have for credentials.
 *
 * Three platforms, three utilities that ship with them - `security` on macOS,
 * `secret-tool` from libsecret on Linux, `cmdkey` on Windows. None is a
 * dependency this project adds; each is the thing that platform already uses.
 *
 * ## The headless case
 *
 * A container has no keychain and no session to unlock one, and CI is exactly
 * where a token gets used. Refusing outright would make the CLI unusable in the
 * place it is most useful, so `REVIEWOS_TOKEN` is read from the environment
 * first and nothing is stored at all in that case. That is not a weaker
 * fallback: an environment variable in CI is scoped to the job, is what every
 * runner's secret store injects, and never touches a disk.
 *
 * There is deliberately **no file fallback.** A CLI that quietly writes a
 * dotfile when the keychain is unavailable teaches its users that the keychain
 * is optional, and the machines where it is unavailable are the shared ones.
 */

import process from 'node:process'

/** One entry per instance, so two forges do not overwrite each other. */
const SERVICE = 'reviewos'

export interface Keychain {
  read: (instance: string) => Promise<string | null>
  write: (instance: string, token: string) => Promise<boolean>
  erase: (instance: string) => Promise<boolean>
  /** What this platform stores in, for a message that tells the truth. */
  describe: () => string
}

/** Run a command and return stdout, or null when it failed. */
async function run(argv: string[], input?: string): Promise<string | null> {
  try {
    const child = Bun.spawn(argv, {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input),
    })

    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])

    return code === 0 ? out : null
  }
  catch {
    // The utility is not installed. Reported as "no keychain here" rather than
    // as a crash, because that is what it means.
    return null
  }
}

const macos: Keychain = {
  describe: () => 'the macOS keychain',

  async read(instance) {
    const found = await run(['security', 'find-generic-password', '-s', SERVICE, '-a', instance, '-w'])

    return found ? found.trim() || null : null
  },

  async write(instance, token) {
    // `-U` updates in place. Without it a second login fails with "already
    // exists" and the user is left holding the old token, which is the worst
    // possible outcome of a command they ran to change credentials.
    return await run(['security', 'add-generic-password', '-U', '-s', SERVICE, '-a', instance, '-w', token]) !== null
  },

  async erase(instance) {
    return await run(['security', 'delete-generic-password', '-s', SERVICE, '-a', instance]) !== null
  },
}

const libsecret: Keychain = {
  describe: () => 'the system keyring',

  async read(instance) {
    const found = await run(['secret-tool', 'lookup', 'service', SERVICE, 'account', instance])

    return found ? found.trim() || null : null
  },

  async write(instance, token) {
    /*
     * The secret arrives on stdin, never as an argument. An argument is visible
     * in `ps` to every user on the machine for as long as the process runs,
     * which for a credential is long enough.
     */
    return await run(
      ['secret-tool', 'store', '--label', `ReviewOS (${instance})`, 'service', SERVICE, 'account', instance],
      token,
    ) !== null
  },

  async erase(instance) {
    return await run(['secret-tool', 'clear', 'service', SERVICE, 'account', instance]) !== null
  },
}

const windows: Keychain = {
  describe: () => 'the Windows credential manager',

  async read(instance) {
    /*
     * `cmdkey` lists credentials but will not print a password back, by design.
     * So there is nothing to read here, and the honest answer is null rather
     * than a partial one: a caller told "no stored token" prompts for one,
     * which works, while a caller handed something that is not the token fails
     * in a way that looks like the server rejecting it.
     */
    void instance

    return null
  },

  async write(instance, token) {
    return await run(['cmdkey', `/generic:${SERVICE}:${instance}`, '/user:reviewos', `/pass:${token}`]) !== null
  },

  async erase(instance) {
    return await run(['cmdkey', `/delete:${SERVICE}:${instance}`]) !== null
  },
}

/** The keychain for this platform. */
export function keychainFor(platform: string = process.platform): Keychain {
  if (platform === 'darwin')
    return macos

  if (platform === 'win32')
    return windows

  return libsecret
}

/**
 * The token to use, from the environment or the keychain.
 *
 * The environment wins. It is how CI supplies one, it is scoped to a job, and a
 * developer overriding a stored token for one command should not have to
 * un-store it first.
 */
export async function tokenFor(instance: string, environment: Record<string, string | undefined> = process.env): Promise<string | null> {
  const fromEnvironment = String(environment.REVIEWOS_TOKEN ?? '').trim()
  if (fromEnvironment)
    return fromEnvironment

  return await keychainFor().read(instance)
}
