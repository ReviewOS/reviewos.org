// The audit catalogue, and the two lists that have to agree with it.
//
// `AUDIT_EVENTS` is written by hand beside the `AuditEventName` type because a
// type does not survive to runtime and the listener needs to say what it
// listens to. Two hand-written lists drift, and the way this one would drift is
// the worst available: an event added to the type, emitted by an action, and
// missing from the list - so the listener never registers for it and the row is
// never written. Nothing fails, nothing logs, and the gap is found by whoever
// is reconstructing an incident.
//
// So: the type is read out of the source, and compared.

import { describe, expect, test } from 'bun:test'
import { AUDIT_EVENTS } from '../../app/Audit/events'

/**
 * An `auditEvent` call, including the ternary form.
 *
 * `auditEvent(promote ? 'admin:granted' : 'admin:revoked', …)` is a natural way
 * to write a pair that differ by one word, and a scanner that only matched a
 * literal first argument reported both as unemitted - which would have pushed
 * the code into two near-identical calls to satisfy the test. A test that
 * dictates the shape of the code it checks is a test that has started making
 * decisions it is not qualified to make.
 */
const EMITTED = /auditEvent\(\s*(?:[^,')]*\?\s*)?'([^']+)'(?:\s*:\s*'([^']+)')?/g

function addNames(into: Set<string>, match: RegExpMatchArray): void {
  for (const name of [match[1], match[2]])
    if (name)
      into.add(name)
}

/** Every string literal in the `AuditEventName` union, read from the file. */
async function namesInType(): Promise<string[]> {
  const source = await Bun.file(new URL('../../app/Audit/events.ts', import.meta.url)).text()
  const start = source.indexOf('export type AuditEventName')
  const end = source.indexOf('\n\n', start)

  expect(start).toBeGreaterThan(-1)

  return [...source.slice(start, end).matchAll(/'([^']+)'/g)].map(match => match[1]!)
}

describe('the audit catalogue', () => {
  test('the runtime list is exactly the type', async () => {
    expect([...AUDIT_EVENTS].sort()).toEqual((await namesInType()).sort())
  })

  test('no event is listed twice', () => {
    // A duplicate would register the listener twice for one event and write two
    // rows, which reads as two things having happened.
    expect(new Set(AUDIT_EVENTS).size).toBe(AUDIT_EVENTS.length)
  })

  test('every event is registered in app/Events.ts', async () => {
    // The listener declares its own `listensTo`, so this map is not what makes
    // it work - but `app/Events.ts` is where somebody looks to find out what is
    // wired to what, and a family that appears there in part reads as a family
    // that is wired in part.
    const events = (await import('../../app/Events')).default as Record<string, string[]>

    for (const name of AUDIT_EVENTS)
      expect(events[name]).toContain('RecordAudit')
  })

  test('every event is emitted by something', async () => {
    /*
     * The rule this codebase already wrote down once, in
     * `app/Actions/Tokens/audit.ts`: an event nothing can emit leaves a reader
     * of the catalogue believing the log answers a question it never will.
     *
     * Checked by searching the source rather than by running anything, because
     * the alternative is exercising twenty endpoints to prove a negative.
     */
    const emitters = new Set<string>()

    for await (const path of new Bun.Glob('app/**/*.ts').scan({ cwd: process.cwd() })) {
      if (path.endsWith('Audit/events.ts'))
        continue

      const source = await Bun.file(path).text()

      for (const match of source.matchAll(EMITTED))
        addNames(emitters, match)

      // `recordTokenAudit` passes its own `event` field through, so the token
      // events are emitted from there rather than named at a call site.
      if (path.endsWith('Tokens/audit.ts') && source.includes('auditEvent(entry.event')) {
        for (const match of source.matchAll(/\| '(token:[^']+)'/g))
          emitters.add(match[1]!)
      }
    }

    // `routes/` is outside `app/`, and the push protection bypass lives there.
    for await (const path of new Bun.Glob('routes/*.ts').scan({ cwd: process.cwd() })) {
      const source = await Bun.file(path).text()

      for (const match of source.matchAll(EMITTED))
        addNames(emitters, match)
    }

    expect([...AUDIT_EVENTS].filter(name => !emitters.has(name))).toEqual([])
  })

  test('nothing emits an event that is not in the catalogue', async () => {
    // The type already stops this at compile time. Asserted anyway because the
    // emitters take `any` requests and a cast is one edit away, and a row filed
    // under a name the reader cannot search for is a row nobody finds.
    const known = new Set<string>(AUDIT_EVENTS)
    const strays: Array<{ path: string, event: string }> = []

    for await (const path of new Bun.Glob('{app,routes}/**/*.ts').scan({ cwd: process.cwd() })) {
      if (path.endsWith('Audit/events.ts'))
        continue

      const source = await Bun.file(path).text()

      for (const match of source.matchAll(EMITTED)) {
        for (const name of [match[1], match[2]].filter(Boolean) as string[]) {
          if (!known.has(name))
            strays.push({ path, event: name })
        }
      }
    }

    // Reported with the file, so a failure says where rather than only what.
    expect(strays).toEqual([])
  })
})
