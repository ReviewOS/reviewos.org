// Workflow commands: the line protocol a step uses to talk back.
//
// Every linter, compiler and test runner people already use has an Actions
// reporter, so honouring this format exactly is what makes those reporters work
// here with no change. The parser's most important property is the negative
// one: it must not find commands in ordinary output.

import { describe, expect, test } from 'bun:test'
import { CommandReader, readCommand } from '../../app/Actions/Runner/commands'

describe('reading one line', () => {
  test('ordinary output is ordinary output', () => {
    for (const line of ['hello', '  ::not at the start', 'error: something failed', '']) {
      const result = readCommand(line)

      expect(result.line).toBe(line)
      expect(result.annotation).toBeNull()
    }
  })

  test('an error with a file and a line becomes an annotation', () => {
    const result = readCommand('::error file=src/a.ts,line=12::Undefined name')

    expect(result.annotation).toMatchObject({
      level: 'error',
      path: 'src/a.ts',
      startLine: 12,
      endLine: 12,
      message: 'Undefined name',
    })
  })

  test('and stays in the log as well', () => {
    // A message that appears only on a diff is one nobody finds when they are
    // reading the log, which is where they are when something failed.
    const result = readCommand('::error::it broke')

    expect(result.line).toBe('::error::it broke')
  })

  test('warnings and notices, with a title and a range', () => {
    const warning = readCommand('::warning file=a.ts,line=3,endLine=9,title=Slow::This loop is quadratic')

    expect(warning.annotation).toMatchObject({
      level: 'warning',
      startLine: 3,
      endLine: 9,
      title: 'Slow',
    })

    expect(readCommand('::notice::just so you know').annotation?.level).toBe('notice')
  })

  test('escaped characters come back, and only the ones the format escapes', () => {
    /*
     * Two escapings, deliberately different. A *message* escapes `%`, carriage
     * return and newline - that is all the toolkit does - while a *property*
     * escapes the comma and colon that separate properties from each other.
     *
     * Unescaping `%3A` in a message as well would look tidier and be wrong: a
     * tool printing a literal `%3A`, which is ordinary text in a URL-encoded
     * string, would have it silently rewritten into a colon.
     */
    const message = readCommand('::error file=a.ts::Line one%0Aline two, and 100%25')

    expect(message.annotation?.message).toBe('Line one\nline two, and 100%')

    const property = readCommand('::error file=src%3Aodd%2Cname.ts,line=2::broken')

    expect(property.annotation?.path).toBe('src:odd,name.ts')
  })

  test('a mask drops its own line', () => {
    // `::add-mask::hunter2` contains the secret it is asking to hide, and
    // logging it would publish the value in the act of protecting it.
    const result = readCommand('::add-mask::hunter2')

    expect(result.line).toBeNull()
    expect(result.mask).toBe('hunter2')
  })

  test('groups pass through, because the log renderer reads them', () => {
    expect(readCommand('::group::Install').group).toBe('start')
    expect(readCommand('::endgroup::').group).toBe('end')
    expect(readCommand('::group::Install').line).toBe('::group::Install')
  })

  /*
   * The deprecated forms. A workflow still using them should see them rather
   * than have them silently swallowed: the file protocol replaced them, and a
   * line that vanished is worse than one that did nothing.
   */
  test('an unknown command is logged as the text it is', () => {
    expect(readCommand('::set-output name=a::1').line).toBe('::set-output name=a::1')
    expect(readCommand('::set-output name=a::1').annotation).toBeNull()
  })
})

describe('reading a stream', () => {
  test('a mask hides the value in every later line', () => {
    const reader = new CommandReader()

    expect(reader.read('::add-mask::s3cret').line).toBeNull()
    expect(reader.read('token is s3cret here').line).toBe('token is *** here')
  })

  test('and in the same line that would have printed it', () => {
    const reader = new CommandReader()

    reader.addMask('s3cret')

    expect(reader.read('::error::s3cret leaked').line).toBe('::error::*** leaked')
    expect(reader.read('::error::s3cret leaked').annotation?.message).toBe('s3cret leaked')
  })

  test('a longer secret containing a shorter one leaves no fragment', () => {
    const reader = new CommandReader()

    reader.addMask('abc')
    reader.addMask('abcdef')

    expect(reader.read('value abcdef here').line).toBe('value *** here')
  })

  test('very short values are not masked, or every log becomes asterisks', () => {
    const reader = new CommandReader()

    reader.addMask('a')

    expect(reader.read('a normal line').line).toBe('a normal line')
  })

  /*
   * A build that prints something looking like a command gets to say so. The
   * pause ends only on the exact token, because a stream that can be resumed by
   * accident is one an attacker resumes on purpose.
   */
  test('stop-commands pauses the protocol until its token', () => {
    const reader = new CommandReader()

    expect(reader.read('::stop-commands::my-token').line).toBeNull()
    expect(reader.read('::error file=a.ts::not a command now').annotation).toBeNull()
    expect(reader.read('::error file=a.ts::not a command now').line).toBe('::error file=a.ts::not a command now')
    expect(reader.read('::not-the-token::').line).toBe('::not-the-token::')

    expect(reader.read('::my-token::').resume).toBe('::my-token::')
    expect(reader.read('::error::back on').annotation?.level).toBe('error')
  })

  test('and masking still applies while commands are paused', () => {
    const reader = new CommandReader()

    reader.addMask('s3cret')
    reader.read('::stop-commands::t')

    expect(reader.read('printing s3cret').line).toBe('printing ***')
  })
})
