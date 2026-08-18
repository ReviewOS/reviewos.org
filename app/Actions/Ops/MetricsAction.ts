import { Action } from '@stacksjs/actions'
import { collectFromDatabase, render } from '../../Ops/metrics'
import { currentActor } from '../Identity/lookup'

/**
 * What this instance is doing, for a scraper.
 *
 * Prometheus exposition format, because it is what every scraper reads. A JSON
 * shape of our own would be a format each operator has to write an exporter
 * for, and a self-hosted forge should be observable with the tools people
 * already run.
 *
 * ## Not public
 *
 * A metrics endpoint says how many repositories and accounts an instance has,
 * how much traffic it takes, and when it is struggling - which is
 * reconnaissance, served conveniently. It is also the endpoint most likely to
 * be left exposed, because the scraper works either way and nothing complains.
 *
 * So: an instance administrator, or a scrape token. `METRICS_TOKEN` exists
 * because a Prometheus scrape config holds a bearer token far more comfortably
 * than it holds a session, and asking somebody to give their scraper an admin
 * account is asking for an admin account with a password in a config file.
 */
export default new Action({
  name: 'Metrics',
  description: 'Instance metrics, in Prometheus exposition format',
  method: 'GET',

  async handle(request: RequestInstance) {
    if (!await mayScrape(request)) {
      /*
       * 404, not 403. Whether this instance exposes metrics at all is itself
       * worth not confirming to a stranger, and a scraper that is configured
       * correctly never sees this.
       */
      return response.json({ error: 'Not found' }, 404)
    }

    await collectFromDatabase()

    return new Response(render(), {
      status: 200,
      headers: {
        // The version parameter matters: without it some collectors negotiate
        // protobuf and then cannot parse what comes back.
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
        // Never cached. A cached scrape is a flat graph that looks like an
        // instance doing nothing, which is indistinguishable from an outage.
        'Cache-Control': 'no-store',
      },
    })
  },
})

/** Whether this caller may read the numbers. */
async function mayScrape(request: RequestInstance): Promise<boolean> {
  const configured = String(process.env.METRICS_TOKEN ?? '').trim()

  if (configured) {
    const header = String(request?.headers?.get?.('authorization') ?? '')
    const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''

    /*
     * Constant-time, because this is a shared secret compared on every scrape
     * and a timing oracle on a fifteen-second interval is a generous one.
     * Lengths are compared first: `timingSafeEqual` throws on a mismatch, and
     * the length of a token is not the secret.
     */
    if (presented.length === configured.length) {
      const { timingSafeEqual } = await import('node:crypto')
      const encoder = new TextEncoder()

      if (timingSafeEqual(encoder.encode(presented), encoder.encode(configured)))
        return true
    }
  }

  const { user } = await currentActor(request)

  return Boolean(user?.is_admin)
}
