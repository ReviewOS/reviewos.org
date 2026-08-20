/**
 * What this instance says it is, to an authorization server.
 *
 * An atproto OAuth client is identified by a URL that serves its own metadata,
 * which is a neat trick: there is no registration step and no client secret,
 * because the client id *is* the document, and an authorization server fetches
 * it to find out what the client claims. The consequence is that the document
 * has to be reachable from the internet, which a localhost instance is not - so
 * there are two shapes here, and the difference is not a shortcut but the
 * specification's own accommodation for development.
 */

import process from 'node:process'

/**
 * Where this instance lives, as a URL, without a trailing slash.
 *
 * `APP_URL` is a bare host in more than one deployment - the framework's own
 * default is `reviewos.localhost` - and every function below builds URLs from
 * it. Passing that to `new URL` throws `ERR_INVALID_URL`, which is how this was
 * found: the first time it was pointed at the real network rather than at a
 * test, it failed before reaching it.
 *
 * A missing scheme is filled in rather than rejected, and which one depends on
 * the name: a localhost address is http because nothing is serving a
 * certificate for it, and anything else is https because a sign-in redirect
 * that leaves over http is a session handed to whoever is on the path.
 */
export function appUrl(): string {
  const configured = String(process.env.APP_URL ?? 'http://localhost:3000').trim().replace(/\/$/, '')

  if (/^https?:\/\//i.test(configured))
    return configured

  const host = configured.split('/')[0] ?? ''
  const local = host === 'localhost'
    || host === '127.0.0.1'
    || host.startsWith('localhost:')
    || host.startsWith('127.0.0.1:')
    || host.endsWith('.localhost')
    || /\.localhost:\d+$/.test(host)

  return `${local ? 'http' : 'https'}://${configured}`
}

/** True when that address is one only this machine can reach. */
export function isLocal(url = appUrl()): boolean {
  try {
    const host = new URL(url).hostname

    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')
  }
  catch {
    return true
  }
}

export function redirectUri(): string {
  if (!isLocal())
    return `${appUrl()}/api/auth/atproto/callback`

  // The specification's development client uses `127.0.0.1`, and only that
  // spelling: `localhost` is refused as a redirect host because it can resolve
  // anywhere. The port is whatever this instance is actually served on.
  const port = (() => {
    try {
      return new URL(appUrl()).port || '3000'
    }
    catch {
      return '3000'
    }
  })()

  return `http://127.0.0.1:${port}/api/auth/atproto/callback`
}

/**
 * The client id: a URL that serves the metadata, or the development form.
 *
 * A public instance is identified by its own document. A local one cannot be -
 * nobody can fetch it - so the protocol lets a development client put its
 * metadata *in* the client id as query parameters, which is why this is a URL
 * with a redirect and a scope hanging off it rather than a link to a file.
 */
export function clientId(): string {
  if (!isLocal())
    return `${appUrl()}/atproto/client-metadata.json`

  const parameters = new URLSearchParams({ redirect_uri: redirectUri(), scope: 'atproto' })

  return `http://localhost?${parameters.toString()}`
}

/** The document itself, served for a public instance. */
export function clientMetadata(): Record<string, unknown> {
  return {
    client_id: clientId(),
    client_name: 'ReviewOS',
    client_uri: appUrl(),
    application_type: 'web',
    dpop_bound_access_tokens: true,
    grant_types: ['authorization_code'],
    response_types: ['code'],
    redirect_uris: [redirectUri()],
    scope: 'atproto',
    // No `token_endpoint_auth_method` beyond the default: this is a public
    // client. A confidential one would hold a signing key and publish a JWKS,
    // and holding one to prove an instance's identity buys nothing here - the
    // thing being proved is the *person's* identity, and DPoP already binds the
    // tokens to a key the browser never sees.
    token_endpoint_auth_method: 'none',
  }
}
