import { describe, expect, test } from 'bun:test'
import { CommandReader } from '../../app/Actions/Runner/commands'
import { maskDeliveredSecrets } from '../../app/Actions/Runner/localExecutor'
import { MARKER, redactSecrets, redactStream } from '../../app/Actions/Runner/redact'

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
  test('masks a secret across two, many, and single-character chunks before publication', () => {
    for (const writes of [['authorization: Bearer ghp_super', 'secretvalue\n'], [...SECRET], ['gh', 'p_su', 'perse', 'cret', 'value']]) {
      let checkpoint = []
      let output = ''
      for (const write of writes) {
        const result = redactStream(write, [SECRET], checkpoint)
        checkpoint = result.checkpoint
        output += result.text
        expect(result.text).not.toContain(write === SECRET ? SECRET : 'ghp_super')
        expect(JSON.stringify(checkpoint)).not.toContain('ghp_')
      }
      expect(output).not.toContain(SECRET)
      expect(output).toContain(MARKER)
    }
  })

  test('protects encoded forms and a partial tail that never gets another write', () => {
    for (const form of [Buffer.from(SECRET).toString('base64'), encodeURIComponent('password:with/spaces')]) {
      const secret = form.includes('%') ? 'password:with/spaces' : SECRET
      const first = redactStream('token=' + form.slice(0, 3), [secret])
      const second = redactStream(form.slice(3), [secret], first.checkpoint)
      expect(first.text + second.text).not.toContain(form)
      expect(first.text).not.toContain(form.slice(0, 3))
      expect(second.text).toContain(MARKER)
    }
  })

  test('but does catch it when one chunk holds the whole value', () => {
    // Which is every ordinary case: a runner sends a chunk per flush, and a
    // credential printed in one write arrives in one chunk.
    expect(redactSecrets(`authorization: Bearer ${SECRET}\n`, [SECRET])).toContain(MARKER)
  })
})
