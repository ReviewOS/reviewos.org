/**
 * What makes a redelivered event harmless.
 *
 * A push that is delivered twice produces the same version, ref and commit, so
 * the second insert has to collide with the first and no second run may exist.
 * Enforced by the database rather than by a check-then-insert, because two
 * deliveries arriving together would both pass the check.
 *
 * This used to be a partial unique index - `UNIQUE (version, ref, head, event)
 * WHERE event NOT IN ('workflow_dispatch', 'schedule')` - and the predicate was
 * the interesting half: a manual dispatch and a schedule are not deliveries,
 * nothing arrived, and both repeat at the same ref and the same commit by
 * design. A nightly job would otherwise run once, ever, and pressing "run
 * workflow" a second time would be refused.
 *
 * **MySQL has no partial indexes**, and phase 17 moves the metadata database
 * there. So the exclusion moved out of the index predicate and into the value:
 * a nullable column that is *null* for the events that are allowed to repeat,
 * with a plain unique index over it. Every engine treats nulls in a unique
 * index as distinct from each other, so the two shapes are the same rule -
 * this one is just expressible on both engines, and visible in the row rather
 * than only in the schema.
 *
 * The alternative was a MySQL functional index over a `CASE` expression, which
 * reproduces a partial index exactly and is a construct one engine has. A
 * column both engines index the same way is the better trade when the schema
 * has to be portable for a release cycle.
 */

/**
 * The events that repeat on purpose, and are therefore not deliveries.
 *
 * What stops a schedule double-firing is not this rule but the compare-and-swap
 * on `workflows.last_scheduled_at`.
 */
export const REPEATABLE_EVENTS: readonly string[] = ['workflow_dispatch', 'schedule']

/** The four columns the old index was on, as a row about to be inserted. */
export interface RedeliveryColumns {
  workflow_version_id: number
  event: string
  event_ref?: string | null
  head_sha?: string | null
}

/**
 * The value a second delivery of the same event would collide on, or null for
 * an event that is meant to repeat.
 *
 * Hashed rather than joined, because `event_ref` runs to 400 characters and a
 * composed key would be a 500-character unique index - within InnoDB's 3072
 * bytes today and one column widening away from not being. A fixed 64 is a
 * length nobody has to think about again, and a truncated key would weaken the
 * constraint silently, which is the failure this whole column exists to avoid.
 */
export function redeliveryKey(row: RedeliveryColumns): string | null {
  if (REPEATABLE_EVENTS.includes(row.event))
    return null

  const hasher = new Bun.CryptoHasher('sha256')

  // Length-prefixed rather than delimited: a separator that can occur inside a
  // ref is a separator that lets two different events hash the same.
  for (const part of [String(row.workflow_version_id), row.event, row.event_ref ?? '', row.head_sha ?? '']) {
    hasher.update(`${part.length}:`)
    hasher.update(part)
  }

  return hasher.digest('hex')
}

/**
 * The row it was handed, with its key filled in.
 *
 * Every delivery path inserts through this rather than computing the key
 * beside the values it is already writing: a key derived from a *copy* of the
 * ref is a key that stops matching the row the day somebody edits one of the
 * two, and it would stop matching silently - a duplicate delivery that creates
 * a second run raises nothing anywhere.
 */
export function withRedeliveryKey<T extends RedeliveryColumns>(row: T): T & { redelivery_key: string | null } {
  return { ...row, redelivery_key: redeliveryKey(row) }
}
