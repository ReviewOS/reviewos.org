// Uploaded files.
//
// Two things are being tested, and only the second is about features. The
// first is that a file uploaded by one person and opened by another can never
// be *executed* by the browser: same-origin HTML is stored cross-site
// scripting, an SVG is a document with scripting in it, and a content type sent
// by a client is a claim rather than a fact.

import { describe, expect, test } from 'bun:test'
import { inspect } from '../../app/Actions/Attachment/upload'
import {
  attachmentPath,
  attachmentUrl,
  isAttachmentKey,
  kindFor,
  markdownFor,
  MAX_ATTACHMENT_BYTES,
  newAttachmentKey,
  safeFilename,
  sniff,
} from '../../app/Actions/Attachment/storage'

/** Bytes that begin with a real signature, padded out to something plausible. */
function file(signature: number[], length = 64): Uint8Array {
  const bytes = new Uint8Array(length)
  bytes.set(signature)

  return bytes
}

const PNG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]
const PDF = [0x25, 0x50, 0x44, 0x46]

describe('kindFor', () => {
  test('renders an image in place', () => {
    expect(kindFor('image/png')).toEqual({ contentType: 'image/png', extension: 'png', inline: true })
  })

  /**
   * An SVG is not an image for this purpose. It is a document that can carry
   * script, and an image tag is not a safe place to put one.
   */
  test('serves an SVG as a download rather than in place', () => {
    expect(kindFor('image/svg+xml')?.inline).toBe(false)
  })

  test('refuses a type nobody allowed', () => {
    expect(kindFor('text/html')).toBeNull()
    expect(kindFor('application/javascript')).toBeNull()
    expect(kindFor('application/xhtml+xml')).toBeNull()
    expect(kindFor('')).toBeNull()
  })

  test('ignores the parameters a browser adds', () => {
    expect(kindFor('image/png; charset=binary')?.contentType).toBe('image/png')
    expect(kindFor('IMAGE/PNG')?.contentType).toBe('image/png')
  })
})

describe('sniff', () => {
  test('recognises the formats that have a signature', () => {
    expect(sniff(file(PNG))).toBe('image/png')
    expect(sniff(file([0xFF, 0xD8, 0xFF]))).toBe('image/jpeg')
    expect(sniff(file(GIF))).toBe('image/gif')
    expect(sniff(file(PDF))).toBe('application/pdf')
    expect(sniff(file([0x50, 0x4B, 0x03, 0x04]))).toBe('application/zip')
  })

  test('reads the format out of a RIFF container', () => {
    const webp = file([0x52, 0x49, 0x46, 0x46])
    webp.set([0x57, 0x45, 0x42, 0x50], 8)

    expect(sniff(webp)).toBe('image/webp')
  })

  test('says nothing about a format it cannot recognise', () => {
    expect(sniff(new TextEncoder().encode('<html><script>alert(1)</script>'))).toBeNull()
  })
})

describe('inspect', () => {
  /** The one that matters: the claim is a hint, the bytes are the answer. */
  test('does not believe a content type the bytes contradict', () => {
    const html = new TextEncoder().encode('<html><script>alert(1)</script></html>')
    const result = inspect({ mimetype: 'image/png', buffer: html.buffer as ArrayBuffer })

    expect(result.ok).toBe(false)
  })

  test('stores a real image as what it is, whatever it was called', () => {
    const result = inspect({ mimetype: 'application/octet-stream', buffer: file(PNG).buffer as ArrayBuffer })

    expect(result).toMatchObject({ ok: true, kind: { contentType: 'image/png', inline: true } })
  })

  test('believes the claim only for formats with nothing to read', () => {
    const text = new TextEncoder().encode('a log line\n')
    const result = inspect({ mimetype: 'text/plain', buffer: text.buffer as ArrayBuffer })

    // Safe to believe, because it is served as a download either way.
    expect(result).toMatchObject({ ok: true, kind: { contentType: 'text/plain', inline: false } })
  })

  test('refuses an empty file and one that is too large', () => {
    expect(inspect({ buffer: new ArrayBuffer(0) })).toMatchObject({ ok: false, status: 422 })
    expect(inspect({ mimetype: 'text/plain', buffer: new ArrayBuffer(MAX_ATTACHMENT_BYTES + 1) }))
      .toMatchObject({ ok: false, status: 413 })
  })

  test('refuses a file that is not there', () => {
    expect(inspect({})).toMatchObject({ ok: false, status: 422 })
  })
})

describe('keys and paths', () => {
  test('generates a key that looks like one', () => {
    expect(isAttachmentKey(newAttachmentKey())).toBe(true)
  })

  test('generates a different key each time', () => {
    expect(newAttachmentKey()).not.toBe(newAttachmentKey())
  })

  /**
   * The key is the whole name of the file on disk, so nothing that is not a key
   * may become a path. There is nothing to escape: it is 32 hex characters or
   * it is not a key.
   */
  test('refuses to build a path out of anything else', () => {
    expect(attachmentPath('../../config/app.ts')).toBeNull()
    expect(attachmentPath('')).toBeNull()
    expect(attachmentPath('ZZZZ')).toBeNull()
    expect(attachmentPath('a'.repeat(31))).toBeNull()
  })

  test('fans out so no one directory holds everything', () => {
    expect(attachmentPath('ab12'.repeat(8))).toBe('storage/attachments/ab/12/ab12ab12ab12ab12ab12ab12ab12ab12')
  })

  test('builds the URL in one place', () => {
    expect(attachmentUrl('ab12'.repeat(8))).toBe('/attachments/ab12ab12ab12ab12ab12ab12ab12ab12')
  })
})

describe('safeFilename', () => {
  const key = 'ab12'.repeat(8)

  test('keeps an ordinary name', () => {
    expect(safeFilename('screenshot 2.png', key, 'png')).toBe('screenshot 2.png')
  })

  test('keeps only the last segment, so a path is not a name', () => {
    expect(safeFilename('../../etc/passwd', key, 'txt')).toBe('passwd')
  })

  test('drops the characters that would end a header early', () => {
    expect(safeFilename('a"; filename="b.png', key, 'png')).not.toContain('"')
  })

  test('falls back to the key when nothing is left', () => {
    expect(safeFilename('...', key, 'png')).toBe(`${key}.png`)
    expect(safeFilename('', key, 'png')).toBe(`${key}.png`)
  })
})

describe('markdownFor', () => {
  const key = 'ab12'.repeat(8)

  test('writes an image in as an image', () => {
    expect(markdownFor({ contentType: 'image/png', extension: 'png', inline: true }, key, 'shot.png'))
      .toBe(`![shot.png](/attachments/${key})`)
  })

  test('writes everything else in as a link, so the name is visible', () => {
    expect(markdownFor({ contentType: 'application/zip', extension: 'zip', inline: false }, key, 'logs.zip'))
      .toBe(`[logs.zip](/attachments/${key})`)
  })

  /** A bracket in a filename would otherwise end the link text early. */
  test('escapes a bracket in the name', () => {
    expect(markdownFor({ contentType: 'image/png', extension: 'png', inline: true }, key, 'a[1].png'))
      .toContain('a\\[1\\].png')
  })
})
