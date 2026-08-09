import { Middleware } from '@stacksjs/router'
import { increment, observe } from '../Ops/metrics'

/**
 * Count and time every request.
 *
 * The middleware pipeline runs before the action, so the status and the
 * duration are not knowable from here - they are recorded through
 * `_afterResponse`, the router's hook for exactly this, added upstream because
 * the alternatives were wrapping every action or reading the status back out of
 * a header getter.
 *
 * **The route pattern is the label, never the URL.** `/{owner}/{repository}` is
 * one series; the path as typed is one series per repository, which on a forge
 * with two hundred of them is a cardinality explosion that takes the scraper
 * down. Turning a metrics endpoint into an outage this way is common enough to
 * be the first thing to get right.
 *
 * The status is recorded as a *class* - `2xx`, `4xx`, `5xx` - for the same
 * reason. The question anybody asks of this is "are we serving errors", and
 * that needs three values rather than sixty.
 */
export default new Middleware({
  name: 'measure',
  // After throttle, so a refused flood is not counted as served work.
  priority: 2,

  async handle(request: any) {
    const method = String(request?.method ?? 'GET').toUpperCase()
    const route = routePattern(request)

    const callbacks = Array.isArray(request._afterResponse) ? request._afterResponse : []

    callbacks.push((outcome: { status: number, durationMs: number }) => {
      const labels = { method, route, status: statusClass(outcome.status) }

      increment('reviewos_http_requests_total', labels)
      observe('reviewos_http_request_seconds', Math.max(0, outcome.durationMs) / 1000, { method, route })
    })

    request._afterResponse = callbacks
  },
})

/** `2xx`, `4xx`, `5xx`. Three values, because that is the question being asked. */
function statusClass(status: number): string {
  if (!Number.isFinite(status) || status <= 0)
    return 'unknown'

  return `${Math.floor(status / 100)}xx`
}

/**
 * The route as registered, not as typed.
 *
 * `/acme/api.git/info/refs` becomes the registered pattern, so the series count
 * is bounded by the number of routes rather than by the number of repositories.
 *
 * The fallback is the *first path segment* rather than the path, because a
 * fallback that used the path would reintroduce exactly the explosion this
 * exists to prevent - and would do it only on the routes nobody anticipated,
 * which is where it hurts most.
 */
function routePattern(request: any): string {
  const registered = String(request?._routePattern ?? request?.route?.path ?? '').trim()
  if (registered)
    return registered

  try {
    const first = new URL(String(request.url)).pathname.split('/').filter(Boolean)[0]

    return first ? `/${first}` : '/'
  }
  catch {
    return 'unknown'
  }
}
