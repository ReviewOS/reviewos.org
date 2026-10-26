import type { CLI } from '@stacksjs/types'
import { db } from '@stacksjs/database'
import { syncIssueRow } from '../Actions/Pull/issueRow'

/**
 * Backfill the `issues` row behind every pull request that predates them.
 *
 * `app/Actions/Pull/issueRow.ts` explains what the row is for. New pull
 * requests get one when they are opened; every pull request opened before
 * that has none, so its number resolves to nothing and its conversation has
 * nowhere to go. That is every pull request on every instance that existed
 * before this, which is why it is a command rather than a note in an upgrade
 * guide.
 *
 * Safe to run twice. `syncIssueRow` updates the row when one is already there,
 * so a second pass is an expensive no-op rather than a duplicate, and the
 * unique index on `(repository_id, number)` would refuse one anyway.
 *
 * It does not invent conversations. A backfilled row carries the change's
 * title, body, author and state as they are now, because that is all there is
 * to carry: nothing recorded what the title was when it was opened.
 */
export default function (cli: CLI) {
  cli.command('pull:issue-rows', 'Write the issues row behind every pull request that has none')
    .option('--dry-run', 'Report what would be written and write nothing')
    .action(async (options: { dryRun?: boolean }) => {
      const dryRun = Boolean(options?.dryRun)

      const pulls = await db
        .selectFrom('pull_requests')
        .select(['id', 'repository_id', 'number', 'title', 'body', 'author_id', 'state', 'closed_at', 'closed_by_id'])
        .orderBy('id')
        .execute()

      if (pulls.length === 0) {
        console.log('No pull requests.')

        return
      }

      /*
       * Which numbers already have a row, asked once rather than per pull
       * request. `syncIssueRow` looks the row up again before writing, so this
       * is only here to report honestly on how many were missing: a run that
       * says it wrote 37 rows when 37 already existed teaches people to stop
       * reading the output.
       */
      const existing = new Set(
        (await db.selectFrom('issues').select(['repository_id', 'number']).where('is_pull_request', '=', true).execute())
          .map((row: any) => `${Number(row.repository_id)}:${Number(row.number)}`),
      )

      const missing = pulls.filter((row: any) => !existing.has(`${Number(row.repository_id)}:${Number(row.number)}`))

      if (dryRun) {
        console.log(`${missing.length} of ${pulls.length} pull request(s) have no issues row.`)
        for (const row of missing.slice(0, 20))
          console.log(`  repository ${row.repository_id} #${row.number}  ${String(row.title ?? '').slice(0, 60)}`)
        if (missing.length > 20)
          console.log(`  ... and ${missing.length - 20} more`)

        return
      }

      for (const row of missing as any[]) {
        await syncIssueRow({
          repositoryId: Number(row.repository_id),
          number: Number(row.number),
          title: String(row.title ?? ''),
          body: row.body === null || row.body === undefined ? null : String(row.body),
          authorId: row.author_id === null || row.author_id === undefined ? null : Number(row.author_id),
          state: String(row.state ?? 'open'),
          closedAt: row.closed_at ? String(row.closed_at) : null,
          closedById: row.closed_by_id ? Number(row.closed_by_id) : null,
        })
      }

      console.log(`Wrote ${missing.length} issues row(s); ${pulls.length - missing.length} already had one.`)
    })
}
