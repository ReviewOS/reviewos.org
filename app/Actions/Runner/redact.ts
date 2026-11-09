import { createHash } from 'node:crypto'

/**
 * Taking secrets out of a log before it is written down.
 *
 * The runner masks what it was given, and that is the first line: masking on
 * the machine is the only place a value can be removed *before* it crosses the
 * wire. This is the second, and it exists because the first is somebody else's
 * program. A runner that is old, patched, or hostile is still a runner this
 * instance accepts logs from, and "we asked it to mask" is not a property of
 * the stored log.
 *
 * **The way a credential reaches a log is never `echo $TOKEN`.** It is a curl
 * that failed and printed the request it tried, a stack trace with a
 * connection string in it, a debug flag somebody left on. Nobody types those,
 * which is why asking authors to be careful does not work and why this runs on
 * every chunk.
 */

/**
 * Values shorter than this are not redacted.
 *
 * A secret of `1` or `dev` would blank a digit or a word everywhere it appears
 * and turn every log on the instance into a redaction puzzle. A value that
 * short is not a secret being protected; it is a placeholder somebody set while
 * testing, and treating it as one costs every other log.
 */
export const MIN_REDACTABLE = 5

/** What replaces a secret. Visible, because a silent gap reads as a bug. */
export const MARKER = '[redacted]'

/**
 * The forms of a value worth looking for.
 *
 * The plain value, and the two encodings a credential routinely passes through
 * on its way into a log: base64, because half the ecosystem sends
 * `Authorization: Basic`, and percent-encoding, because a token in a URL is how
 * a failed curl prints one. Anything cleverer - case-insensitive matching,
 * partial values - starts destroying ordinary output.
 */
export function formsOf(value: string): string[] {
  const raw = String(value ?? '')

  if (raw.length < MIN_REDACTABLE)
    return []

  const forms = new Set<string>([raw])

  try {
    forms.add(Buffer.from(raw, 'utf8').toString('base64'))
  }
  catch { /* a value that cannot be encoded is still redacted in its plain form */ }

  try {
    const encoded = encodeURIComponent(raw)

    if (encoded !== raw)
      forms.add(encoded)
  }
  catch { /* same */ }

  return [...forms].filter(one => one.length >= MIN_REDACTABLE)
}

/**
 * One chunk of log, with every secret in it replaced.
 *
 * Longest first, so a secret that contains another secret does not leave the
 * inner one's marker embedded in the outer one's remains.
 *
 * Streaming ingestion also uses redactStream, which masks incomplete matches
 * before publication and carries only fingerprints and offsets across chunks.
 */
export function redactSecrets(text: string, values: readonly string[]): string {
  return redactWithCount(text, values).text
}

/**
 * The same pass, and how much it took out.
 *
 * The count is what turns redaction from a thing that happened into a thing a
 * reader is told about. A log that silently drops a value is indistinguishable
 * from a log that never had one, and the difference matters to the person
 * asking why the curl failed: "three values were removed here" sends them to
 * the secrets page, and nothing sends them nowhere.
 */
export function redactWithCount(text: string, values: readonly string[]): { text: string, count: number } {
  if (!text)
    return { text, count: 0 }

  const forms = [...new Set(values.flatMap(formsOf))].sort((left, right) => right.length - left.length)

  let out = text
  let count = 0

  for (const form of forms) {
    if (!out.includes(form))
      continue

    const parts = out.split(form)
    count += parts.length - 1
    out = parts.join(MARKER)
  }

  return { text: out, count }
}

/**
 * How many values were taken out of text that was redacted already.
 *
 * Reading the stored text rather than a stored number, deliberately. Logs are
 * redacted on the way in, which means every chunk written before this function
 * existed carries its markers and no count - and a stored count would report
 * zero for all of them, which is the one wrong answer that matters. Counting
 * what is actually there can never say "nothing was hidden" about text where
 * something was.
 *
 * The cost is the opposite error: a job that literally prints `[redacted]`
 * inflates its own count. That is visible, harmless, and vanishingly rare next
 * to under-reporting.
 */
export function countRedactions(text: string): number {
  if (!text)
    return 0

  return text.split(MARKER).length - 1
}

export interface RedactionCheckpoint { key: string, offset: number }

/**
 * Publish safely without retaining raw lookbehind. A trailing possible secret
 * prefix is masked immediately, even if a later chunk proves it ordinary text.
 * The next chunk resumes that matcher from a fingerprint and character offset.
 * This conservative boundary masking trades a little output for zero secret
 * bytes in storage, no delayed tail, and correct multi-chunk matching.
 */
export function redactStream(text: string, values: readonly string[], previous: readonly RedactionCheckpoint[] = []) {
  const forms = [...new Set(values.flatMap(formsOf))]
  const ranges: Array<[number, number]> = []
  const checkpoint: RedactionCheckpoint[] = []
  for (const form of forms) {
    const key = createHash('sha256').update(form).digest('hex')
    // KMP failure links keep both work and checkpoint size linear, including
    // credentials with a long repeated prefix. One offset represents every
    // shorter possible match through its failure chain.
    const failure = new Uint32Array(form.length)
    for (let index = 1, prefix = 0; index < form.length; index++) {
      while (prefix && form[index] !== form[prefix]) prefix = failure[prefix - 1]!
      if (form[index] === form[prefix]) prefix++
      failure[index] = prefix
    }
    let matched = Math.max(0, ...previous.filter(one => one.key === key && one.offset > 0 && one.offset < form.length).map(one => one.offset))
    let carriedEnd = 0
    for (let index = 0; index < text.length; index++) {
      while (matched && text[index] !== form[matched]) matched = failure[matched - 1]!
      if (text[index] === form[matched]) matched++
      // Characters extending a match begun in the previous chunk must never
      // become visible, even if the candidate fails later in this write.
      if (matched && index - matched + 1 < 0) carriedEnd = index + 1
      if (matched === form.length) {
        ranges.push([Math.max(0, index - form.length + 1), index + 1])
        matched = failure[matched - 1]!
      }
    }
    if (carriedEnd) ranges.push([0, carriedEnd])
    if (matched) {
      ranges.push([Math.max(0, text.length - matched), text.length])
      checkpoint.push({ key, offset: matched })
    }
  }
  ranges.sort((left, right) => left[0] - right[0])
  const merged: Array<[number, number]> = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1])
    else merged.push([...range])
  }
  let output = ''
  let cursor = 0
  for (const [start, end] of merged) {
    output += text.slice(cursor, start) + MARKER
    cursor = end
  }
  return { text: output + text.slice(cursor), checkpoint }
}
