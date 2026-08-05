import { Action } from '@stacksjs/actions'
import { authorizeRepository } from '../Repo/authorize'
import { recountOpenIssues } from '../Repo/counters'
import { abilityFor, isBulkOperation, selectedNumbers } from './bulk'

/**
 * Close, reopen, label, unlabel or set a milestone on several issues at once.
 *
 * Triage is a bulk activity - somebody works down a list applying the same
 * label to eight things - and doing it one page load at a time is why it does
 * not get done.
 *
 * Each operation asks for the ability it would need on its own, so nothing is
 * reachable in bulk that is not reachable singly. That mapping lives in
 * `bulk.ts` rather than in a branch here, because a permission check written
 * per branch is a permission check that eventually gets missed on one.
 */
export default new Action({
  name: 'BulkUpdateIssues',
  description: 'Apply one change to several issues',
  method: 'POST',

  async handle(request: any) {
    const operation = String(request.get('operation') ?? '')
    if (!isBulkOperation(operation))
      return response.json({ error: 'That is not something this can do' }, 422)

    const auth = await authorizeRepository(request, abilityFor(operation))
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user } = auth.context
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const selection = selectedNumbers(request.get('numbers'))
    if (!selection.ok)
      return response.json({ error: selection.error }, 422)

    // Resolved to rows first, so an issue number from another repository - or a
    // pull request number, which shares the sequence - cannot be acted on by
    // being named here.
    const issues: any[] = await db
      .selectFrom('issues')
      .select(['id', 'number', 'state'])
      .where('repository_id', '=', repository.id)
      .where('number', 'in', selection.numbers)
      .where('is_pull_request', '=', false)
      .execute()

    if (issues.length === 0)
      return response.json({ error: 'None of those are issues on this repository' }, 404)

    const ids = issues.map(row => Number(row.id))

    if (operation === 'close' || operation === 'reopen')
      return setState(issues, ids, operation === 'close', Number(user.id), repository.id)

    if (operation === 'milestone')
      return setMilestone(ids, request.get('milestone_id'), repository.id)

    return setLabel(ids, request.get('label'), repository.id, operation === 'label')
  },
})

/**
 * Close or reopen, counting only the ones that actually moved.
 *
 * The repository's open-issue counter moves by the number that changed rather
 * than by the number selected: closing eight issues of which three were already
 * closed is a change of five, and a counter that drifts is worse than no
 * counter because it looks authoritative.
 */
async function setState(issues: any[], ids: number[], closing: boolean, actorId: number, repositoryId: number) {
  const moving = issues.filter(row => (String(row.state) === 'open') === closing)
  if (moving.length === 0)
    return response.json({ changed: [], operation: closing ? 'close' : 'reopen' })

  const movingIds = moving.map(row => Number(row.id))

  await db
    .updateTable('issues')
    .set(closing
      ? { state: 'closed', state_reason: 'completed', closed_at: new Date().toISOString(), closed_by_id: actorId }
      : { state: 'open', state_reason: null, closed_at: null, closed_by_id: null })
    .where('id', 'in', movingIds)
    .execute()

  await recountOpenIssues(repositoryId)

  return response.json({
    changed: moving.map(row => Number(row.number)),
    // Named so a caller can tell "nothing matched" from "everything was already
    // in that state", which look identical in the list of changes.
    unchanged: ids.length - movingIds.length,
    operation: closing ? 'close' : 'reopen',
  })
}

async function setMilestone(ids: number[], requested: unknown, repositoryId: number) {
  const clearing = requested === undefined || requested === null || String(requested).trim() === ''
  let milestoneId: number | null = null

  if (!clearing) {
    const milestone = await db
      .selectFrom('milestones')
      .select(['id'])
      .where('id', '=', Number(requested))
      .where('repository_id', '=', repositoryId)
      .executeTakeFirst()

    // A milestone from another repository would file these issues under
    // something that does not belong to them.
    if (!milestone)
      return response.json({ error: 'No such milestone' }, 422)

    milestoneId = Number(milestone.id)
  }

  await db.updateTable('issues').set({ milestone_id: milestoneId }).where('id', 'in', ids).execute()

  return response.json({ changed: ids.length, milestone_id: milestoneId })
}

/**
 * Add or remove one label across the selection.
 *
 * Resolved by name within the repository, matching how the new-issue form
 * sends labels: a name is what a form can honestly carry, and an id from
 * another repository's set would otherwise attach a foreign label.
 */
async function setLabel(ids: number[], requested: unknown, repositoryId: number, adding: boolean) {
  const name = String(requested ?? '').trim()
  if (!name)
    return response.json({ error: 'No label was given' }, 422)

  const labels: any[] = await db
    .selectFrom('repository_labels')
    .select(['id', 'name'])
    .where('repository_id', '=', repositoryId)
    .execute()

  const label = labels.find(row => String(row.name).toLowerCase() === name.toLowerCase())
  if (!label)
    return response.json({ error: 'No such label' }, 422)

  const labelId = Number(label.id)

  if (!adding) {
    await db.deleteFrom('issue_labels').where('label_id', '=', labelId).where('issue_id', 'in', ids).execute()

    return response.json({ changed: ids.length, label: String(label.name), added: false })
  }

  // Already-labelled issues are skipped rather than inserted again: the join
  // table has no unique index to lean on, and a duplicate row shows the same
  // label twice on the issue.
  const existing: any[] = await db
    .selectFrom('issue_labels')
    .select(['issue_id'])
    .where('label_id', '=', labelId)
    .where('issue_id', 'in', ids)
    .execute()

  const already = new Set(existing.map(row => Number(row.issue_id)))
  const missing = ids.filter(id => !already.has(id))

  if (missing.length > 0) {
    await db
      .insertInto('issue_labels')
      .values(missing.map(id => ({ issue_id: id, label_id: labelId })))
      .execute()
  }

  return response.json({ changed: missing.length, label: String(label.name), added: true })
}
