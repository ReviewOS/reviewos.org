import { Action } from '@stacksjs/actions'
import { auditEvent } from '../../Audit/events'
import { auditFrom } from '../Git/audit'
import { authorizeRepository } from './authorize'
import { decideRule, settingsOf } from './branchRules'

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

  async handle(request: any) {
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
