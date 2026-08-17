/**
 * Workflow commands: the line protocol a step uses to talk back.
 *
 * `::error file=src/a.ts,line=12::Undefined name` on stdout is how a build tool
 * that knows nothing about this instance puts a message on line 12 of a diff.
 * That is the whole reason the protocol is worth implementing exactly: every
 * linter, compiler and test runner people already use has an Actions reporter,
 * and honouring the format means those reporters work here with no change.
 *
 * Parsed here rather than in the runner's loop so the cases can be tested
 * without spawning anything - and the cases are all edge cases. A command is a
 * line of text in a stream that also contains program output, which means the
 * parser's most important property is **not** finding commands where none were
 * intended.
 */

export type AnnotationLevel = 'notice' | 'warning' | 'error'

export interface Annotation {
  level: AnnotationLevel
  message: string
  /** The file, when the command named one. */
  path: string | null
  startLine: number | null
  endLine: number | null
  title: string | null
}

export interface CommandResult {
  /** The line as it should be logged, or null when the command consumed it. */
  line: string | null
  annotation: Annotation | null
  /** A value to mask everywhere it appears from now on. */
  mask: string | null
  /** `::group::` and `::endgroup::` pass through: the log renderer reads them. */
  group: 'start' | 'end' | null
  /** `::stop-commands::TOKEN` and its matching resume. */
  stop: string | null
  resume: string | null
}

const COMMAND = /^::([a-z-]+)((?:\s+[^:]*)?)::([\s\S]*)$/

/**
 * Read one line as a workflow command, or as ordinary output.
 *
 * Ordinary output is the common case by a very long way, so the check is a
 * cheap prefix test before anything else: a log line that does not start with
 * `::` cannot be a command, and a build printing a hundred thousand lines
 * should not pay a regular expression for each of them.
 */
export function readCommand(line: string): CommandResult {
  const empty: CommandResult = { line, annotation: null, mask: null, group: null, stop: null, resume: null }

  if (!line.startsWith('::'))
    return empty

  const match = COMMAND.exec(line.trimEnd())

  if (!match)
    return empty

  const name = String(match[1]).toLowerCase()
  const properties = parseProperties(String(match[2] ?? ''))
  const value = String(match[3] ?? '')

  switch (name) {
    case 'error':
    case 'warning':
    case 'notice': {
      return {
        ...empty,
        // Kept in the log as well as annotated. A message that appears only on
        // a diff is one nobody finds when they are reading the log, which is
        // where they are when something failed.
        line,
        annotation: {
          level: name as AnnotationLevel,
          message: unescapeData(value),
          path: properties.file ?? null,
          startLine: toLine(properties.line),
          endLine: toLine(properties.endLine ?? properties.line),
          title: properties.title ?? null,
        },
      }
    }

    case 'add-mask':
      /*
       * The line is dropped, not logged. `::add-mask::hunter2` contains the
       * secret it is asking to hide, and logging it would publish the value in
       * the act of protecting it.
       */
      return { ...empty, line: null, mask: value.trim() || null }

    case 'group':
      return { ...empty, group: 'start' }

    case 'endgroup':
      return { ...empty, group: 'end' }

    case 'stop-commands':
      // A build that prints something looking like a command gets to say so:
      // everything until the resume token is text.
      return { ...empty, line: null, stop: value.trim() || null }

    case 'debug':
      return { ...empty }

    default:
      /*
       * An unknown command is logged as the text it is.
       *
       * `::set-output::` and `::save-state::` are the deprecated forms, and a
       * workflow still using them should see them rather than have them
       * silently swallowed - the file protocol replaced them, and a line that
       * vanished is worse than one that did nothing.
       */
      return empty
  }
}

/**
 * A stream of lines, with the state a command protocol needs between them.
 *
 * `::stop-commands::` and masking are both stateful, and both are the sort of
 * state that is wrong the moment it is per-line: a mask registered by step one
 * has to hide the same value in step nine.
 */
export class CommandReader {
  private stopped: string | null = null
  private readonly masks = new Set<string>()

  /** Everything the reader learned from this line, with the line to log. */
  read(line: string): CommandResult {
    if (this.stopped !== null) {
      const trimmed = line.trim()

      // The resume token is `::TOKEN::`, and only exactly that ends the pause.
      if (trimmed === `::${this.stopped}::`) {
        this.stopped = null

        return { line: null, annotation: null, mask: null, group: null, stop: null, resume: trimmed }
      }

      return { line: this.mask(line), annotation: null, mask: null, group: null, stop: null, resume: null }
    }

    const result = readCommand(line)

    if (result.stop) {
      this.stopped = result.stop

      return result
    }

    if (result.mask)
      this.masks.add(result.mask)

    return { ...result, line: result.line === null ? null : this.mask(result.line) }
  }

  /**
   * Replace every registered value with `***`.
   *
   * Longest first, so a secret that contains another secret does not leave a
   * fragment of the longer one behind after the shorter has been replaced.
   */
  mask(text: string): string {
    if (this.masks.size === 0)
      return text

    let masked = text

    for (const secret of [...this.masks].sort((one, two) => two.length - one.length)) {
      if (secret.length < 3)
        continue

      masked = masked.split(secret).join('***')
    }

    return masked
  }

  /** Register a value to hide, for secrets the runner knows before any output. */
  addMask(value: string): void {
    const trimmed = String(value ?? '').trim()

    if (trimmed.length >= 3)
      this.masks.add(trimmed)
  }
}

/** `file=src/a.ts,line=12,col=3` into a record, with Actions' escaping undone. */
function parseProperties(text: string): Record<string, string> {
  const properties: Record<string, string> = {}

  for (const pair of text.trim().split(',')) {
    const index = pair.indexOf('=')

    if (index <= 0)
      continue

    const key = pair.slice(0, index).trim()
    const value = pair.slice(index + 1).trim()

    if (!key)
      continue

    // `endLine` and `endColumn` are camel-cased in the format; everything else
    // is lower case, and matching case-insensitively is kinder than being right.
    properties[key === 'endline' ? 'endLine' : key] = unescapeProperty(value)
  }

  return properties
}

function toLine(value: string | undefined): number | null {
  if (value === undefined)
    return null

  const parsed = Number.parseInt(value, 10)

  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

/** The escaping Actions defines for a command's data. */
function unescapeData(text: string): string {
  return text
    .replace(/%25/g, '%')
    .replace(/%0D/g, '\r')
    .replace(/%0A/g, '\n')
}

/** Properties escape two more characters, because they are comma-separated. */
function unescapeProperty(text: string): string {
  return unescapeData(text)
    .replace(/%3A/g, ':')
    .replace(/%2C/g, ',')
}
