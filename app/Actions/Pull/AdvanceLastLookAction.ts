import { Action } from '@stacksjs/actions'
import { authorizeRepository } from '../Repo/authorize'

/**
 * "I have read this round" - advancing last-looked without a verdict.
 *
 * Last-looked is normally inferred from a submitted review or a viewed-file
 * mark. The reviewer who read everything and had nothing to add leaves
 * neither, and the incremental diff keeps offering them a round they have
 * already read. This records the sentence they had no way to say.
 *
 * The head recorded is the pull request's head *now*, not one the client
 * names: the client saying "caught up to sha X" would let a stale page mark a
 * round read that its reader never saw offered. If a push lands between the
 * page render and the click, the reviewer catches up to the new head having
 * read the old one - the same thing that happens when they submit a review at
 * that moment, and the next look shows them the delta either way.
 *
 * An upsert against the unique index, so saying it twice is one row updated
 * and two readers of the product's records can never find two opinions about
 * where somebody got to.
 */
export default new Action({
  name: 'AdvanceLastLook',
  description: 'Mark a pull request as read up to its current head',
  method: 'POST',

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'pull:review')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository, user } = auth.context
    const number = Number(request.get('number'))

    // `pull:review` is on the read rung, which a public repository grants to
    // everybody including nobody - and a checkpoint has to belong to somebody.
    if (!user)
      return response.json({ error: 'Unauthenticated' }, 401)

    const pullRequest = await db
      .selectFrom('pull_requests')
      .select(['id', 'state', 'head_sha'])
      .where('repository_id', '=', Number(repository.id))
      .where('number', '=', number)
      .executeTakeFirst()

    if (!pullRequest)
      return response.json({ error: 'No such pull request' }, 404)

    const head = String(pullRequest.head_sha ?? '').trim()
    if (!head)
      return response.json({ error: 'This pull request has no head to catch up to' }, 409)

    // Raw on purpose: the builder has a record of emitting SQL Postgres
    // refuses on anything cleverer than a plain statement, and an upsert is
    // exactly the kind of write that would fail into a catch somewhere.
    //
    // The time is bound, not CURRENT_TIMESTAMP. These are naive timestamp
    // columns and the application writes UTC ISO strings into them
    // everywhere; CURRENT_TIMESTAMP writes the database server's local
    // clock, and lastSeenHead compares the two - a checkpoint stamped hours
    // ahead of every review would outrank verdicts submitted after it, for
    // as many hours as the server sits east of Greenwich.
    await db.unsafe(
      `INSERT INTO "review_checkpoints" ("pull_request_id", "reviewer_id", "head_sha", "created_at", "updated_at")
      VALUES ($1, $2, $3, $4, $4)
      ON CONFLICT ("pull_request_id", "reviewer_id")
      DO UPDATE SET "head_sha" = EXCLUDED."head_sha", "updated_at" = EXCLUDED."updated_at"`,
      [Number(pullRequest.id), Number(user.id), head, new Date().toISOString()],
    ).execute()

    return response.json({ caughtUpTo: head })
  },
})
