// The archive a run's artifacts come down as.
//
// Written by hand rather than pulled in, so the parts a reader would otherwise
// have to trust - the checksum, the padding, the end-of-archive blocks - have
// tests. A tarball that `tar` warns about reads to a person as a corrupt
// download, whatever the bytes actually are.

import { describe, expect, test } from 'bun:test'
import { buildTar } from '../../app/Actions/Artifact/tar'

function textEntry(name: string, text: string) {
  return { name, bytes: new TextEncoder().encode(text) }
}

describe('the archive', () => {
  test('is a multiple of the block size, with two empty blocks at the end', () => {
    // Without the trailing blocks `tar` reads to the end of the stream and
    // warns, which a person reads as a broken file.
    const out = buildTar([textEntry('a.txt', 'hello')])

    expect(out.length % 512).toBe(0)
    expect([...out.slice(-1024)].every(byte => byte === 0)).toBe(true)
  })

  test('names each file and records its length', () => {
    const out = buildTar([textEntry('report.txt', 'the evidence')])
    const header = new TextDecoder().decode(out.slice(0, 512))

    expect(header.startsWith('report.txt')).toBe(true)

    // The size field is octal - parsed rather than matched as text, because
    // what matters is that `tar` reads twelve bytes, not how the padding looks.
    expect(Number.parseInt(header.slice(124, 135), 8)).toBe(12)
  })

  test('and the checksum is the one tar will compute', () => {
    /*
     * The format's own rule: the checksum is summed with its field full of
     * spaces, then written into that field. Getting it wrong produces an
     * archive every tool refuses, which is the kind of bug that only shows up
     * on somebody else's machine.
     */
    const out = buildTar([textEntry('a.txt', 'x')])
    const block = out.slice(0, 512)
    const stated = Number.parseInt(new TextDecoder().decode(block.slice(148, 154)), 8)

    const recomputed = [...block].reduce((sum, byte, index) => {
      // The checksum field itself counts as spaces.
      return sum + (index >= 148 && index < 156 ? 32 : byte)
    }, 0)

    expect(stated).toBe(recomputed)
  })

  test('pads a file to a block boundary', () => {
    // Five bytes of content occupy one block; the next header starts after it.
    const out = buildTar([textEntry('a.txt', 'hello'), textEntry('b.txt', 'world')])
    const second = new TextDecoder().decode(out.slice(1024, 1034))

    expect(second.startsWith('b.txt')).toBe(true)
  })
})
