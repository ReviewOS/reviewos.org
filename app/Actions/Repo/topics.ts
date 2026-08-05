/**
 * Topics on a repository.
 *
 * The whole value of a topic is the query that runs the other way - every
 * repository tagged `rust` - and that only works if `Rust`, `rust` and `RUST`
 * are one topic. So the normalising is a rule with a test rather than a
 * `toLowerCase()` at whichever call site remembered.
 */

/** How many topics one repository may carry. */
export const MAX_TOPICS = 20

/** How long one topic may be. */
export const MAX_TOPIC_LENGTH = 50

/**
 * One topic, as it is stored.
 *
 * Lower case, spaces and underscores to dashes, runs of dashes collapsed, and
 * trimmed of dashes at either end. Null for anything left with nothing in it,
 * which is what `--` and `!!!` both become.
 *
 * Digits are allowed anywhere including the start, because `3d`, `2fa` and
 * `c99` are real topics and a rule that a topic must start with a letter is a
 * rule that exists only to be worked around.
 */
export function normalizeTopic(raw: unknown): string | null {
  const topic = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9.+#-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')

  if (!topic || topic.length > MAX_TOPIC_LENGTH)
    return null

  return topic
}

export interface TopicDecision {
  /** The topics to store, normalised, deduplicated, in the order given. */
  topics: string[]
  /** What was dropped, so the caller can say so rather than silently losing it. */
  rejected: string[]
}

/**
 * Read a list of topics.
 *
 * Everything unusable is reported rather than dropped quietly. Somebody who
 * typed a topic that was too long, or one that normalised to nothing, has to be
 * told - a form that silently discards one of the six things you typed is a
 * form you stop trusting.
 *
 * Duplicates after normalising are not rejections. `TypeScript` and
 * `typescript` in the same list is somebody typing the same topic twice, not
 * an error to report back at them.
 */
export function decideTopics(raw: unknown): TopicDecision {
  const values = Array.isArray(raw)
    ? raw
    : String(raw ?? '').split(/[,\n]/)

  const topics: string[] = []
  const rejected: string[] = []
  const seen = new Set<string>()

  for (const value of values) {
    const original = String(value ?? '').trim()
    if (!original)
      continue

    const topic = normalizeTopic(original)

    if (!topic) {
      rejected.push(original)
      continue
    }

    if (seen.has(topic))
      continue

    if (topics.length >= MAX_TOPICS) {
      rejected.push(original)
      continue
    }

    seen.add(topic)
    topics.push(topic)
  }

  return { topics, rejected }
}

/**
 * What to add and what to remove to get from one set of topics to another.
 *
 * Computed rather than deleting everything and re-inserting, so a topic that
 * did not change keeps its row - and its `created_at`, which is the only record
 * of when a repository started calling itself that.
 */
export function topicChanges(current: readonly string[], next: readonly string[]): { add: string[], remove: string[] } {
  const held = new Set(current)
  const wanted = new Set(next)

  return {
    add: next.filter(topic => !held.has(topic)),
    remove: current.filter(topic => !wanted.has(topic)),
  }
}
