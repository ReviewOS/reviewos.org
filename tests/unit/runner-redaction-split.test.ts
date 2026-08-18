// A secret split across two writes.
//
// The roadmap asks for this case by name, and the answer is in two halves that
// are worth stating together, because either one alone reads as a hole:
//
//   - The **runner** catches it. A process writes bytes, not lines, so the
//     runner buffers until a newline and masks the joined line - which is why
//     masking on the machine is the first line and not a nicety.
//   - The **server** does not, and cannot without buffering a log it is meant to
//     be streaming. It sees one stored chunk at a time.
//
// A redaction feature people believe is total is worse than one whose edge they
// know, so both halves have a test rather than a paragraph.

import { describe, expect, test } from 'bun:test'
import { CommandReader } from '../../app/Actions/Runner/commands'
import { maskDeliveredSecrets } from '../../app/Actions/Runner/localExecutor'
import { MARKER, redactSecrets } from '../../app/Actions/Runner/redact'

const SECRET = 'ghp_supersecretvalue'

/** What the runner does with a stream: buffer to a newline, then read lines. */
function throughRunner(writes: readonly string[], secrets: string[]): string {
  const reader = new CommandReader()

  maskDeliveredSecrets(reader, { secrets: Object.fromEntries(secrets.map((one, index) => [`S${index}`, one])) })

  let pending = ''
  const out: string[] = []

  for (const write of writes) {
    pending += write

    const lines = pending.split('\n')
    pending = lines.pop() ?? ''

    for (const line of lines) {
      const result = reader.read(line)

      if (result.line !== null)
        out.push(result.line)
    }
  }

  if (pending) {
    const result = reader.read(pending)

    if (result.line !== null)
      out.push(result.line)
  }

  return out.join('\n')
}

describe('the runner', () => {
  test('masks a value split across two writes, because it buffers to a line', () => {
    /*
     * A process writes bytes. `curl` printing a failed request can flush in the
     * middle of a header, and a masker working per write would miss exactly the
     * case that matters.
     */
    const out = throughRunner(['authorization: Bearer ghp_super', 'secretvalue\n'], [SECRET])

    expect(out).not.toContain(SECRET)
    expect(out).toContain('***')
  })

  test('and still masks it when it arrives whole', () => {
    const out = throughRunner([`authorization: Bearer ${SECRET}\n`], [SECRET])

    expect(out).not.toContain(SECRET)
  })
})

describe('the server', () => {
  test('does not catch a value split across two stored chunks, and says so', () => {
    /*
     * The documented limitation. It sees one chunk at a time, and holding the
     * tail of every chunk to check the join would mean buffering a log that is
     * meant to be streamed - so the guarantee is the runner's, and this is the
     * second line that catches everything arriving whole.
     */
    const first = redactSecrets('authorization: Bearer ghp_super', [SECRET])
    const second = redactSecrets('secretvalue\n', [SECRET])

    expect(first + second).toContain(SECRET)
    expect(first + second).not.toContain(MARKER)
  })

  test('but does catch it when one chunk holds the whole value', () => {
    // Which is every ordinary case: a runner sends a chunk per flush, and a
    // credential printed in one write arrives in one chunk.
    expect(redactSecrets(`authorization: Bearer ${SECRET}\n`, [SECRET])).toContain(MARKER)
  })
})
