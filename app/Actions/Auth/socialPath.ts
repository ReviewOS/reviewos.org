/**
 * Read the provider from a social-auth route regardless of its mount prefix.
 *
 * The API route is registered as `/auth/{provider}` and mounted at `/api`, so
 * the request path in production is `/api/auth/{provider}`. Reading a fixed
 * segment mistakes `auth` for the provider as soon as that prefix is present.
 */
export function providerNameFromAuthPath(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean)
  const auth = segments.lastIndexOf('auth')

  return auth >= 0 ? segments[auth + 1] ?? '' : ''
}
