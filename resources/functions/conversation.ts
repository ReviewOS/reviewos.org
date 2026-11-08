import { raw } from 'bun-query-builder'
import { toSimplePaginator } from '@stacksjs/pagination'
import { authorLabel, relativeTime } from './browse'
import type { TimelineKind } from '../../app/Actions/Issue/timeline'
import { entryIcon, entrySentence } from './issues'
import { renderMarkdownHighlighted } from './markdown'
import { pressed, subjectKey, summarize, summarizeAll } from './reactions'

/**
 * A conversation, read and shaped for `IssueThread`.
 *
 * `IssueThread.stx` says in its own header that "the pull request page is the
 * reason this is a component at all", and it was right to: both screens render
 * the same markup now. What it could not cover is the eighty lines of reading
 * and shaping in front of it, which lived in the issue view alone - so the
 * second screen would have got a copy of exactly the kind the component exists
 * to prevent. This is that half, in one place.
 *
 * ## Why the two subjects are named separately
 *
 * A pull request's comments and its history do not hang off the same row, and
 * pretending otherwise would quietly show one of them empty.
 *
 * Comments are written by `CommentOnIssueAction` against the `issues` row that
 * stands behind a change (`app/Actions/Pull/issueRow.ts`), because that is the
 * row a number resolves to. Timeline entries are written against the change
 * itself, as `subject_type: 'pull_request'` - `crossReferences` has recorded
 * them that way since before the shadow row existed, and `subject_type` is
 * polymorphic precisely so it can.
 *
 * So a caller passes both. For an issue they are the same row and saying it
 * twice costs nothing; for a change they differ, and a single id would have
 * been wrong for one of them.
 */

export interface ConversationSubject {
  /**
   * Where comments hang: `('issue', id)` for both kinds, today.
   *
   * Optional, and the opening post does not depend on it. A change whose
   * `issues` row has not been written yet still has a description, and an
   * earlier version of this dropped it along with the conversation - which
   * `tests/e2e/pull-tabs.test.ts` caught, because a mirrored change is created
   * by a path that writes no shadow row at all.
   */
  comments?: { type: string, id: number } | null
  /** Where history hangs: `('issue' | 'pull_request', id)`. */
  timeline?: { type: string, id: number } | null
  /** The opening post itself. */
  opening: {
    body: string | null
    createdAt: string
    authorHandle: string | null
    externalAuthor: string | null
  }
  /** Reactions on the opening post hang off this, like comments do. */
  reactions?: { type: string, id: number } | null
  locked: boolean
}

export interface ConversationContext {
  owner: string
  repository: string
  /** The number both forms post back, so a reaction knows what it is on. */
  number: number
  viewerId: number | null
  page?: unknown
  comment?: unknown
  /** `?react=body` or `?react=<comment id>`, straight from the query string. */
  picking: string
  reactionAction: string
  taskAction: string
}

export interface ConversationResult {
  opening: Record<string, unknown>
  items: Record<string, unknown>[]
  pagination: ReturnType<typeof toSimplePaginator>
  commentCount: number
}

/** Fifty timeline entries per page; bodies are read only after admission. */
export const CONVERSATION_PAGE_SIZE = 50

export function conversationPageNumber(value: unknown): number {
  const text = String(value ?? '1')
  return /^[1-9]\d{0,6}$/.test(text) ? Number(text) : 1
}

/** Keep picker links and page links in this conversation, including pull tabs. */
export function conversationPageHref(page: number, picking = ''): string {
  const query = new URLSearchParams({ conversation_page: String(page) })
  if (picking) query.set('react', picking)
  return '?' + query.toString() + '#conversation'
}

async function conversationWindow(subject: ConversationSubject, context: ConversationContext) {
  const comments = () => db.selectFrom('issue_comments').select(['id', 'created_at'])
    .selectRaw(raw("'comment' AS kind"))
    .where('commentable_type', '=', subject.comments?.type ?? 'issue')
    .where('commentable_id', '=', subject.comments?.id ?? 0)
  const events = () => db.selectFrom('timeline_entries').select(['id', 'created_at'])
    .selectRaw(raw("'event' AS kind"))
    .where('subject_type', '=', subject.timeline?.type ?? 'issue')
    .where('subject_id', '=', subject.timeline?.id ?? 0)
  const sequence = () => comments().unionAll(events())
  let page = conversationPageNumber(context.page)
  // Reaction pickers and links to a particular comment must open its page.
  const focus = String(context.comment ?? (/^[1-9]\d*$/.test(context.picking) ? context.picking : ''))
  if (/^[1-9]\d{0,14}$/.test(focus) && subject.comments) {
    const target = await db.selectFrom('issue_comments').select(['id', 'created_at'])
      .where('commentable_type', '=', subject.comments.type).where('commentable_id', '=', subject.comments.id)
      .where('id', '=', Number(focus)).executeTakeFirst()
    if (target) {
      const precedingComments = await comments().whereGroup((q: any) => q.where('created_at', '<', target.created_at)
        .orWhereGroup((tie: any) => tie.where('created_at', '=', target.created_at).where('id', '<=', Number(target.id)))).count()
      const precedingEvents = await events().where('created_at', '<', target.created_at).count()
      const preceding = Number(precedingComments) + Number(precedingEvents)
      page = Math.max(1, Math.ceil(Number(preceding) / CONVERSATION_PAGE_SIZE))
    }
  }
  const result = await sequence().orderBy('created_at', 'asc').orderBy('kind', 'asc').orderBy('id', 'asc')
    .simplePaginate(CONVERSATION_PAGE_SIZE, page)
  return toSimplePaginator({ data: result.data, meta: {
    perPage: Number(result.meta.perPage), page: Number(result.meta.page), hasMore: result.meta.hasMore === true,
  } })
}

/**
 * Read a conversation and shape it the way the component expects.
 *
 * Reactions are two queries for the whole page rather than one per comment: a
 * conversation with three hundred comments is exactly where the per-comment
 * version would be felt, and it is the one somebody most wants to read.
 */
export async function loadConversation(subject: ConversationSubject, context: ConversationContext): Promise<ConversationResult> {
  const pagination = await conversationWindow(subject, context)
  const commentIds = pagination.data.filter((row: any) => row.kind === 'comment').map((row: any) => Number(row.id))
  const eventIds = pagination.data.filter((row: any) => row.kind === 'event').map((row: any) => Number(row.id))
  const pickerHref = (target: string): string => conversationPageHref(pagination.current_page, target).replace('#conversation', `#reactions-${target}`)
  const commentCount = subject.comments ? Number(await db.selectFrom('issue_comments')
    .where('commentable_type', '=', subject.comments.type).where('commentable_id', '=', subject.comments.id).count()) : 0

  const commentRows: any[] = !subject.comments || !commentIds.length
    ? []
    : await db
      .selectFrom('issue_comments')
    // A LEFT join: a mirrored comment has no local author, and an inner join
    // would drop it from the conversation without saying so.
    .leftJoin('users', 'users.id', '=', 'issue_comments.author_id')
    .select([
      'issue_comments.id as id',
      'issue_comments.body as body',
      'issue_comments.created_at as created_at',
      'issue_comments.edited_at as edited_at',
      'issue_comments.external_author as external_author',
      'users.handle as handle',
    ])
      .where('issue_comments.commentable_type', '=', subject.comments.type)
      .where('issue_comments.commentable_id', '=', subject.comments.id)
      .where('issue_comments.id', 'in', commentIds)
      .orderBy('issue_comments.created_at', 'asc')
      .execute()

  const entryRows: any[] = !subject.timeline || !eventIds.length
    ? []
    : await db
      .selectFrom('timeline_entries')
    .leftJoin('users', 'users.id', '=', 'timeline_entries.actor_id')
    .select([
      'timeline_entries.id as id',
      'timeline_entries.kind as kind',
      'timeline_entries.subject_text as subject_text',
      'timeline_entries.previous_text as previous_text',
      'timeline_entries.reference_number as reference_number',
      'timeline_entries.external_actor as external_actor',
      'timeline_entries.created_at as created_at',
      'users.handle as handle',
    ])
      .where('timeline_entries.subject_type', '=', subject.timeline.type)
      .where('timeline_entries.subject_id', '=', subject.timeline.id)
      .where('timeline_entries.id', 'in', eventIds)
      .orderBy('timeline_entries.created_at', 'asc')
      .execute()

  const bodyReactionRows: any[] = !subject.reactions
    ? []
    : await db
      .selectFrom('reactions')
      .select(['subject_type', 'subject_id', 'content', 'user_id'])
      .where('subject_type', '=', subject.reactions.type)
      .where('subject_id', '=', subject.reactions.id)
      .execute()

  const commentReactionRows: any[] = commentRows.length > 0
    ? await db
        .selectFrom('reactions')
        .select(['subject_type', 'subject_id', 'content', 'user_id'])
        .where('subject_type', '=', 'issue_comment')
        .where('subject_id', 'in', commentRows.map((row: any) => Number(row.id)))
        .execute()
    : []

  const commentReactions = summarizeAll(commentReactionRows, context.viewerId)

  // The eight with a count of zero, for a comment nobody has reacted to. Built
  // once rather than per comment: it is the same answer every time.
  const noReactions = summarize([], context.viewerId)
  const bodyReactions = summarize(bodyReactionRows, context.viewerId)

  const markdownContext = { owner: context.owner, repository: context.repository }

  // Ticking a box posts a form, because the page runs no client-side
  // JavaScript. A locked conversation gets no forms at all: the action refuses
  // them anyway, and offering a control that will be turned down is worse than
  // not offering it.
  const taskFields = { owner: context.owner, repo: context.repository, number: context.number }
  const bodyTaskForm = subject.locked ? undefined : { action: context.taskAction, fields: taskFields }

  const reactionFields = [
    { name: 'owner', value: context.owner },
    { name: 'repo', value: context.repository },
    { name: 'number', value: context.number },
  ]

  const opening = {
    author: authorLabel(subject.opening.authorHandle, subject.opening.externalAuthor),
    when: relativeTime(String(subject.opening.createdAt ?? '')),
    bodyHtml: subject.opening.body
      ? await renderMarkdownHighlighted(String(subject.opening.body), { ...markdownContext, taskForm: bodyTaskForm })
      : '',
    reactions: context.picking === 'body' ? bodyReactions : pressed(bodyReactions),
    reactionFields,
    picking: context.picking === 'body',
    pickerHref: pickerHref('body'),
  }

  const comments = await Promise.all(commentRows.map(async (row: any) => {
    const id = Number(row.id)
    const summaries = commentReactions.get(subjectKey('issue_comment', id)) ?? noReactions

    return {
      id,
      author: authorLabel(row.handle ? String(row.handle) : null, row.external_author ? String(row.external_author) : null),
      when: relativeTime(String(row.created_at ?? '')),
      createdAt: String(row.created_at ?? ''),
      edited: Boolean(row.edited_at),
      bodyHtml: await renderMarkdownHighlighted(String(row.body ?? ''), {
        ...markdownContext,
        taskForm: bodyTaskForm ? { action: context.taskAction, fields: { ...taskFields, comment_id: id } } : undefined,
      }),
      // All eight when the picker is open on this comment, and otherwise only
      // the ones somebody has pressed: a row of eight grey buttons under every
      // comment on a two-hundred-comment conversation is noise.
      reactions: context.picking === String(id) ? summaries : pressed(summaries),
      reactionFields: [...reactionFields, { name: 'comment_id', value: id }],
      picking: context.picking === String(id),
      pickerHref: pickerHref(String(id)),
    }
  }))

  const events = entryRows.map((row: any) => ({
    id: Number(row.id),
    createdAt: String(row.created_at ?? ''),
    actor: authorLabel(row.handle ? String(row.handle) : null, row.external_actor ? String(row.external_actor) : null),
    when: relativeTime(String(row.created_at ?? '')),
    /*
     * The kind is a `TimelineKind`, and the column is a string.
     *
     * The issue view asserted the same thing implicitly and nothing checked
     * it, because a `.stx` file is not in the typecheck project and this file
     * is. Narrowing here rather than widening the helpers keeps the exhaustive
     * switch inside `entrySentence` doing its job: a row carrying a kind this
     * version does not know renders as nothing, which is the behaviour that
     * file already documents and relies on.
     */
    icon: entryIcon(String(row.kind) as TimelineKind),
    sentence: entrySentence(String(row.kind) as TimelineKind, {
      text: row.subject_text ? String(row.subject_text) : null,
      previous: row.previous_text ? String(row.previous_text) : null,
      reference: row.reference_number ? Number(row.reference_number) : null,
    }),
  }))

  // One sequence, ordered by when things happened. A comment and the label
  // somebody added while writing it belong next to each other; two lists side
  // by side make a reader reconstruct the order themselves.
  const items = [
    ...comments.map(comment => ({ kind: 'comment', at: comment.createdAt, comment, event: null })),
    ...events.map(event => ({ kind: 'event', at: event.createdAt, comment: null, event })),
  ]
  // Preserve the database's stable order, including equal timestamps across
  // comments and events. No locale-dependent sorting of dates in JavaScript.
  const byKey = new Map(items.map(item => [item.kind + ':' + (item.comment?.id ?? item.event?.id), item]))
  const ordered = pagination.data.map((row: any) => byKey.get(row.kind + ':' + row.id)!).filter(Boolean)

  return { opening, items: ordered, pagination, commentCount }
}
