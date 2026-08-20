import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { auditEvent } from '../../Audit/events'
import { auditFrom } from '../Git/audit'
import { authorizeRepository } from './authorize'
import { decideRule, settingsOf } from './branchRules'
import { coerced } from '../inputs'

/**
 * Who may push, as this endpoint's two spellings of it.
 *
 * An API client sends `push_restrictions` as GitHub does - one object with
 * `users` and `teams`. A browser form cannot send an object, so the settings
 * page sends two text fields instead, and they are assembled here rather than
 * in `decideRule`: the rules module takes one shape and stays testable, and the
 * knowledge that an HTML form has to spell it differently stays at the door.
 */
function restrictionsFrom(request: RequestInstance): unknown {
  const whole = request.get('push_restrictions')

  if (whole !== undefined && whole !== null && whole !== '')
    return whole

  const users = request.get('push_restrictions_users')
  const teams = request.get('push_restrictions_teams')

  if (users === undefined && teams === undefined)
    return undefined

  return { users: users ?? '', teams: teams ?? '' }
}

/**
 * Create, change, or remove a protected branch rule.
 *
 * The enforcement side of this has been in place since phase 2: the receive
 * hook refuses a force push at a protected branch, and the merge action holds a
 * pull request until the required approvals and checks are there. What did not
 * exist was any way to *write* a rule, so every protection on every instance
 * would have had to be inserted by hand into `protected_branches`. Enforcement
 * without management is a feature nobody can turn on.
 *
 * **`branch:protect`**, which has sat in `app/Permissions.ts` and
 * `app/TokenScopes.ts` since the permission table was written and was checked
 * by nothing, because the endpoint it was declared for did not exist. It is the
 * maintain rung, beside renaming: removing a rule is removing the thing that
 * stops history being rewritten, so it belongs with the acts that can lose work
 * rather than with the ones that rearrange it.
 *
 * One endpoint with an `operation`, like the label and deploy key sets: a
 * browser form can only send GET or POST, and every write here goes through
 * one.
 */
export default new Action({
  name: 'ManageProtectedBranch',
  description: 'Create, change, or remove a protected branch rule',
  method: 'POST',

  /*
   * Declared so the document can publish them: every key is one the handler
   * reads.
   *
   * **These are enforced, not descriptive**, and the note that used to sit here
   * said the opposite - "this describes the inputs rather than changing what
   * the endpoint accepts". It changes what the endpoint accepts. Declaring
   * `schema.string()` on `required_approvals` meant a JSON client sending the
   * obvious `{"required_approvals": 2}` was refused with
   * `Required approvals Must be a string` before the handler ran, while the
   * browser form - which sends `"2"` - worked. Nobody noticed because the form
   * is how it is used; the end-to-end suite noticed because it speaks JSON.
   *
   * So the rule has to say what `decideRule` actually takes. It coerces on
   * purpose (`Number(...)`, `readFlag`, `readChecks`) precisely so one endpoint
   * can serve a form and an API client, which means a flag arrives as `"on"`,
   * `"true"` or `true`, a count as `2` or `"2"`, and a check list as a string,
   * a JSON string, or an array. A type that admits one spelling of those is a
   * type that rejects the others.
   *
   * The values are still checked - by `decideRule`, which is where the limits
   * live and where the errors are worth reading: "Required approvals is a whole
   * number from 0 to 20" rather than "Must be a string".
   */
  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    operation: { rule: schema.string() },
    pattern: { rule: schema.string() },
    allow_deletion: { rule: coerced },
    allow_force_push: { rule: coerced },
    dismiss_stale_reviews: { rule: coerced },
    require_conversation_resolution: { rule: coerced },
    require_human_approval_for_agents: { rule: coerced },
    require_linear_history: { rule: coerced },
    required_approvals: { rule: coerced },
    required_checks: { rule: coerced },
    require_up_to_date: { rule: coerced },
    enforce_admins: { rule: coerced },
    push_restrictions: { rule: coerced },
    // The form's two spellings of the same field. Declared because every key
    // the handler reads is declared, and the document publishes the list -
    // a field a client cannot discover is a field nobody uses.
    push_restrictions_users: { rule: coerced },
    push_restrictions_teams: { rule: coerced },
  },

  async handle(request: RequestInstance) {
    const auth = await authorizeRepository(request, 'branch:protect')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user } = auth.context
    const repositoryId = Number(repository.id)
    const scope = {
      repositoryId,
      organizationId: String(repository.owner_type) === 'organization' ? Number(repository.owner_id) : null,
    }

    const operation = String(request.get('operation') ?? 'save').trim()

    if (operation === 'delete') {
      const pattern = String(request.get('pattern') ?? '').trim()

      if (!pattern)
        return response.json({ error: 'Which rule?' }, 422)

      // Read for the record. Afterwards there is nothing left to say what the
      // rule required, and "a rule was removed" answers none of the questions
      // somebody asks after a branch turns out to have been unprotected.
      const existing = await db
        .selectFrom('protected_branches')
        .selectAll()
        .where('repository_id', '=', repositoryId)
        .where('pattern', '=', pattern)
        .executeTakeFirst()

      if (!existing)
        return response.json({ error: 'No rule for that pattern' }, 404)

      await db
        .deleteFrom('protected_branches')
        .where('repository_id', '=', repositoryId)
        .where('pattern', '=', pattern)
        .execute()

      /*
       * The event with the most to answer for in this whole set.
       *
       * A force push at an unprotected branch is not recorded anywhere - it is
       * an ordinary push - so if the rule can be removed silently, the sequence
       * "remove the protection, rewrite the history, put it back" leaves no
       * trace at all. The removal is the only part of that a log can catch, and
       * the settings it carries are what shows the rule came back different.
       */
      await auditEvent('branch:protection-removed', {
        subject: { type: 'protected_branch', id: Number(existing.id) },
        actorId: user?.id ?? null,
        ...await auditFrom(request),
        ...scope,
        detail: { pattern, was: settingsOf(existing) },
      })

      return response.json({ deleted: true, pattern })
    }

    if (operation !== 'save')
      return response.json({ error: `Unknown operation: ${operation}` }, 422)

    const decision = decideRule({
      pattern: request.get('pattern'),
      required_approvals: request.get('required_approvals'),
      dismiss_stale_reviews: request.get('dismiss_stale_reviews'),
      require_conversation_resolution: request.get('require_conversation_resolution'),
      required_checks: request.get('required_checks'),
      allow_force_push: request.get('allow_force_push'),
      allow_deletion: request.get('allow_deletion'),
      require_linear_history: request.get('require_linear_history'),
      require_human_approval_for_agents: request.get('require_human_approval_for_agents'),
      require_up_to_date: request.get('require_up_to_date'),
      /*
       * Passed through untouched, including when it is absent.
       *
       * `decideRule` distinguishes "not sent" from "sent as off" for this one
       * field, and `request.get` answering `undefined` is what carries that
       * distinction. Coercing it here - to `''`, say - would collapse the two
       * and hand an exemption to every admin the first time somebody saved a
       * rule from a client that has never heard of the setting.
       */
      enforce_admins: request.get('enforce_admins'),
      push_restrictions: restrictionsFrom(request),
    })

    if (!decision.ok)
      return response.json({ error: decision.error }, decision.status)

    const rule = decision.rule

    const existing = await db
      .selectFrom('protected_branches')
      .selectAll()
      .where('repository_id', '=', repositoryId)
      .where('pattern', '=', rule.pattern)
      .executeTakeFirst()

    // Upserted on the pattern. Two rules for `main` on one repository would
    // make the answer depend on which came back first, and the enforcement side
    // reads every matching rule - so the looser of the two would be the one
    // somebody discovers.
    if (existing) {
      await db
        .updateTable('protected_branches')
        .set(rule)
        .where('id', '=', Number(existing.id))
        .execute()
    }
    else {
      await db
        .insertInto('protected_branches')
        .values({ repository_id: repositoryId, ...rule })
        .execute()
    }

    // Both sides of the change, because the useful question is never what the
    // rule says now - that is on the settings page - but what it said before.
    await auditEvent('branch:protection-changed', {
      subject: { type: 'protected_branch', id: Number(existing?.id ?? 0) },
      actorId: user?.id ?? null,
      ...await auditFrom(request),
      ...scope,
      detail: {
        pattern: rule.pattern,
        created: !existing,
        from: existing ? settingsOf(existing) : null,
        to: settingsOf(rule),
      },
    })

    return response.json({ repository_id: repositoryId, ...rule }, existing ? 200 : 201)
  },
})
