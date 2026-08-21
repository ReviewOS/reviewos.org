/**
 * How the host and the guest talk, and why a step cannot lie on that channel.
 *
 * The guest's serial console is the only wire out of a machine that has no
 * network to the host and no shared filesystem. Everything the job prints comes
 * back on it, and so does everything the agent says about how the job went - and
 * that is the problem this file exists for.
 *
 * ## A step can print anything, including whatever the agent prints
 *
 * If the agent announced a result with a line like `##STEP 0 exit=0`, then a
 * step whose own output contained that line would announce its own success.
 * That is not an exotic attack: it is `echo` in a repository somebody opened a
 * pull request from, and the whole point of the machine is that its contents are
 * a stranger's.
 *
 * Two things together close it.
 *
 * **Length framing.** The agent declares how many bytes of output follow, and
 * the host reads exactly that many without looking at them. Content cannot end a
 * frame it does not get to be scanned for, so a step's output can contain any
 * byte sequence at all - including a perfect copy of a header - and be delivered
 * as data.
 *
 * **A nonce the guest cannot read by the time it could matter.** The header
 * carries a random token the *host* generated. The agent is given it on the
 * payload disk and unlinks it before the first step runs, so a step has nothing
 * to read it from: not the disk, not the agent's argv, not the kernel command
 * line. A forged header without the nonce is not a header.
 *
 * Either alone is weak. Framing without a nonce lets a step emit a header that
 * declares a length and swallow the real one; a nonce without framing lets a
 * step that somehow learns it end a frame early. Together the host is never
 * parsing attacker-chosen bytes for control information.
 *
 * ## Why not vsock
 *
 * It is the better channel and it is more to build: a device, a guest-side
 * client, a host-side listener, and a framing protocol anyway. The console is
 * already there, already carries the job's output, and the framing above is the
 * part that would have to be written for vsock too. This is the first thing that
 * works; vsock is what it is replaced with when the console's bandwidth becomes
 * the limit rather than the design.
 */

/** What the guest reports about one step. */
export interface StepReport {
  index: number
  exitCode: number
  /** Everything the step wrote, in order, as the agent framed it. */
  output: string
}

export interface ConsoleReading {
  /** The steps the guest reported, in the order it ran them. */
  steps: StepReport[]
  /** Whether the agent said it finished, as opposed to the machine stopping. */
  finished: boolean
  /** Console text that was not part of any frame - kernel messages, mostly. */
  noise: string
}

/**
 * The header the agent writes.
 *
 * It begins with `\x01`, a byte no build script emits on purpose, and it is
 * found by *scanning for that byte* rather than by splitting the console into
 * lines. The difference matters: a guest kernel writes to the same console and
 * does not coordinate its newlines with the agent, so a header can land halfway
 * through a boot message. A line-oriented parser drops it, and the job it
 * belonged to reports nothing.
 */
const SENTINEL = '\x01RVOS '
const HEADER = /^([0-9a-f]{32}) (BEGIN|DATA|END|FINISHED)(?: (-?\d+))?(?: (-?\d+))?\r?$/

/**
 * A nonce for one machine.
 *
 * Host-generated, because the point is that the guest did not choose it. Long
 * enough that guessing is not a strategy and short enough to read in a log.
 */
export function bootNonce(random: () => number = Math.random): string {
  let value = ''

  while (value.length < 32)
    value += Math.floor(random() * 0xFFFFFFFF).toString(16).padStart(8, '0')

  return value.slice(0, 32)
}

/**
 * Read what the guest said.
 *
 * The parser never scans framed bytes. It reads a header, takes the byte count
 * the header declared, and resumes looking for the next header after them - so
 * a step that prints a header inside its own output is printing data, and is
 * delivered as data.
 *
 * Anything outside a frame is noise rather than an error: a guest kernel writes
 * to the same console, and a boot message is not a protocol violation.
 */
export function readConsole(text: string, nonce: string): ConsoleReading {
  const steps: StepReport[] = []
  const noise: string[] = []

  let finished = false
  let current: { index: number, chunks: string[] } | null = null
  let rest = String(text ?? '')

  while (rest.length > 0) {
    const at = rest.indexOf(SENTINEL)

    if (at === -1) {
      noise.push(rest)
      break
    }

    // Everything before the sentinel is somebody else writing to the console.
    if (at > 0)
      noise.push(rest.slice(0, at))

    const afterSentinel = rest.slice(at + SENTINEL.length)
    const newline = afterSentinel.indexOf('\n')
    const line = newline === -1 ? afterSentinel : afterSentinel.slice(0, newline)
    const after = newline === -1 ? '' : afterSentinel.slice(newline + 1)

    const match = HEADER.exec(line)

    /*
     * A header whose nonce is wrong is not a header. This is the line that makes
     * forgery pointless, and it is deliberately checked before the verb: a step
     * that guesses the shape learns nothing without the token.
     */
    if (!match || match[1] !== nonce) {
      noise.push(SENTINEL + line)
      rest = after
      continue
    }

    const verb = match[2]

    if (verb === 'FINISHED') {
      finished = true
      rest = after
      continue
    }

    if (verb === 'BEGIN') {
      current = { index: Number(match[3] ?? 0), chunks: [] }
      rest = after
      continue
    }

    if (verb === 'DATA') {
      const length = Math.max(0, Number(match[3] ?? 0))

      /*
       * The bytes are taken, not parsed. Whatever is in them - including a
       * flawless copy of this header, nonce and all - is somebody's build
       * output and travels as such.
       */
      const payload = after.slice(0, length)

      if (current)
        current.chunks.push(payload)
      else
        noise.push(payload)

      rest = after.slice(length)

      /*
       * The agent writes a newline after a frame so a console reader stays
       * legible; it is part of the framing rather than of the data - and it may
       * arrive as CRLF if anything in the path is still translating.
       */
      if (rest.startsWith('\r'))
        rest = rest.slice(1)

      if (rest.startsWith('\n'))
        rest = rest.slice(1)

      continue
    }

    // END
    if (current) {
      steps.push({ index: current.index, exitCode: Number(match[4] ?? match[3] ?? 1), output: current.chunks.join('') })
      current = null
    }

    rest = after
  }

  return { steps, finished, noise: noise.join('\n') }
}

/**
 * The agent, as a shell program.
 *
 * Shipped as a string because it belongs to the *image*, and the image is built
 * by an operator and pinned by digest - so this is the source of what they build
 * rather than something the host injects at boot. A guest that could be handed
 * its agent by the host would be a guest whose behaviour the host could change
 * after the image was pinned, which is most of what pinning is for.
 *
 * Written in `sh` because the image's job is to hold a toolchain, not a runtime
 * for this.
 */
export function guestAgent(): string {
  return `#!/bin/sh
# The ReviewOS guest agent. Runs one job's steps and reports them on the
# console, framed so that a step's own output cannot impersonate a report.
set -u

mount -t proc proc /proc 2>/dev/null
mount -t sysfs sys /sys 2>/dev/null

# The root filesystem is read-only, deliberately and permanently - it is the
# image, and the whole point is that a job cannot change what the next job boots.
# So everything this needs to write goes on a tmpfs or on the payload disk, and
# /work has to already exist in the image because a read-only root cannot be
# given a new directory here.
mount -t tmpfs tmpfs /tmp 2>/dev/null
mount /dev/vdb /work 2>/dev/null

# A serial console translates \\n into \\r\\n by default. That is fatal to length
# framing rather than merely untidy: the host is told how many bytes to expect
# and the line discipline then inserts more, so every count is wrong by the
# number of newlines in the output and the frames slide out of alignment.
stty -onlcr < /dev/console 2>/dev/null || stty -onlcr 2>/dev/null || true

# And the echo off, before anything is read.
#
# A serial console echoes what is written to it straight back out - which on this
# wire means into the job's log. The secrets arrive on that wire, so leaving the
# echo on would print every one of them to the thing they must never reach.
stty -echo < /dev/console 2>/dev/null || stty -echo 2>/dev/null || true

NONCE=$(cat /work/nonce 2>/dev/null || echo missing)

# How much one step may print. Not a secret, so it travels on the payload disk
# with the steps rather than over the console with the credentials.
MAXOUT=$(cat /work/maxout 2>/dev/null || echo 1048576)

# Read once, then remove. After this line there is nowhere for a step to learn
# the token from: not the disk, not this script's arguments, not /proc/cmdline.
rm -f /work/nonce

say() { printf '\\001RVOS %s %s\\n' "$NONCE" "$*"; }

# The secrets, read once from the console before any step runs.
#
# Into the environment and nowhere else: not onto the payload disk, not into a
# file under /tmp. The value exists in this process's memory and in the
# environment of the steps it spawns, which is exactly where it lives on a host
# runner - and on no filesystem on either side of the boundary.
read_secrets() {
  # Ask first, then read.
  #
  # The host cannot simply write at boot: bytes sent to the serial console
  # before the guest has opened the device are dropped on the floor, silently
  # and partially - a probe sent HELLO-FROM-HOST-STDIN and the guest received
  # LLO-FROM-HOST-STDIN. A frame written that early is lost entirely, and a
  # reader waiting for its newline waits for ever.
  #
  # So the guest announces that it is listening and the host answers. The
  # ordering is the fix; the timeout below is what keeps a host that never
  # answers from being a machine that never ends.
  say "WANT-SECRETS"

  IFS= read -r -t 30 header || return 0

  case "$header" in
    *"RVOS $NONCE SECRETS "*) ;;
    *) return 0 ;;
  esac

  size=\${header##* }
  [ "$size" -gt 0 ] 2>/dev/null || return 0

  # Exactly the declared bytes, for the reason everything on this wire is length
  # framed: a secret may contain anything, including whatever a terminator would
  # have been.
  # A fixed name, not $$.
  #
  # The left side of this pipeline runs in a subshell, and $$ is not reliably the
  # same number there as it is here - so the file being written was not always
  # the file being read, and the secrets simply did not arrive. Nothing errored;
  # the loop below read an absent file and exported nothing.
  # The trailing test keeps a final record without a newline: read returns
  # false at end of input even when it read something, and a host declaring a
  # length that excluded its own newline was exactly how one secret became no
  # secrets, silently.
  head -c "$size" | while IFS=' ' read -r name encoded || [ -n "$name" ]; do
    [ -n "$name" ] || continue
    printf '%s=%s\\n' "$name" "$(printf '%s' "$encoded" | base64 -d 2>/dev/null)"
  done > /tmp/.rvos-secrets

  while IFS= read -r line; do
    [ -n "$line" ] || continue
    export "$line"
  done < /tmp/.rvos-secrets

  # /tmp is a tmpfs - RAM, not the image - and this removes it anyway, so a step
  # cannot read the set out of a file even in memory.
  rm -f /tmp/.rvos-secrets
}

read_secrets

emit() {
  # Declare the length, then the bytes. The host reads exactly that many and
  # never scans them, so output containing a header is output.
  size=$(wc -c < "$1")

  # Bounded, because the way out is a serial console.
  #
  # It is slow in a way a pipe is not: a step that printed fifty megabytes did
  # not produce a large log, it produced a machine still transmitting when the
  # wall clock killed it - and a job that failed with a timeout saying nothing
  # about the step being chatty. Truncating turns that into a log with a line
  # naming what is missing, which is the trade the host runner's ceiling makes.
  if [ "$size" -gt "$MAXOUT" ] 2>/dev/null; then
    head -c "$MAXOUT" "$1" > /tmp/.rvos-trunc
    printf '\n[%s bytes dropped: this step printed more than this runner allows]\n' "$((size - MAXOUT))" >> /tmp/.rvos-trunc
    set -- /tmp/.rvos-trunc
    size=$(wc -c < "$1")
  fi

  say "DATA $size"
  cat "$1"
  printf '\n'
}

cd /work/workspace 2>/dev/null || cd /tmp

index=0
while [ -f "/work/steps/$index.sh" ]; do
  say "BEGIN $index"
  sh "/work/steps/$index.sh" > "/tmp/out.$index" 2>&1
  code=$?
  emit "/tmp/out.$index"
  say "END $index $code"

  # A failed step ends the job, the same as it does on a host runner.
  [ "$code" -eq 0 ] || break

  index=$((index + 1))
done

say "FINISHED"
sync
poweroff -f
`
}
