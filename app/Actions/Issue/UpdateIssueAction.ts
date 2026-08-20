import { Action } from '@stacksjs/actions'
import { schema } from '@stacksjs/validation'
import { authorizeRepository } from '../Repo/authorize'
import { recordCrossReferences } from './crossReferences'

/**
 * Edit an issue's title or body.
 *
 * The author may edit their own. Anyone else needs `issue:edit-any`, which is a
 * write-level power: rewriting somebody's report changes the record of what
 * they said, and triage rights are for organising issues, not rewriting them.
 */
export default new Action({
  name: 'UpdateIssue',
  description: 'Edit the title or body of an issue',
  method: 'PUT',

  // Declared so the document can publish them: every key is one the handler
  // reads. **Enforced, not descriptive**: the framework checks these before the
  // handler runs and answers 422 itself, so a named type here is a promise that
  // the endpoint refuses every other spelling of the value. A field the handler
  // coerces takes `coerced` from `app/Actions/inputs.ts` instead.
  validations: {
    owner: { rule: schema.string() },
    repo: { rule: schema.string() },
    number: { rule: schema.number() },
    body: { rule: schema.string() },
    title: { rule: schema.string() },
  },

  async handle(request: RequestInstance) {
    const auth = await authorizeRepository(request, 'repository:read')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user, can } = auth.context
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const number = Number(request.get('number'))
    const issue = await db
      .selectFrom('issues')
      .select(['id', 'author_id', 'locked', 'is_pull_request'])
      .where('repository_id', '=', repository.id)
      .where('number', '=', number)
      .executeTakeFirst()

    if (!issue)
      return response.json({ error: 'No such issue' }, 404)

    const isAuthor = Number(issue.author_id) === user.id
    if (!isAuthor && !can('issue:edit-any'))
      return response.json({ error: 'Forbidden' }, 403)

    // A lock ends the conversation, and editing the opening post is part of the
    // conversation. Maintainers keep the ability, which is how a locked issue
    // gets a closing note added to its body.
    if (issue.locked && !can('issue:close'))
      return response.json({ error: 'This conversation is locked' }, 423)

    // Absent means "leave it alone", which is not the same as an empty string.
    // Sending `body: ''` clears the body on purpose; sending nothing keeps it.
    const rawTitle = request.get('title')
    const rawBody = request.get('body')
    if (rawTitle === undefined && rawBody === undefined)
      return response.json({ error: 'Nothing to change' }, 422)

    const changes: Record<string, unknown> = {}

    if (rawTitle !== undefined) {
      const title = String(rawTitle).trim()
      if (!title)
        return response.json({ error: 'An issue needs a title' }, 422)
      if (title.length > 255)
        return response.json({ error: 'That title is too long' }, 422)
      changes.title = title
    }

    if (rawBody !== undefined)
      changes.body = String(rawBody)

    await db.updateTable('issues').set(changes).where('id', '=', Number(issue.id)).execute()

    // A reference edited into a body counts, and is exactly the case the entry
    // on the source side exists for: the link would otherwise appear nowhere in
    // this issue's own history. Already-recorded references are not written
    // twice, so editing a body for any other reason records nothing.
    const references = rawBody === undefined
      ? []
      : await recordCrossReferences(
          {
            subject: {
              type: issue.is_pull_request ? 'pull_request' : 'issue',
              id: Number(issue.id),
            },
            number,
            repositoryId: repository.id,
          },
          user.id,
          String(rawBody),
        )

    return response.json({ number, ...changes, references })
  },
})
