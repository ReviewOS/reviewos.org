/**
 * Reading a secret from a file rather than from the environment.
 *
 * `DB_PASSWORD_FILE=/run/secrets/db` is the convention Docker secrets,
 * Kubernetes projected volumes, systemd credentials and every mainstream secret
 * manager already produce, and supporting it is about twenty lines. Not
 * supporting it means an operator with a secret manager has to write a shell
 * wrapper that reads the file and exports the variable, which puts the secret
 * back where it was trying not to be.
 *
 * ## Why the environment is not good enough on its own
 *
 * An environment variable is readable by every process the user runs, appears
 * in `docker inspect` output, is dumped by most crash reporters, and reaches
 * the logs of anything that prints its own configuration for debugging. None of
 * those is fatal on a machine one person controls; all of them are the reason
 * every orchestrator grew a file-based mechanism. A file has an owner and a
 * mode, and can be removed from the filesystem after the process has read it.
 *
 * **The environment still works, unchanged.** This is an addition rather than a
 * replacement, because a single-host instance started with a `.env` is the
 * common case and telling those operators to mount files would be gratuitous.
 *
 * ## Where this sits
 *
 * Applied once, at boot, before anything reads configuration - it writes the
 * resolved values back into the environment it was given. Resolving at each
 * read instead would mean a file read on every request for anything that asks
 * for a password twice, and would leave the two sources able to disagree
 * halfway through a request.
 */

import { readFileSync } from 'node:fs'

/** What a resolution pass found, for the boot check to report. */
export interface SecretFinding {
  variable: string
  file: string
  problem: string
}

export interface SecretResolution {
  /** Variables filled in from a file, by name. */
  resolved: string[]
  /** Files that were named and could not be read. */
  problems: SecretFinding[]
}

/**
 * Fill in `NAME` from `NAME_FILE`, for every `_FILE` variable present.
 *
 * Mutates the object it is given, which is `process.env` in production and a
 * plain object in a test. Returns what it did, so the boot check can say so
 * rather than leaving an operator to guess whether their mount worked.
 */
export function resolveSecretFiles(
  env: Record<string, string | undefined>,
  read: (path: string) => string = path => readFileSync(path, 'utf8'),
): SecretResolution {
  const resolved: string[] = []
  const problems: SecretFinding[] = []

  for (const key of Object.keys(env)) {
    if (!key.endsWith('_FILE'))
      continue

    const target = key.slice(0, -'_FILE'.length)

    // `_FILE` on its own is not a variable name, and neither is something whose
    // target is already the empty string.
    if (!target)
      continue

    const path = String(env[key] ?? '').trim()

    if (!path)
      continue

    /*
     * The environment wins when both are set, and that is deliberate.
     *
     * The usual reason both exist is somebody overriding a mounted secret for
     * one run - `DB_PASSWORD=... docker compose up` against an image whose
     * compose file mounts the file. Making the file win would make that
     * override silently do nothing, which is the worst outcome available: the
     * operator believes they are testing one credential and are testing
     * another.
     */
    if (String(env[target] ?? '').trim())
      continue

    try {
      /*
       * Trailing whitespace is stripped, and only trailing.
       *
       * Every editor and most secret managers put a newline at the end of a
       * file, and a password with a trailing newline fails to authenticate
       * against a server that is otherwise configured perfectly - which is a
       * genuinely miserable hour, because the value looks right everywhere it
       * is printed. A leading space is not stripped: it could be part of the
       * secret, and there is no convention that produces one by accident.
       */
      const value = read(path).replace(/[\r\n]+$/, '')

      if (!value) {
        problems.push({ variable: target, file: path, problem: 'is empty' })
        continue
      }

      env[target] = value
      resolved.push(target)
    }
    catch (error) {
      /*
       * Recorded rather than thrown, and the caller decides.
       *
       * A missing secret file is nearly always a mount that did not happen, and
       * the useful behaviour is a boot check that says which file - not a stack
       * trace from whichever line first wanted the password. `instance:check`
       * treats it as fatal, which is where that decision belongs.
       */
      problems.push({
        variable: target,
        file: path,
        problem: error instanceof Error && 'code' in error && (error as any).code === 'ENOENT'
          ? 'does not exist'
          : `cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  return { resolved, problems }
}
