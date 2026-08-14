import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { appendAttachments } from '../Attachment/upload'
import { userReferences } from '../Markdown/references'
import { authorizeRepository } from '../Repo/authorize'
import { recountComments } from '../Repo/counters'
import { recordCrossReferences } from './crossReferences'
import { mayComment } from './state'

/**
 * Comment on an issue or a pull request.
 *
 * Both live in the same table, so this one action serves both and a pull
 * request conversation is an issue conversation, which is what makes
 * `#12` resolve either way.
 */
export default new Action({
  name: 'CommentOnIssue',
  description: 'Add a comment to an issue or pull request',
  method: 'POST',

  /*
   * Declared here so the reference lists them and the validator enforces them
   * from the same object. `owner` plus one of `repo` or `repository` addresses
   * every repository-scoped endpoint - see `authorizeRepository` - and a caller
   * who forgets one should be told which field is missing rather than shown a
   * 404 that reads as "no such repository".
   */
  validations: {
    owner: { rule: schema.string().required() },
    repo: { rule: schema.string() },
    repository: { rule: schema.string() },
    number: { rule: schema.number().required() },
    body: { rule: schema.string().required() },
  },

  responses: {
    201: { description: 'The comment, rendered.' },
    401: { description: 'Unauthenticated.' },
    403: { description: 'The issue is locked, and this caller is not somebody who may comment on a locked issue.' },
    422: { description: 'An empty comment. Nothing is not a remark.' },
    404: { description: 'No such repository or issue, or none this caller may see. A private repository answers this rather than 403, because a 403 confirms it exists.' },
  },

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'issue:comment')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user, can } = auth.context
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const written = String(request.get('body') ?? '').trim()
    const files = request.getFiles?.('attachments') ?? []

    // A comment that is only a screenshot is a comment. Requiring words as well
    // would mean somebody attaching the picture that explains the bug has to
    // type "here" first.
    if (!written && files.length === 0)
      return response.json({ error: 'A comment needs a body' }, 422)

    const number = Number(request.get('number'))
    const issue = await db
      .selectFrom('issues')
      .select(['id', 'locked', 'is_pull_request'])
      .where('repository_id', '=', repository.id)
      .where('number', '=', number)
      .executeTakeFirst()

    if (!issue)
      return response.json({ error: 'No such issue' }, 404)

    if (!mayComment({ locked: Boolean(issue.locked), isMaintainer: can('issue:close') }))
      return response.json({ error: 'This conversation is locked' }, 423)

    // Stored now, and their markdown appended to what was written. The page
    // runs no client-side JavaScript, so there is no editor to insert a link
    // into: picking a file next to the comment box and submitting is the whole
    // interaction. A file that is refused does not lose somebody the paragraphs
    // they wrote, so the refusal travels back beside the comment.
    const uploaded = files.length > 0
      ? await appendAttachments(written, files, Number(repository.id), user.id)
      : { body: written, attached: [] as string[], refused: [] as string[] }

    const body = uploaded.body
    if (!body)
      return response.json({ error: uploaded.refused[0] ?? 'A comment needs a body' }, 422)

    const created = await db
      .insertInto('issue_comments')
      .values({
        // Comments are polymorphic so a pull request conversation and an issue
        // conversation are the same thing, which is what makes a pull request
        // reachable as `#12`.
        commentable_type: 'issue',
        commentable_id: Number(issue.id),
        author_id: user.id,
        body,
      })
      .returning(['id'])
      .executeTakeFirst()

    await recountComments(Number(issue.id))

    // Mentions are parsed here rather than at render time so a notification is
    // sent once, when the comment is written, and not again on every read. Cross
    // references are recorded for the same reason: the link belongs in the other
    // issue's history, which nothing reading this comment would ever visit.
    const mentioned = userReferences(body).map(reference => reference.handle)

    const references = await recordCrossReferences(
      {
        subject: {
          type: issue.is_pull_request ? 'pull_request' : 'issue',
          id: Number(issue.id),
        },
        number,
        repositoryId: repository.id,
      },
      user.id,
      body,
    )

    // Mentions are addressed rather than broadcast: naming somebody in a
    // comment reaches them whether or not they were following the thread, which
    // is the whole reason people write an @.
    const mentionedIds: any[] = mentioned.length === 0
      ? []
      : await db.selectFrom('users').select(['id']).where('handle', 'in', [...new Set(mentioned)]).execute()

    const { notify } = await import('../../Notifications/emit')
    await notify('comment:created', {
      actorId: user.id,
      actorHandle: user.handle,
      repositoryId: repository.id,
      owner: String(request.get('owner') ?? '').trim().toLowerCase(),
      repository: repository.name,
      subjectType: issue.is_pull_request ? 'pull_request' : 'issue',
      subjectId: Number(issue.id),
      number,
      addressed: mentionedIds.map(row => Number(row.id)),
      // Commenting on something subscribes you to it.
      subscribeActor: 'participating',
    })

    return response.json({
      id: Number(created?.id),
      issue_number: number,
      mentions: [...new Set(mentioned)],
      references,
      attachments: uploaded.attached,
      // Reported rather than thrown, so a rejected file is visible without
      // having cost somebody the comment they wrote around it.
      refused: uploaded.refused,
    }, 201)
  },
})
