import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { INSTANCE_SCOPES, ORGANIZATION_SCOPES, REPOSITORY_SCOPES } from '../../TokenScopes'
import { canInOrganization } from '../../Permissions'
import { currentUser, organizationRoleOf } from '../Identity/lookup'
import { issueAccessToken } from './issue'

/**
 * Issue an access token.
 *
 * Shown once, in full, in this response and never again. The response also
 * echoes back the grants that were actually recorded rather than the ones that
 * were asked for, because unknown scopes are dropped rather than refused: a
 * client built against a newer instance still gets a working token, and can see
 * from this exactly what it got.
 */
export default new Action({
  name: 'CreateAccessToken',
  description: 'Issue a fine-grained access token',
  method: 'POST',

  /*
   * Declared here so the reference lists them and the validator enforces them
   * from the same object. Read against the handler rather than the field name:
   * a declared rule is enforced, so a wrong one turns an ordinary request into
   * a 422.
   */
  validations: {
    name: { rule: schema.string().required() },
    selection: { rule: schema.enum(['all', 'organization', 'selected']) },
    expires_at: { rule: schema.string() },
    organization_id: { rule: schema.number() },
    machine_account_id: { rule: schema.number() },
    // Both arrays, and both accepted in the flattened `scope_*` form the
    // settings form posts. The handler reads either.
    permissions: { rule: schema.array() },
    repository_ids: { rule: schema.array() },
  },

  responses: {
    201: { description: 'The token, shown once. It is stored as a hash, so this is the only time the value exists.' },
    401: { description: 'Unauthenticated.' },
    403: { description: 'A token for an organization or a machine account needs the right to act for it.' },
    422: { description: 'A name is required, the selection must be one of the three, and an expiry that is not a date is refused rather than ignored.' },
  },

  async handle(request: RequestInstance) {
    const caller = await currentUser(request)
    if (!caller)
      return response.json({ error: 'Unauthenticated' }, 401)

    /*
     * A token can be issued *for* a machine account by somebody who administers
     * the organization that owns it.
     *
     * Without this the feature does not work at all: a machine account cannot
     * sign in, so it can never call this endpoint as itself, and an account
     * that exists to hold tokens and cannot be given one is a row in a table.
     *
     * It is narrow on purpose. Only an account that is a machine, only for the
     * organization it belongs to, and only by somebody who administers that
     * organization - so this is not a general "issue a token as another user",
     * which is what it would become if any of the three were relaxed.
     */
    const machine = await machineAccountFor(request, caller.id)
    if (machine.error)
      return response.json({ error: machine.error }, machine.status)

    const user = machine.account ?? caller

    // A date that does not parse arrives as NaN and is refused rather than
    // replaced with the default: a client that sent one meant something by it.
    const requestedExpiry = request.get('expires_at')
      ? Date.parse(String(request.get('expires_at')))
      : null

    /*
     * The rules - a name, a known selection, at least one known grant, an
     * expiry inside the ceiling, an organization the owner belongs to,
     * repositories the owner can read - live in `issueAccessToken`, which
     * `buddy token:create` calls too.
     */
    const issued = await issueAccessToken({
      userId: user.id,
      name: String(request.get('name') ?? ''),
      selection: String(request.get('selection') ?? 'selected'),
      organizationId: request.get('organization_id') === undefined ? null : Number(request.get('organization_id')),
      repositoryIds: readRepositoryIds(request),
      permissions: readPermissions(request),
      expiresAtMs: requestedExpiry,
      limits: hourlyLimits(request),
    })

    if (!issued.ok)
      return response.json({ error: issued.error }, issued.status)

    // The only time the secret is ever returned.
    return response.json(issued.token, 201)
  },
})

/**
 * The grants asked for, however they were asked for.
 *
 * A JSON client sends `permissions: [{ scope, level }]`, which is the shape the
 * API documents and the shape `normalizeGrants` wants. A browser form cannot
 * send that: an HTML form posts flat pairs, and a repeated field name arrives
 * as one value or as a list depending on the body parser, which is not
 * something a settings page should be betting on.
 *
 * So the form sends one field per scope - `scope_contents=write` - which is
 * flat, unambiguous, and reads correctly in a request log. Unknown scopes and
 * levels are left to `normalizeGrants` to drop, exactly as they are for a JSON
 * client, so there is one place that decides what a valid grant is.
 *
 * The alternative was a second endpoint for the browser, which would have meant
 * two implementations of issuing a token and one of them getting a fix.
 */
function readPermissions(request: RequestInstance): { scope: string, level: string }[] {
  const requested = request.get('permissions')
  if (Array.isArray(requested))
    return requested

  const grants: { scope: string, level: string }[] = []

  for (const scope of [...REPOSITORY_SCOPES, ...ORGANIZATION_SCOPES, ...INSTANCE_SCOPES]) {
    const level = request.get(`scope_${scope}`)
    if (!level)
      continue

    const value = String(level)
    // The form's "no access" option, which is how somebody turns a scope off
    // rather than by leaving a field out and hoping.
    if (value === 'none')
      continue

    grants.push({ scope, level: value })
  }

  return grants
}

/**
 * The repository ids asked for, from either shape.
 *
 * A form sends `repository_ids=3,7`, because checkboxes have the same repeated
 * name problem and a comma-separated list survives every parser.
 */
function readRepositoryIds(request: RequestInstance): unknown[] {
  const requested = request.get('repository_ids')
  if (Array.isArray(requested))
    return requested

  if (requested === null || requested === undefined || requested === '')
    return []

  return String(requested).split(',').map(part => part.trim()).filter(Boolean)
}

/**
 * The machine account this token is being issued for, if any.
 *
 * Three conditions, all required, and each one is the difference between this
 * and a general "issue a token as somebody else":
 *
 * - the target is a machine account, so no person's identity can be borrowed;
 * - the caller administers the organization that owns it, so it is theirs to
 *   act for;
 * - the machine belongs to that organization, so an administrator of one
 *   organization cannot reach another's.
 */
async function machineAccountFor(
  request: any,
  callerId: number,
): Promise<{ account?: { id: number, handle: string }, error?: string, status?: number }> {
  const requested = request.get('machine_account_id')
  if (requested === undefined || requested === null || requested === '')
    return {}

  const machineId = Number(requested)
  if (!Number.isInteger(machineId) || machineId <= 0)
    return { error: 'A machine account id has to be a number', status: 422 }

  const account = await db
    .selectFrom('users')
    .select(['id', 'handle', 'machine_for_organization_id'])
    .where('id', '=', machineId)
    .executeTakeFirst()

  // Not found rather than forbidden for all three failures, including "that is
  // a person". The alternative lets somebody enumerate which accounts are
  // machines, which is a list of where the standing credentials are.
  if (!account?.machine_for_organization_id)
    return { error: 'No such machine account', status: 404 }

  const organizationId = Number(account.machine_for_organization_id)
  const role = await organizationRoleOf(organizationId, callerId)

  if (!canInOrganization(role, 'settings:manage'))
    return { error: 'No such machine account', status: 404 }

  return { account: { id: Number(account.id), handle: String(account.handle) } }
}

/**
 * The hourly creation budgets this token was issued with.
 *
 * Absent means the instance default, which is why an unspecified field is left
 * out of the insert rather than written as null: the two are the same value
 * today and would stop being the same if a column ever gained a default, and a
 * token silently granted a different budget from the one its owner chose is the
 * failure this whole feature exists to prevent.
 *
 * Zero is kept. "This token may not open pull requests" is a reasonable thing
 * to say, and rounding it away to the default would do the opposite.
 */
function hourlyLimits(request: RequestInstance): Record<string, number> {
  const columns: Record<string, string> = {
    limit_pull_requests_per_hour: 'limit_pull_requests_per_hour',
    limit_comments_per_hour: 'limit_comments_per_hour',
    limit_reviews_per_hour: 'limit_reviews_per_hour',
  }

  const values: Record<string, number> = {}

  for (const column of Object.keys(columns)) {
    const raw = request.get(column)
    if (raw === undefined || raw === null || raw === '')
      continue

    const parsed = Number(raw)
    // A limit that is not a number is ignored rather than refused. It arrives
    // from a form field and the cost of being wrong here is a token with the
    // default budget, which is the same thing not sending it does.
    if (Number.isFinite(parsed) && parsed >= 0)
      values[column] = Math.floor(parsed)
  }

  return values
}
