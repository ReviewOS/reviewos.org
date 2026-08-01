import { describe, expect, it } from 'bun:test'
import {
  backoffSeconds,
  describeChanges,
  diffRefs,
  headOf,
  isDue,
  isForcePush,
  MAX_CONSECUTIVE_FAILURES,
  parseRefSnapshot,
  remoteKey,
  type RefChange,
  shouldDisable,
  webhookTriggersSync,
} from '../../app/Actions/Mirror/sync'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const C = 'c'.repeat(40)

describe('parseRefSnapshot', () => {
  it('parses ref and sha pairs', () => {
    const snapshot = parseRefSnapshot(`refs/heads/main ${A}\nrefs/tags/v1 ${B}\n`)

    expect(snapshot).toEqual({ 'refs/heads/main': A, 'refs/tags/v1': B })
  })

  it('ignores blank and malformed lines rather than inventing refs', () => {
    // A half-line must not become a ref pointing at nothing.
    expect(parseRefSnapshot(`\n\nrefs/heads/main ${A}\ngarbage\n`)).toEqual({ 'refs/heads/main': A })
  })

  it('splits the ref from the sha at the first space', () => {
    // Splitting on every space would put a fragment of one field in the other.
    const snapshot = parseRefSnapshot(`refs/heads/feature/nested ${A}`)

    expect(snapshot['refs/heads/feature/nested']).toBe(A)
  })

  it('returns nothing for empty output', () => {
    expect(parseRefSnapshot('')).toEqual({})
  })
})

describe('diffRefs', () => {
  it('reports a new ref', () => {
    const changes = diffRefs({}, { 'refs/heads/main': A })

    expect(changes).toEqual([{ ref: 'refs/heads/main', before: null, after: A, kind: 'created' }])
  })

  it('reports an updated ref with both shas', () => {
    const changes = diffRefs({ 'refs/heads/main': A }, { 'refs/heads/main': B })

    expect(changes[0]).toMatchObject({ kind: 'updated', before: A, after: B })
  })

  /**
   * Without deletions a branch removed upstream lingers here forever, and a
   * branch list that never shrinks stops meaning anything.
   */
  it('reports a deleted ref', () => {
    const changes = diffRefs({ 'refs/heads/old': A }, {})

    expect(changes).toEqual([{ ref: 'refs/heads/old', before: A, after: null, kind: 'deleted' }])
  })

  it('reports nothing when nothing moved', () => {
    expect(diffRefs({ 'refs/heads/main': A }, { 'refs/heads/main': A })).toEqual([])
  })

  it('handles creations, updates and deletions together', () => {
    const changes = diffRefs(
      { 'refs/heads/main': A, 'refs/heads/gone': B },
      { 'refs/heads/main': C, 'refs/heads/new': A },
    )

    expect(changes.map(c => c.kind).sort()).toEqual(['created', 'deleted', 'updated'])
  })

  it('orders stably, so the same sync reads the same twice', () => {
    const before = {}
    const after = { 'refs/heads/z': A, 'refs/heads/a': B }

    expect(diffRefs(before, after).map(c => c.ref)).toEqual(['refs/heads/a', 'refs/heads/z'])
  })
})

describe('isForcePush', () => {
  const updated: RefChange = { ref: 'refs/heads/main', before: A, after: B, kind: 'updated' }

  it('is a force push when the old commit is no longer an ancestor', () => {
    expect(isForcePush(updated, false)).toBe(true)
  })

  it('is not a force push when history only moved forward', () => {
    expect(isForcePush(updated, true)).toBe(false)
  })

  it('is never a force push for a creation or deletion', () => {
    expect(isForcePush({ ref: 'r', before: null, after: A, kind: 'created' }, false)).toBe(false)
    expect(isForcePush({ ref: 'r', before: A, after: null, kind: 'deleted' }, false)).toBe(false)
  })
})

describe('backoffSeconds', () => {
  it('is zero while nothing has failed', () => {
    expect(backoffSeconds(0)).toBe(0)
  })

  it('doubles per consecutive failure', () => {
    expect(backoffSeconds(1)).toBe(60)
    expect(backoffSeconds(2)).toBe(120)
    expect(backoffSeconds(3)).toBe(240)
  })

  it('stops widening at an hour', () => {
    // Otherwise a long-dead remote pushes the next attempt past any horizon.
    expect(backoffSeconds(20)).toBe(3600)
  })
})

describe('isDue', () => {
  const base = { enabled: true, interval_seconds: 900, last_synced_at: null, failure_count: 0 }

  it('is due when it has never synced', () => {
    // Waiting an interval before the first fetch makes a new mirror look broken.
    expect(isDue(base)).toBe(true)
  })

  it('is not due before the interval has passed', () => {
    const now = new Date('2026-01-01T00:10:00Z')
    expect(isDue({ ...base, last_synced_at: '2026-01-01T00:05:00Z' }, now)).toBe(false)
  })

  it('is due once the interval has passed', () => {
    const now = new Date('2026-01-01T00:20:00Z')
    expect(isDue({ ...base, last_synced_at: '2026-01-01T00:00:00Z' }, now)).toBe(true)
  })

  it('waits longer after failures', () => {
    const now = new Date('2026-01-01T00:16:00Z')
    const mirror = { ...base, last_synced_at: '2026-01-01T00:00:00Z', failure_count: 3 }

    // 900s interval + 240s backoff = 1140s, and only 960s have passed.
    expect(isDue(mirror, now)).toBe(false)
  })

  it('is never due while disabled', () => {
    expect(isDue({ ...base, enabled: false })).toBe(false)
  })

  it('treats an unparseable timestamp as due rather than never', () => {
    // A corrupt value must not freeze a mirror permanently.
    expect(isDue({ ...base, last_synced_at: 'not a date' })).toBe(true)
  })
})

describe('shouldDisable', () => {
  it('keeps trying below the limit', () => {
    expect(shouldDisable(MAX_CONSECUTIVE_FAILURES - 1)).toBe(false)
  })

  it('gives up at the limit', () => {
    expect(shouldDisable(MAX_CONSECUTIVE_FAILURES)).toBe(true)
  })
})

describe('describeChanges', () => {
  it('says so when nothing moved', () => {
    expect(describeChanges([])).toBe('no changes')
  })

  it('counts rather than listing', () => {
    // A sync that moved four hundred refs should not print four hundred lines.
    const changes: RefChange[] = [
      { ref: 'a', before: null, after: A, kind: 'created' },
      { ref: 'b', before: A, after: B, kind: 'updated' },
      { ref: 'c', before: A, after: null, kind: 'deleted' },
    ]

    expect(describeChanges(changes)).toBe('1 new, 1 updated, 1 removed')
  })

  it('omits the kinds that did not occur', () => {
    expect(describeChanges([{ ref: 'a', before: null, after: A, kind: 'created' }])).toBe('1 new')
  })
})

describe('headOf', () => {
  it('finds the default branch head', () => {
    expect(headOf({ 'refs/heads/main': A }, 'main')).toBe(A)
  })

  it('is null when the branch is absent', () => {
    expect(headOf({ 'refs/heads/main': A }, 'trunk')).toBeNull()
  })
})

describe('webhookTriggersSync', () => {
  it('syncs on events that change what a mirror shows', () => {
    for (const event of ['push', 'create', 'delete', 'pull_request', 'issues'])
      expect(webhookTriggersSync(event)).toBe(true)
  })

  it('ignores events that change nothing here', () => {
    // A star arrives often and would turn popularity into load.
    expect(webhookTriggersSync('star')).toBe(false)
    expect(webhookTriggersSync('watch')).toBe(false)
    expect(webhookTriggersSync('ping')).toBe(false)
  })
})

describe('remoteKey', () => {
  it('is case-insensitive', () => {
    expect(remoteKey('StacksJS', 'Stacks')).toBe(remoteKey('stacksjs', 'stacks'))
  })

  it('ignores a .git suffix', () => {
    // The same repository is reachable with and without it; a mirror stored
    // one way must still match a hook that used the other.
    expect(remoteKey('stacksjs', 'stacks.git')).toBe('stacksjs/stacks')
  })
})
