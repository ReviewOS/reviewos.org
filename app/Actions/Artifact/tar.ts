/**
 * A tar archive, built in memory.
 *
 * For "download every artifact this run produced" - one file rather than
 * fourteen right-clicks, which is what somebody wants when they are collecting
 * evidence from a failed run or handing a build to a colleague.
 *
 * **tar rather than zip**, and written here rather than pulled in: tar's format
 * is a 512-byte header and padded content, which is sixty lines and no
 * dependency, where zip needs a compressor and a central directory. Every
 * machine that runs CI has `tar`. This is not compressed, deliberately - the
 * artifacts are usually already compressed, and spending the instance's CPU to
 * make a build's tarball three percent smaller is the wrong trade.
 */

const BLOCK = 512

/** One file in the archive. */
export interface TarEntry {
  name: string
  bytes: Uint8Array
  /** Seconds since the epoch. Zero is fine and reproducible. */
  modified?: number
}

/**
 * The archive, as bytes.
 *
 * Names longer than 99 characters are truncated rather than written in the GNU
 * long-name extension: an artifact name here is one this instance already
 * flattened and capped, and implementing a second format for a case that cannot
 * arise is code nobody would ever exercise.
 */
export function buildTar(entries: readonly TarEntry[]): Uint8Array {
  const blocks: Uint8Array[] = []

  for (const entry of entries) {
    blocks.push(header(entry))
    blocks.push(entry.bytes)

    const remainder = entry.bytes.length % BLOCK

    if (remainder !== 0)
      blocks.push(new Uint8Array(BLOCK - remainder))
  }

  // Two empty blocks end an archive. Without them `tar` reads to the end of the
  // stream and warns, which reads to a person as a corrupt download.
  blocks.push(new Uint8Array(BLOCK * 2))

  const total = blocks.reduce((sum, block) => sum + block.length, 0)
  const out = new Uint8Array(total)

  let at = 0

  for (const block of blocks) {
    out.set(block, at)
    at += block.length
  }

  return out
}

/** One 512-byte ustar header, checksum and all. */
function header(entry: TarEntry): Uint8Array {
  const block = new Uint8Array(BLOCK)
  const encoder = new TextEncoder()

  const write = (value: string, at: number, length: number): void => {
    block.set(encoder.encode(value.slice(0, length)), at)
  }

  /** An octal field, right-aligned and NUL-terminated, as tar wants. */
  const octal = (value: number, length: number): string =>
    `${value.toString(8).padStart(length - 1, '0')}\0`

  write(String(entry.name ?? '').slice(0, 99), 0, 100)
  write(octal(0o644, 8), 100, 8)
  write(octal(0, 8), 108, 8)
  write(octal(0, 8), 116, 8)
  write(octal(entry.bytes.length, 12), 124, 12)
  write(octal(Math.floor(entry.modified ?? 0), 12), 136, 12)

  // The checksum is computed with its own field full of spaces, then written
  // into it. That is the format's rule, not a quirk of this implementation.
  block.set(encoder.encode('        '), 148)
  write('0', 156, 1)
  write('ustar\0', 257, 6)
  write('00', 263, 2)

  let sum = 0

  for (const byte of block)
    sum += byte

  write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8)

  return block
}
