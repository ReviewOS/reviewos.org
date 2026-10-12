import { db, Seeder } from '@stacksjs/database'

/**
 * Timelines, pointed at things that exist.
 *
 * The third instance of one bug, after `Reaction` and `repositories.owner_id`:
 * `subject_id` is polymorphic - `subject_type` says `issue` or `pull_request`
 * and `subject_id` indexes whichever of the two it names - and a factory is
 * handed `faker` and its own row's values, never a database, so there is
 * nothing it can return. It returned `null`, the column is `not null`, and the
 * whole batch failed with "null value in column subject_id violates not-null
 * constraint" on every single run. `timeline_entries` has therefore always
 * been empty, which is why no issue or pull request has ever shown a history
 * below its description.
 *
 * A `belongsTo` is the obvious fix and the wrong one, for the reason spelled
 * out in `Reactions.ts`: it generates a foreign key, and a foreign key on a
 * polymorphic column forbids half the values the column exists to hold.
 *
 * ## Why the content is derived rather than invented
 *
 * A timeline is rendered by matching on `kind`, and most kinds carry a
 * `subject_text` that names something real: `labeled` names a label,
 * `milestoned` names a milestone, `renamed` carries both titles, `referenced`
 * carries another change's number. Random text in those fields produces a
 * history that contradicts the page it sits on - "added the label wontfix" on
 * a repository that has no such label - and the contradiction is invisible to
 * a test while being the first thing a person notices.
 *
 * So each entry is built from the subject's own row and from that
 * repository's own labels and milestones, and a kind is only emitted when the
 * thing it would name is actually there.
 *
 * Re-runnable, like the other two: `buddy setup` re-seeds, so this runs
 * against a database that may already hold its output.
 */

/** What `TimelineEntry`'s `useSeeder` asked for before it could deliver none. */
const TARGET = 40

/** One entry before the subject and actor are attached to it. */
interface Entry {
  kind: string
  subject_text?: string
  previous_text?: string
  reference_number?: number
}

interface Subject {
  type: 'issue' | 'pull_request'
  id: number
  number: number
  title: string
  state: string
  repositoryId: number
}

export default class TimelineEntries extends Seeder {
  /** After the model pass, which creates the issues, changes, labels and users. */
  static order = 11
  static tags = ['timeline']

  async run(): Promise<void> {
    const already = Number(
      (await db.selectFrom('timeline_entries').select(db.fn.countAll().as('n')).executeTakeFirst())?.n ?? 0,
    )

    if (TARGET - already <= 0)
      return

    const users = (await db.selectFrom('users').select(['id']).orderBy('id').limit(500).execute())
      .map(row => Number(row.id))

    if (users.length === 0)
      return

    const subjects = await this.subjects()

    // A database whose issues have not been seeded yet is not a failure here.
    if (subjects.length === 0)
      return

    const labels = await this.byRepository('repository_labels', 'name')
    const milestones = await this.byRepository('milestones', 'title')

    // The other changes in the same repository, so a cross reference points at
    // a number that is really there.
    const numbers = new Map<number, number[]>()

    for (const subject of subjects) {
      const list = numbers.get(subject.repositoryId) ?? []

      list.push(subject.number)
      numbers.set(subject.repositoryId, list)
    }

    const rows: Record<string, unknown>[] = []

    for (let index = 0; index < subjects.length && rows.length < TARGET - already; index += 1) {
      const subject = subjects[index]!
      const actor = users[(index * 7) % users.length]!

      for (const entry of this.historyOf(subject, index, labels, milestones, numbers)) {
        if (rows.length >= TARGET - already)
          break

        /*
         * Every row carries every key, including the ones it has no value for.
         *
         * A multi-row insert builds one statement, so its column list comes
         * from the first row - and a key absent from that row is dropped from
         * the statement rather than inserted as null on the rows that have it.
         * The first entry here is usually `labeled`, which has a
         * `subject_text` and no `previous_text` or `reference_number`, so all
         * forty rows went in with those two columns missing: five
         * `referenced` entries rendered as "referenced this in a commit"
         * instead of naming the change, and three `renamed` entries had
         * nothing to show as the previous title. Nothing errored, and the
         * seeder reported forty rows written, which it had.
         */
        rows.push({
          subject_type: subject.type,
          subject_id: subject.id,
          actor_id: actor,
          // `useUuid` is on the model, and nothing fills it for a direct insert.
          uuid: crypto.randomUUID(),
          // `created_at` is left to its default in both dialects, deliberately:
          // an ISO-8601 string is what MySQL refuses for a `datetime`.
          kind: entry.kind,
          subject_text: entry.subject_text ?? null,
          previous_text: entry.previous_text ?? null,
          reference_number: entry.reference_number ?? null,
        })
      }
    }

    if (rows.length === 0)
      return

    await db.insertInto('timeline_entries').values(rows).execute()

    console.error(`[seed] ${rows.length} timeline entr${rows.length === 1 ? 'y' : 'ies'}`)
  }

  /** Issues and pull requests together, which is what `subject_type` spans. */
  private async subjects(): Promise<Subject[]> {
    const subjects: Subject[] = []

    for (const [type, table] of [['issue', 'issues'], ['pull_request', 'pull_requests']] as const) {
      const rows = await db
        .selectFrom(table)
        .select(['id', 'number', 'title', 'state', 'repository_id'])
        .orderBy('id')
        .limit(500)
        .execute()

      for (const row of rows) {
        subjects.push({
          type,
          id: Number(row.id),
          number: Number(row.number),
          title: String(row.title ?? ''),
          state: String(row.state ?? 'open'),
          repositoryId: Number(row.repository_id),
        })
      }
    }

    return subjects
  }

  /** One named column, grouped by the repository that owns the rows. */
  private async byRepository(table: 'repository_labels' | 'milestones', column: 'name' | 'title'): Promise<Map<number, string[]>> {
    const grouped = new Map<number, string[]>()

    const rows = await db
      .selectFrom(table)
      .select(['repository_id', column])
      .orderBy('id')
      .limit(500)
      .execute()

    for (const row of rows) {
      const value = String((row as Record<string, unknown>)[column] ?? '')

      if (!value)
        continue

      const repositoryId = Number(row.repository_id)
      const list = grouped.get(repositoryId) ?? []

      list.push(value)
      grouped.set(repositoryId, list)
    }

    return grouped
  }

  /**
   * The entries for one subject, in the order they would have happened.
   *
   * Between one and four, varied by position so the instance has subjects with
   * a long history and subjects with none - a uniform one-each would make
   * every page look the same and would never exercise the grouping the
   * timeline does.
   */
  private historyOf(
    subject: Subject,
    index: number,
    labels: Map<number, string[]>,
    milestones: Map<number, string[]>,
    numbers: Map<number, number[]>,
  ): Entry[] {
    const entries: Entry[] = []
    const repositoryLabels = labels.get(subject.repositoryId) ?? []
    const repositoryMilestones = milestones.get(subject.repositoryId) ?? []

    // Every fourth one stays bare, because an empty timeline is a real state
    // and the page has to look right in it.
    if (index % 4 === 3)
      return entries

    if (repositoryLabels.length > 0) {
      entries.push({
        kind: 'labeled',
        subject_text: repositoryLabels[index % repositoryLabels.length]!.slice(0, 255),
      })
    }

    if (index % 3 === 0 && repositoryMilestones.length > 0) {
      entries.push({
        kind: 'milestoned',
        subject_text: repositoryMilestones[index % repositoryMilestones.length]!.slice(0, 255),
      })
    }

    // A rename carries both halves, and the previous title has to differ from
    // the current one or the entry reads as a no-op.
    if (index % 5 === 1 && subject.title) {
      entries.push({
        kind: 'renamed',
        subject_text: subject.title.slice(0, 255),
        previous_text: `WIP: ${subject.title}`.slice(0, 255),
      })
    }

    // Pointed at a different change in the same repository. One subject is not
    // a cross reference to itself.
    const siblings = (numbers.get(subject.repositoryId) ?? []).filter(number => number !== subject.number)

    if (index % 3 === 1 && siblings.length > 0) {
      entries.push({
        kind: 'referenced',
        reference_number: siblings[index % siblings.length]!,
      })
    }

    // Last, because it is what the state says happened in the end.
    if (subject.state === 'closed')
      entries.push({ kind: 'closed' })
    else if (subject.state === 'merged')
      entries.push({ kind: 'merged' })

    return entries
  }
}
