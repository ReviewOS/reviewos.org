import { Action } from '@stacksjs/actions'
import { appendAttachments } from '../Attachment/upload'
import { allocateNumber, authorizeRepository } from '../Repo/authorize'
import { recountOpenIssues } from '../Repo/counters'
import { recordCrossReferences } from './crossReferences'

/**
 * Open an issue.
 *
 * The number is allocated from the repository's shared counter before the
 * insert, so an issue and a pull request never collide on `#12`.
 */
export default new Action({
  name: 'CreateIssue',
  description: 'Open an issue on a repository',
  method: 'POST',

  async handle(request: any) {
    // Anyone who can read a repository may open an issue on it; that is what
    // makes an issue tracker useful to people who are not contributors.
    const auth = await authorizeRepository(request, 'issue:open')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user } = auth.context
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const title = String(request.get('title') ?? '').trim()
    if (!title)
      return response.json({ error: 'An issue needs a title' }, 422)

    if (title.length > 255)
      return response.json({ error: 'That title is too long' }, 422)

    const milestoneId = request.get('milestone_id') ? Number(request.get('milestone_id')) : null
    if (milestoneId !== null) {
      const milestone = await db
        .selectFrom('milestones')
        .select(['id'])
        .where('id', '=', milestoneId)
        .where('repository_id', '=', repository.id)
        .executeTakeFirst()

      // A milestone from another repository would show this issue in a list it
      // does not belong to.
      if (!milestone)
        return response.json({ error: 'No such milestone' }, 422)
    }

    const number = await allocateNumber(repository.id)

    // The screenshot is usually the report. Stored here and appended to the
    // body, because the form has no editor to insert a link into: picking a
    // file and submitting is the whole interaction.
    const files = request.getFiles?.('attachments') ?? []
    const uploaded = files.length > 0
      ? await appendAttachments(String(request.get('body') ?? ''), files, Number(repository.id), user.id)
      : { body: String(request.get('body') ?? ''), attached: [] as string[], refused: [] as string[] }

    const created = await db
      .insertInto('issues')
      .values({
        repository_id: repository.id,
        number,
        title,
        body: uploaded.body,
        author_id: user.id,
        state: 'open',
        milestone_id: milestoneId,
        locked: false,
        comments_count: 0,
        is_pull_request: false,
      })
      .returning(['id'])
      .executeTakeFirst()

    await recountOpenIssues(Number(repository.id))

    // Labels chosen while writing. Applying a label is normally a triage
    // power, and it still is: this only lets somebody label the issue they are
    // opening, with labels that already exist on this repository. Names that
    // do not match are ignored rather than rejected, because losing a whole
    // report over a stale label in a bookmarked form is the wrong trade.
    const applied = await applyLabels(Number(created?.id), repository.id, request.get('labels'))

    // A new report often opens by naming the issue it follows on from, and that
    // link is worth more on the older issue than on this one.
    const references = await recordCrossReferences(
      { subject: { type: 'issue', id: Number(created?.id) }, number, repositoryId: repository.id },
      user.id,
      uploaded.body,
    )

    return response.json({
      id: Number(created?.id),
      number,
      title,
      state: 'open',
      labels: applied,
      references,
      attachments: uploaded.attached,
      refused: uploaded.refused,
      url: `/${request.get('owner')}/${repository.name}/issue/${number}`,
    }, 201)
  },
})

/**
 * Attach the requested labels, resolved by name within this repository.
 *
 * By name rather than by id because that is what a form can honestly send: an
 * id from another repository's label set would otherwise attach it here, and
 * checking the ids costs the same query as resolving the names.
 */
async function applyLabels(issueId: number, repositoryId: number, requested: unknown): Promise<string[]> {
  if (!issueId)
    return []

  const names = (Array.isArray(requested) ? requested : [requested])
    .filter(value => value !== undefined && value !== null && String(value).trim() !== '')
    .map(value => String(value).trim().toLowerCase())

  if (names.length === 0)
    return []

  const labels: any[] = await db
    .selectFrom('repository_labels')
    .select(['id', 'name'])
    .where('repository_id', '=', repositoryId)
    .execute()

  const matched = labels.filter(row => names.includes(String(row.name).toLowerCase()))
  if (matched.length === 0)
    return []

  await db
    .insertInto('issue_labels')
    .values(matched.map(row => ({ issue_id: issueId, label_id: Number(row.id) })))
    .execute()

  return matched.map(row => String(row.name))
}
