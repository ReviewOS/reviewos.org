// Files attached to a release.
//
// The rules here are simpler than the ones for an issue attachment and
// deliberately stricter: an attachment is often a screenshot somebody wants to
// see inline, so that module has to decide which types are safe to render. A
// release asset is a compiled artefact that somebody downloads and runs, so
// there is no allowlist to get wrong - it goes out as an opaque download
// whatever it is called.

import { describe, expect, test } from 'bun:test'
import {
  ASSET_ROOT,
  assetHeaders,
  assetName,
  assetPath,
  checksumOf,
  decideAsset,
  isAssetKey,
  MAX_ASSET_BYTES,
  newAssetKey,
} from '../../app/Actions/Release/assets'

describe('assetHeaders', () => {
  /** The rule the whole module exists to hold. */
  test('serves everything as an opaque download, whatever it is called', () => {
    for (const name of ['app.html', 'installer.js', 'thing.svg', 'binary']) {
      const headers = assetHeaders(name, 10)

      expect(headers['Content-Type'], name).toBe('application/octet-stream')
      expect(headers['Content-Disposition'], name).toStartWith('attachment;')
    }
  })

  test('sets nosniff, so a browser cannot overrule the type', () => {
    expect(assetHeaders('app.html', 10)['X-Content-Type-Options']).toBe('nosniff')
  })

  test('keeps the name, because that is what tells two binaries apart', () => {
    expect(assetHeaders('checkout-linux-amd64.tar.gz', 10)['Content-Disposition'])
      .toContain('filename="checkout-linux-amd64.tar.gz"')
  })

  /** The name comes from whoever uploaded it, into a quoted header value. */
  test('a name cannot close the quote and write headers', () => {
    const disposition = assetHeaders('a";\r\nX-Evil: yes\r\n\r\n.bin', 10)['Content-Disposition']!

    expect(disposition).not.toContain('\r')
    expect(disposition).not.toContain('\n')
    expect(disposition.match(/"/g)).toHaveLength(2)
  })

  test('an asset never changes, so it caches hard', () => {
    expect(assetHeaders('a.bin', 10)['Cache-Control']).toContain('immutable')
  })
})

describe('assetName', () => {
  test('keeps the shape of a real release binary name', () => {
    for (const name of ['checkout-linux-amd64.tar.gz', 'app_v1.2.3.zip', 'SHA256SUMS', 'sig.asc'])
      expect(assetName(name), name).toBe(name)
  })

  test('takes the file, never the path', () => {
    expect(assetName('../../etc/passwd')).toBe('passwd')
    expect(assetName('C:\\Windows\\system32\\thing.dll')).toBe('thing.dll')
    expect(assetName('a/b/c/app.tar.gz')).toBe('app.tar.gz')
  })

  /** Whatever the name was, the stored path is built from a key, not from it. */
  test('a name never reaches a path', () => {
    expect(assetName('../../etc/passwd')).not.toContain('/')
    expect(assetName('..')).toBeNull()
  })

  test('a hidden file does not stay hidden', () => {
    expect(assetName('.bashrc')).toBe('bashrc')
  })

  test('a name that survives to nothing is refused rather than invented', () => {
    for (const name of ['', '...', '???', '/', null, undefined])
      expect(assetName(name as any), JSON.stringify(name)).toBeNull()
  })

  test('bounds the length', () => {
    expect(assetName(`${'x'.repeat(400)}.bin`)!.length).toBeLessThanOrEqual(200)
  })
})

describe('decideAsset', () => {
  test('takes an ordinary upload', () => {
    expect(decideAsset('app.tar.gz', 1024)).toEqual({ ok: true, name: 'app.tar.gz', bytes: 1024 })
  })

  test('refuses an empty file, which is never what somebody meant', () => {
    expect(decideAsset('app.tar.gz', 0)).toMatchObject({ ok: false, status: 422 })
  })

  test('refuses a name it cannot use', () => {
    expect(decideAsset('...', 10)).toMatchObject({ ok: false, status: 422 })
  })

  /** An unbounded upload endpoint is a disk-filling endpoint. */
  test('refuses what is too large, with the status that says so', () => {
    expect(decideAsset('big.bin', MAX_ASSET_BYTES + 1)).toMatchObject({ ok: false, status: 413 })
    expect(decideAsset('big.bin', MAX_ASSET_BYTES)).toMatchObject({ ok: true })
  })

  test('the limit is large enough for the thing people actually attach', () => {
    // A modest compiled binary. If this ever fails, the limit has been lowered
    // to something that refuses the normal case.
    expect(decideAsset('binary', 200 * 1024 * 1024)).toMatchObject({ ok: true })
  })
})

describe('keys and paths', () => {
  test('a key is 32 hex characters, and a fresh one is a key', () => {
    const key = newAssetKey()

    expect(key).toMatch(/^[0-9a-f]{32}$/)
    expect(isAssetKey(key)).toBe(true)
  })

  test('two keys are not the same key', () => {
    expect(new Set(Array.from({ length: 200 }, () => newAssetKey())).size).toBe(200)
  })

  test('fans out, so no directory ends up with a hundred thousand entries', () => {
    const path = assetPath('ab12'.padEnd(32, '0'))!

    expect(path).toBe(`${ASSET_ROOT}/ab/12/${'ab12'.padEnd(32, '0')}`)
  })

  /**
   * Nothing derived from a URL may name a path. There is nothing to sanitize:
   * a key is 32 hex characters or it is not a key.
   */
  test('refuses anything that is not a key rather than sanitizing it', () => {
    for (const value of ['../../etc/passwd', 'ABCDEF', '', 'g'.repeat(32), null, 42])
      expect(assetPath(value as any), JSON.stringify(value)).toBeNull()
  })
})

describe('checksumOf', () => {
  test('is the SHA-256 of the bytes', () => {
    // The empty input's SHA-256, which is a fixed and checkable constant.
    expect(checksumOf(new Uint8Array(0)))
      .toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })

  test('the same bytes always give the same answer', () => {
    const bytes = new TextEncoder().encode('release binary')

    expect(checksumOf(bytes)).toBe(checksumOf(bytes))
  })

  test('one different byte gives a different answer', () => {
    expect(checksumOf(new TextEncoder().encode('a'))).not.toBe(checksumOf(new TextEncoder().encode('b')))
  })
})
