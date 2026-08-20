import { Job } from '@stacksjs/queue'
import { REPOSITORY_COLUMNS, REPOSITORY_INDEX, repositoryDocuments } from '../Actions/Search/documents'

/**
 * Put repositories into the search index, one or all of them.
 *
 * On the `search` queue and never on the request path. Indexing is a write to
 * another service, and a push that fails because the search node is restarting
 * is a push that should have succeeded - the index is allowed to be a few
 * seconds behind, and the code that reads it is written to expect that
 * (`visibility.ts` re-checks every hit against the database, so a stale index
 * can be wrong about what exists but never about who may see it).
 *
 * The document is `documents.ts`, built in batches, and deliberately much
 * smaller than the trait's default projection.
 *
 * **Deletion is the same job.** A repository that no longer exists is removed
 * rather than skipped: an index that accumulates deleted rows serves names for
 * repositories that are gone, and "why does search know about that" is a
 * question with an alarming-sounding answer and a boring cause.
 */
export default new Job({
  name: 'IndexRepositoryJob',
  description: 'Index one repository, or rebuild the whole corpus',
  queue: 'search',
  tries: 3,
  backoff: 30,

  async handle(payload: { repositoryId?: number, chunkSize?: number } = {}): Promise<{ indexed: number, removed: number }> {
    const { useSearchEngine } = await import('@stacksjs/search-engine')
    const engine: any = useSearchEngine()

    const chunkSize = Math.max(1, Number(payload?.chunkSize ?? 200))
    const single = Number(payload?.repositoryId ?? 0)

    if (Number.isInteger(single) && single > 0) {
      const row = await db
        .selectFrom('repositories')
        .select([...REPOSITORY_COLUMNS])
        .where('id', '=', single)
        .executeTakeFirst()

      // Gone since the job was queued, which is the normal way a delete
      // arrives here: the row is removed and the job still runs.
      if (!row) {
        await removeQuietly(engine, single)

        return { indexed: 0, removed: 1 }
      }

      const [document] = await repositoryDocuments([row])
      await engine.addDocument(REPOSITORY_INDEX, document)

      return { indexed: 1, removed: 0 }
    }

    // Full rebuild. Paged by id rather than by offset, because an offset walk
    // over a table that is being written to skips rows: anything inserted
    // behind the cursor shifts the window.
    let after = 0
    let indexed = 0

    for (;;) {
      const rows = await db
        .selectFrom('repositories')
        .select([...REPOSITORY_COLUMNS])
        .where('id', '>', after)
        .orderBy('id', 'asc')
        .limit(chunkSize)
        .execute()

      if (rows.length === 0)
        break

      const documents = await repositoryDocuments(rows)
      if (documents.length > 0)
        await engine.addDocuments(REPOSITORY_INDEX, documents)

      indexed += documents.length
      after = Number(rows[rows.length - 1]?.id ?? after)
    }

    return { indexed, removed: 0 }
  },
})

/**
 * Remove a document, without caring whether it was there.
 *
 * A delete for something the index never had is the expected case whenever a
 * repository is created and destroyed between reindexes, and it is not a
 * failure worth retrying the job over.
 */
async function removeQuietly(engine: any, id: number): Promise<void> {
  try {
    await engine.deleteDocument(REPOSITORY_INDEX, id)
  }
  catch {
    // Nothing downstream depends on it.
  }
}
