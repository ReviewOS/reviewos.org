import { Action } from '@stacksjs/actions'
import { protocolOf, refuseProtocol, runnerJson } from './gate'
import { authenticateJob } from './authenticate'
import { heartbeat } from './claim'

/**
 * "I am still here, and still working on this."
 *
 * The renewal that makes short leases workable. A long lease means a job held
 * by a machine that fell over is stuck for as long as the lease; a short one
 * plus this is a job that comes back within a minute of a machine going quiet.
 *
 * **A refused heartbeat is information, not an error to swallow.** It means the
 * job is no longer this runner's - the lease lapsed and somebody else took it,
 * or a person cancelled the run - and the right response on the runner's side
 * is to stop working, because anything it reports afterwards will be refused
 * anyway. So it answers 409 with the reason rather than 200 with a shrug.
 *
 * Authenticated by the **job** token minted at claim rather than by the
 * runner's registration credential, and the token names the job, so no id is
 * taken from the caller. A token matching no job is a 401: the credential is
 * gone, which is a different thing from holding one for work somebody took
 * away.
 */
export default new Action({
  name: 'RunnerHeartbeat',
  description: 'Extend the lease on a job a runner holds',
  method: 'POST',

  responses: {
    426: {
      description: 'This runner speaks a protocol version the server does not. The body says which end is behind; every answer carries X-Runner-Protocol-Supported.',
    },
    401: { description: 'No credential, or one this instance does not recognise.' },
  },

  responseHeaders: {
    'X-Runner-Protocol-Supported': {
      description: 'The protocol version, or range of versions, this server speaks. On every answer, so a runner about to be retired learns it from an ordinary poll rather than from the first request that fails.',
      schema: { type: 'string' },
    },
  },

  async handle(request: any) {
    /*
     * Before anything else, including the credential.
     *
     * A runner speaking a protocol this server does not is going to
     * misread whatever it is handed, and telling it that its token is
     * fine first only delays the confusion. The refusal names which way
     * the mismatch runs, because upgrading a fleet and upgrading a
     * server are different afternoons.
     */
    const protocol = protocolOf(request)
    if (!protocol.ok)
      return refuseProtocol(protocol)

    const held = await authenticateJob(request)
    if (!held)
      return runnerJson({ error: 'Unknown job credential' }, 401)

    const expires = await heartbeat(held.runner, held.jobId)

    if (!expires) {
      return runnerJson({
        error: 'This job is no longer yours',
        fix: 'Stop working on it. The lease lapsed, or the run was cancelled.',
      }, 409)
    }

    return runnerJson({ lease_expires_at: expires })
  },
})
