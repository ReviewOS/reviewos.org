/**
 * How a secret reaches a step running in another machine, and where it must not go.
 *
 * On the host path a job's secrets live in a process environment and nowhere
 * else: the runner holds them in memory and hands them to the step it spawns.
 * Crossing a machine boundary is what makes this a question, because every
 * obvious route writes them down somewhere.
 *
 * ## The routes that were refused, and why
 *
 * **The payload disk.** The obvious answer, and wrong for a reason this codebase
 * demonstrated rather than theorised: a payload disk is a file on the runner's
 * real filesystem, and its deletion is best-effort. A run whose `mkfs` failed
 * midway left a gigabyte behind, and it took a fix to teardown for that to stop
 * happening. Putting secrets there converts a memory-only credential into an
 * at-rest one, on exactly the object that has already been observed surviving a
 * bad afternoon.
 *
 * **The kernel command line.** Worse. `/proc/cmdline` is world-readable inside
 * the guest, and Firecracker's configuration - which contains the command line -
 * is a JSON file the supervisor writes to disk before booting.
 *
 * **A second disk on a tmpfs.** Better than either: RAM-backed on the host, so
 * nothing is at rest. Still refused, for two reasons. It adds a third drive to a
 * machine whose two-drive shape is a stated property, and a block device can be
 * re-read for the whole life of the machine - where the point of the design below
 * is that the secret is consumed once, before any step runs.
 *
 * ## The route taken
 *
 * The console, in the other direction. The guest already talks to the host over
 * its serial console; the host writes back to it, once, before the first step,
 * and the agent reads the values into its own environment and nothing else. The
 * secret is in RAM on both sides and never on a filesystem on either.
 *
 * Two details make that safe rather than merely clever, and both are the kind
 * that would be found the hard way:
 *
 * - **The console echoes by default.** Input written to a serial console comes
 *   straight back out as output - which on this channel means into the job's log.
 *   The agent turns the echo off before it reads.
 * - **The host masks the stream, not the chunk.** `redactSecrets` says plainly
 *   that a value split across two writes survives it, because it sees one chunk
 *   at a time. The console arrives in chunks of whatever size the pipe felt like,
 *   so masking each one in isolation would leak any secret unlucky enough to
 *   straddle a boundary. `Masker` below holds a tail back.
 *
 * ## What the runner does not decide
 *
 * Which secrets a job gets. The instance already scoped them - instance, pool,
 * owner, repository, environment, narrowest wins - and already refuses an
 * untrusted run any of them. The runner delivers what it was given and adds
 * nothing, which is why the only decision here is `deliverableSecrets`, and that
 * one exists as defence in depth rather than as policy.
 */

import { formsOf, redactSecrets } from './redact'

/**
 * What may cross into the machine.
 *
 * The instance decides this and has already decided it. This re-checks the one
 * rule whose failure is unrecoverable - an untrusted run receives nothing - so
 * that a claim endpoint that ever regressed would not silently hand a fork's
 * pull request somebody's deploy key. A second lock on the door that matters.
 */
export function deliverableSecrets(job: any): Record<string, string> {
  const trusted = job?.run?.trusted

  /*
   * `false` means untrusted; anything else - including absent - is trusted, and
   * that reading is deliberate. It matches `isNotFalse` on the host path, and a
   * runner that treated a missing field as untrusted would refuse every job the
   * instance did not annotate rather than failing safe in any useful sense.
   */
  if (trusted === false)
    return {}

  const given = job?.secrets

  if (!given || typeof given !== 'object')
    return {}

  const out: Record<string, string> = {}

  for (const [name, value] of Object.entries(given as Record<string, unknown>)) {
    // A name that is not an environment variable is dropped rather than
    // sanitised: a secret whose name arrives mangled is one a workflow will not
    // find under the name it wrote, and silently renaming it is worse than not
    // delivering it.
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(name))
      continue

    if (typeof value === 'string')
      out[name] = value
  }

  return out
}

/**
 * The frame the host writes to the guest's console.
 *
 * Values are base64 so a secret containing a newline cannot end the record it is
 * in, and the whole block is length-declared for the same reason the other
 * direction is: the reader takes the bytes rather than scanning for a
 * terminator that could be inside them.
 *
 * Carries the same nonce as everything else on this wire. It is not a secret to
 * the guest - the agent is about to be given real ones - it is what stops a
 * *previous* machine's buffered output being read as this machine's instructions.
 */
export function secretsFrame(nonce: string, secrets: Record<string, string>): string {
  const body = Object.entries(secrets)
    .map(([name, value]) => `${name} ${Buffer.from(String(value), 'utf8').toString('base64')}`)
    .join('\n')

  /*
   * The declared length **includes** the trailing newline, and that is not a
   * detail.
   *
   * `read` returns false at end of input even when it read a partial line, so a
   * body handed over without its final newline leaves the guest's loop skipping
   * the last record - which, for one secret, is all of them. It failed silently:
   * the header arrived, the bytes arrived, and nothing was exported.
   */
  const payload = body ? `${body}\n` : ''
  const bytes = Buffer.byteLength(payload, 'utf8')

  return `\x01RVOS ${nonce} SECRETS ${bytes}\n${payload}`
}

/**
 * Masking a stream rather than a chunk.
 *
 * `redactSecrets` is explicit that a value split across two writes survives it,
 * and points at the runner as the thing that sees the stream. On this path the
 * supervisor is that thing: the console arrives in chunks of whatever size the
 * pipe produced, and a secret that straddles two of them would go into the log
 * in two halves, each individually unrecognisable.
 *
 * So the tail of every chunk is held back - long enough to contain the longest
 * value being looked for - and only released once the next chunk has proved it
 * is not the start of one. The cost is that the last few hundred bytes of output
 * arrive when the next chunk does, or at `flush()`, which for a log is nothing.
 */
export class Masker {
  private readonly forms: string[]
  private readonly hold: number
  private pending = ''

  constructor(secrets: Record<string, string> | readonly string[]) {
    const values = Array.isArray(secrets) ? secrets : Object.values(secrets)

    this.forms = values.flatMap(value => formsOf(String(value)))

    /*
     * How much to keep back: one byte less than the longest thing being looked
     * for. Any less and a value could span the join unseen; any more is latency
     * for nothing.
     */
    this.hold = Math.max(0, this.forms.reduce((longest, form) => Math.max(longest, form.length), 0) - 1)
  }

  /**
   * The safe prefix of what has arrived so far, masked.
   *
   * **Everything held is redacted before anything is released**, which is the
   * part that took a leak to get right. Redacting only the portion being
   * released is not enough: a value that *starts* inside it and finishes in the
   * held tail is not a match yet, so its head goes out in the clear and the rest
   * is retained - and the retained half never matches either, because its head
   * has already left. The secret is emitted, in two pieces, having passed
   * through a masker.
   *
   * Redacting the whole buffer first means any complete occurrence is replaced
   * wherever it sits, and only a genuinely partial tail survives to be completed
   * by the next chunk.
   */
  push(chunk: string): string {
    if (this.forms.length === 0)
      return chunk

    const redacted = redactSecrets(this.pending + chunk, this.forms)

    if (redacted.length <= this.hold) {
      this.pending = redacted

      return ''
    }

    const cut = redacted.length - this.hold

    this.pending = redacted.slice(cut)

    return redacted.slice(0, cut)
  }

  /** Whatever is still held, at the end of the stream. */
  flush(): string {
    if (this.forms.length === 0 || this.pending === '')
      return ''

    // Already redacted on the way in; redacted again because the last chunk may
    // have completed a value that was partial when it was held.
    const rest = redactSecrets(this.pending, this.forms)

    this.pending = ''

    return rest
  }
}
