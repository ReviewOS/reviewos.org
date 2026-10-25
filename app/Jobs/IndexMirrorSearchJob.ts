import { db } from '@stacksjs/database'
import { Job } from '@stacksjs/queue'
import { ISSUE_COLUMNS, ISSUE_INDEX, issueDocuments, PULL_COLUMNS, PULL_INDEX, pullDocuments } from '../Actions/Search/documents'

/** Index the records a metadata pass actually read, including upstream edits. */
export default new Job({
  name: 'IndexMirrorSearchJob',
  description: 'Refresh search after mirrored issues and pull requests change',
  queue: 'search',
  tries: 3,
  backoff: 30,

  async handle(payload: { repositoryId: number, issueNumbers?: number[], pullNumbers?: number[] }) {
    const repositoryId = Number(payload?.repositoryId)
    if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0)
      throw new Error('A repository is required to index mirrored discussions')

    const { useSearchEngine } = await import('@stacksjs/search-engine')
    const engine = useSearchEngine()
    let indexed = 0

    // Bound both the SQL parameter list and the projection's memory use. The
    // shared projections are the same shapeMany functions used by useSearch.
    for (const batch of numberBatches(payload.issueNumbers)) {
      const rows = await db.selectFrom('issues').select([...ISSUE_COLUMNS])
        .where('repository_id', '=', repositoryId).where('number', 'in', batch).execute()
      const documents = await issueDocuments(rows)
      if (documents.length) await engine.addDocuments(ISSUE_INDEX, documents)
      indexed += documents.length
    }

    for (const batch of numberBatches(payload.pullNumbers)) {
      const rows = await db.selectFrom('pull_requests').select([...PULL_COLUMNS])
        .where('repository_id', '=', repositoryId).where('number', 'in', batch).execute()
      const documents = await pullDocuments(rows)
      if (documents.length) await engine.addDocuments(PULL_INDEX, documents)
      indexed += documents.length
    }

    return { indexed }
  },
})

function* numberBatches(input: number[] = []): Generator<number[]> {
  const numbers = [...new Set(input.map(Number).filter(number => Number.isSafeInteger(number) && number > 0))]
  for (let offset = 0; offset < numbers.length; offset += 200)
    yield numbers.slice(offset, offset + 200)
}
