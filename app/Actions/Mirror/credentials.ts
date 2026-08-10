/**
 * The credential a mirror uses, and the two ways it must never escape.
 *
 * `repository_mirrors.credential_ref` is a *reference*: `acme` names the
 * environment variable `MIRROR_TOKEN_ACME`, or the file
 * `MIRROR_TOKEN_ACME_FILE` points at. The token itself is never on the row, so
 * a database dump, a backup, or a support export of the mirrors table carries
 * nothing anybody can use.
 *
 * ## Both halves need it, and only one had it
 *
 * The metadata sync resolved a token and the git fetch did not, so a private
 * mirror imported its issues perfectly and cloned nothing - which reads as "the
 * repository is empty" rather than as "the credential never reached git". One
 * resolver here, used by both, is what stops the two drifting again.
 *
 * ## A token in a URL is a token in the error message
 *
 * git is handed the credential in the remote URL, because the alternative is
 * writing it into a config file where it lives in every backup. The cost is
 * that git prints that URL back in its own errors - and the mirror row stores
 * the last error, and the interface shows it. So `redact` exists and every path
 * that records a git failure goes through it. This is not hypothetical: the
 * usual first failure of a private mirror is a 403, and the message quoting it
 * would put a live token on a page.
 */

import process from 'node:process'

/**
 * The token a reference names, from the environment or from a file.
 *
 * `MIRROR_TOKEN_ACME` or `MIRROR_TOKEN_ACME_FILE`, the same pair the rest of
 * this instance's secrets use - a file has an owner and a mode, and is what
 * Docker secrets, Kubernetes projected volumes and systemd credentials all
 * produce. An unreferenced mirror falls back to `GITHUB_TOKEN`, which is what a
 * single-owner instance mirroring its own repositories has.
 */
export async function mirrorToken(credentialRef: string | null | undefined): Promise<string | null> {
  const ref = String(credentialRef ?? '').trim()

  if (!ref)
    return String(process.env.GITHUB_TOKEN ?? '') || null

  const name = `MIRROR_TOKEN_${ref.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
  const direct = String(process.env[name] ?? '').trim()

  if (direct)
    return direct

  const path = String(process.env[`${name}_FILE`] ?? '').trim()

  if (!path)
    return null

  try {
    // Trimmed, because every mechanism that writes a secret to a file writes a
    // trailing newline and a token with one is a token the server rejects with
    // a message about authentication rather than about whitespace.
    return (await Bun.file(path).text()).trim() || null
  }
  catch {
    return null
  }
}

/**
 * A clone URL carrying the credential, or the plain one when there is none.
 *
 * The username is `x-access-token`, which is what GitHub expects for a token
 * and what every other forge ignores. Only `https` is touched: an `ssh://`
 * remote authenticates with a key and adding a password to it would produce a
 * URL git cannot parse.
 */
export function authenticatedUrl(remoteUrl: string, token: string | null): string {
  const url = String(remoteUrl ?? '')

  if (!token || !/^https?:\/\//i.test(url))
    return url

  try {
    const parsed = new URL(url)

    // A URL that already carries credentials is left alone. Somebody who put
    // them there on purpose knows something we do not, and overwriting them
    // would break a mirror that was working.
    if (parsed.username || parsed.password)
      return url

    parsed.username = 'x-access-token'
    parsed.password = token

    return parsed.toString()
  }
  catch {
    return url
  }
}

/**
 * Whatever git said, with any credential taken out of it.
 *
 * git echoes the remote URL in most of its failures, and a mirror's last error
 * is stored on the row and shown in the interface. Without this, the ordinary
 * first failure of a private mirror - a 403 from a token that has expired -
 * writes a live credential into the database and onto a page.
 *
 * Both shapes are removed: `https://user:token@host` from a URL git is quoting,
 * and any bare occurrence of the token itself, because git does not always
 * quote the whole URL.
 */
export function redact(message: string, token?: string | null): string {
  let text = String(message ?? '')

  // `scheme://anything:anything@` becomes `scheme://***@`. Non-greedy, so a
  // message quoting two URLs has both cleaned rather than everything between
  // the first and last collapsed.
  text = text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*:[^\s/@]*@/gi, '$1***@')

  const secret = String(token ?? '').trim()

  if (secret.length >= 8)
    text = text.split(secret).join('***')

  return text
}
