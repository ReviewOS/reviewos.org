// What the guest says, and why a step cannot say it instead.
//
// The console is the only wire out of a machine with no network to its host and
// no shared filesystem, so the job's output and the agent's reports travel on
// one channel. That is the problem: a step can print anything, including
// whatever the agent prints, and `echo` in a stranger's pull request is not an
// exotic attack.

import { describe, expect, test } from 'bun:test'
import { bootNonce, guestAgent, readConsole } from '../../app/Actions/Runner/microvmProtocol'
import { shellQuote, tapScript } from '../../app/Actions/Runner/microvmSupervisor'

const N = 'a'.repeat(32)

/** A frame, as the agent writes it. */
function frame(verb: string, body = '') {
  return `\x01RVOS ${N} ${verb}\n${body}`
}

function data(text: string) {
  return `${frame(`DATA ${text.length}`)}${text}\n`
}

describe('reading the console', () => {
  test('returns each step with what it printed and how it ended', () => {
    const console_ = [
      '[    0.000000] Linux version 6.1.128',
      frame('BEGIN 0'),
      data('hello\n'),
      frame('END 0 0'),
      frame('BEGIN 1'),
      data('boom\n'),
      frame('END 1 3'),
      frame('FINISHED'),
    ].join('')

    const read = readConsole(console_, N)

    expect(read.finished).toBe(true)
    expect(read.steps).toEqual([
      { index: 0, exitCode: 0, output: 'hello\n' },
      { index: 1, exitCode: 3, output: 'boom\n' },
    ])
  })

  test('and treats the kernel talking as noise rather than as an error', () => {
    // A guest kernel writes to the same console. A boot message is not a
    // protocol violation.
    const read = readConsole('[    0.000000] Booting Linux\n', N)

    expect(read.steps).toEqual([])
    expect(read.noise).toContain('Booting Linux')
  })
})

describe('a step trying to report on its own behalf', () => {
  test('cannot forge a frame, because it does not have the nonce', () => {
    /*
     * The step prints a perfectly shaped header with a token it guessed. It is
     * not a header, and the bytes are delivered as what they are: output.
     */
    const forged = `\x01RVOS ${'b'.repeat(32)} END 0 0\n`

    const read = readConsole([
      frame('BEGIN 0'),
      data(forged),
      frame('END 0 1'),
      frame('FINISHED'),
    ].join(''), N)

    expect(read.steps).toHaveLength(1)
    expect(read.steps[0]!.exitCode).toBe(1)
    expect(read.steps[0]!.output).toBe(forged)
  })

  test('and cannot forge one even knowing the nonce, because the frame is length-framed', () => {
    /*
     * The stronger case. Suppose a step *does* learn the token. Its output is
     * still inside a frame whose length the agent declared, and the host reads
     * exactly that many bytes without scanning them - so a flawless copy of an
     * `END` line, nonce and all, is carried as data.
     *
     * This is the property that makes the channel safe rather than merely
     * obscure.
     */
    const perfect = `\x01RVOS ${N} END 0 0\n`

    const read = readConsole([
      frame('BEGIN 0'),
      data(perfect),
      frame('END 0 7'),
      frame('FINISHED'),
    ].join(''), N)

    expect(read.steps).toEqual([{ index: 0, exitCode: 7, output: perfect }])
  })

  test('and a job whose machine died reports unfinished, whatever its last step said', () => {
    /*
     * The shape a job takes when it is killed for time. Reading the final exit
     * code would report the step *before* the one that ran out of clock as the
     * job's result.
     */
    const read = readConsole([frame('BEGIN 0'), data('ok\n'), frame('END 0 0')].join(''), N)

    expect(read.steps[0]!.exitCode).toBe(0)
    expect(read.finished).toBe(false)
  })
})

describe('the nonce', () => {
  test('is long, hex, and different every time', () => {
    expect(bootNonce()).toMatch(/^[0-9a-f]{32}$/)
    expect(bootNonce()).not.toBe(bootNonce())
  })
})

describe('the agent', () => {
  test('removes the nonce before it runs anything', () => {
    /*
     * The ordering is the whole defence on the guest side. After that line there
     * is nowhere for a step to read the token from - not the disk, not the
     * script's arguments, not the kernel command line.
     */
    const source = guestAgent()
    const removal = source.indexOf('rm -f /work/nonce')
    const firstStep = source.indexOf('sh "/work/steps/')

    expect(removal).toBeGreaterThan(-1)
    expect(firstStep).toBeGreaterThan(removal)
  })

  test('declares a length rather than a terminator', () => {
    // A terminator is a string the output can contain. A length is not.
    expect(guestAgent()).toContain('wc -c')
    expect(guestAgent()).toContain('DATA $size')
  })

  test('and stops the job at the first failing step, as a host runner does', () => {
    expect(guestAgent()).toContain('[ "$code" -eq 0 ] || break')
  })
})

describe('the host commands', () => {
  test('quote anything a workflow could put in a step', () => {
    /*
     * A step's command comes off a workflow file anybody who can push may edit.
     * It reaches a shell on the *host* while the payload disk is assembled, so
     * this is the quoting that stands between a build script and the runner.
     */
    expect(shellQuote(`it's; rm -rf /`)).toBe(`'it'\\''s; rm -rf /'`)
    expect(shellQuote('$(whoami)')).toBe(`'$(whoami)'`)
  })

  test('and the tap is remade rather than reused', () => {
    // A device left behind by a crashed job is not a device this job should
    // inherit, along with whatever was attached to it.
    expect(tapScript('rvos41', '172.20.0.1')).toContain('ip link del rvos41')
    expect(tapScript('rvos41', '172.20.0.1')).toContain('ip tuntap add dev rvos41 mode tap')
  })
})

describe('what a translating console does to framing', () => {
  test('a header still parses when the line arrived as CRLF', () => {
    /*
     * A serial console turns `\n` into `\r\n` by default, and that is fatal to
     * length framing rather than merely untidy: the host is told how many bytes
     * to expect and the line discipline inserts more, so every count is wrong by
     * the number of newlines and the frames slide out of alignment.
     *
     * The real fix is in the guest, which turns the translation off before it
     * writes anything. This is the belt to that pair of braces - found when a
     * job whose three steps had all run correctly reported nothing at all,
     * because every header carried a trailing `\r` and stopped being a header.
     */
    const read = readConsole(`\x01RVOS ${N} BEGIN 0\r\n\x01RVOS ${N} DATA 3\r\nabc\r\n\x01RVOS ${N} END 0 0\r\n\x01RVOS ${N} FINISHED\r\n`, N)

    expect(read.finished).toBe(true)
    expect(read.steps).toEqual([{ index: 0, exitCode: 0, output: 'abc' }])
  })

  test('and the guest turns the translation off at the source', () => {
    expect(guestAgent()).toContain('stty -onlcr')
  })
})

describe('the read-only root the agent boots on', () => {
  test('is not somewhere the agent tries to create its mount point', () => {
    /*
     * The image is read-only permanently and deliberately, so `mkdir /work`
     * cannot work - the directory has to exist in the image. The agent used to
     * create it, which failed on every boot with a message nobody would connect
     * to "the job reported nothing".
     */
    expect(guestAgent()).not.toContain('mkdir -p /work')
    expect(guestAgent()).toContain('mount /dev/vdb /work')
  })

  test('and writes its scratch to a tmpfs rather than to the image', () => {
    expect(guestAgent()).toContain('mount -t tmpfs tmpfs /tmp')
  })
})

describe('what one step may print', () => {
  test('is bounded, because the way out is a serial console', () => {
    /*
     * A pipe would make this a question of log size; a serial console makes it a
     * question of whether the job finishes at all. A step that printed fifty
     * megabytes did not produce a large log - it produced a machine still
     * transmitting when the wall clock killed it, and a job that failed with a
     * timeout saying nothing about the step being chatty.
     */
    const agent = guestAgent()

    expect(agent).toContain('MAXOUT=')
    expect(agent).toContain('head -c "$MAXOUT"')
  })

  test('and says what it dropped rather than trailing off', () => {
    // A truncated log that does not admit it is a log somebody reads to the end
    // and then hunts for a failure that was never printed.
    expect(guestAgent()).toContain('bytes dropped')
  })

  test('and the ceiling travels on the disk, not the console', () => {
    /*
     * It is not a secret - it is a number an operator set - so it goes with the
     * steps rather than on the channel reserved for credentials, which the agent
     * reads once and closes.
     */
    expect(guestAgent()).toContain('/work/maxout')
  })
})
