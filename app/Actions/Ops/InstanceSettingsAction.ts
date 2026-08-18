import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { apiError } from '../../Api/errors'
import { allSettings, decideSetting, SETTINGS, writeSetting } from '../../Ops/settings'
import { currentActor } from '../Identity/lookup'

/**
 * Read and change the settings that do not warrant a redeploy.
 *
 * One endpoint for both, and the read is the more useful half: it returns each
 * setting **with its definition** - the type, the allowed values, what it does,
 * and the file that enforces it. A settings API that returns bare values makes
 * whoever builds a page for it hard-code the same list a second time, and the
 * second copy is the one that goes stale.
 *
 * **Instance administrators only, both ways.** These are not per-account
 * preferences: `registration` decides whether strangers can sign up, and
 * `max_repositories_per_user` decides what everybody's account is worth. A
 * stranger gets a 404 rather than a 403, since whether an endpoint exists is
 * not something to confirm to somebody who may not use it.
 *
 * Every change is in the audit log, through the same listener as everything
 * else. A settings table without one answers "it has always been like that" to
 * the only question anybody asks of it.
 */
export default new Action({
  name: 'InstanceSettings',
  description: 'Read the instance settings, or change one',
  method: 'POST',

  validations: {
    key: { rule: schema.string() },
    value: { rule: schema.string() },
  },

  async handle(request: RequestInstance) {
    const { user } = await currentActor(request)

    if (!user?.is_admin)
      return apiError('not_found', 'No such endpoint')

    const key = String(request.get('key') ?? '').trim()

    // No key means a read. A separate GET route would be tidier and would also
    // be a second place the administrator check has to be right.
    if (!key)
      return response.json({ settings: await describeAll() })

    const decision = decideSetting(key, request.get('value'))

    if (!decision.ok)
      return response.json({ error: decision.error }, decision.status)

    const before = (await allSettings())[decision.key]

    await writeSetting(decision.key, decision.value, user.id)

    /*
     * Recorded even when nothing changed.
     *
     * Somebody setting a value to what it already was is somebody who believed
     * it was something else, and that is worth knowing when the question later
     * is who thought registration was closed.
     */
    const { auditEvent } = await import('../../Audit/events')
    const { auditFrom } = await import('../Git/audit')

    await auditEvent('instance:setting-changed', {
      subject: { type: 'instance_setting', id: 0 },
      actorId: user.id,
      ...await auditFrom(request),
      detail: { key: decision.key, from: before, to: decision.value },
    })

    return response.json({ key: decision.key, value: decision.value })
  },
})

/** Every setting, as a value beside the thing that defines it. */
async function describeAll(): Promise<Array<Record<string, unknown>>> {
  const values = await allSettings()

  return Object.entries(SETTINGS).map(([key, definition]) => ({
    key,
    value: values[key as keyof typeof SETTINGS],
    type: definition.type,
    fallback: definition.fallback,
    describes: definition.describes,
    enforced_in: definition.enforcedIn,
    ...('allowed' in definition ? { allowed: definition.allowed } : {}),
    ...('min' in definition ? { min: definition.min, max: definition.max } : {}),
  }))
}
