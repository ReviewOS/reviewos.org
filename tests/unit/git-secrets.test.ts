// Finding a credential in a diff before the push carrying it lands.
//
// Half of this file is about *not* firing. A miss costs one leaked credential;
// a false positive on a test fixture at six in the evening costs the whole
// feature, because somebody bypasses it once, learns that bypassing is easy,
// and the next real finding is bypassed without being read. So the placeholder
// cases below are not padding - they are the ones that decide whether anybody
// still has this turned on in a month.

import { describe, expect, test } from 'bun:test'
import {
  describeFinding,
  ENTROPY_THRESHOLD,
  entropy,
  PROVIDER_PATTERNS,
  redact,
  scanDiff,
  scanLine,
} from '../../app/Actions/Git/secrets'

/** A shape with the right prefix and the right length, invented for the test. */
const GITHUB_TOKEN = `ghp_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE'
const STRIPE_KEY = `sk_live_${'4eC39HqLyjWDarjtT1zdp7dc'}`

describe('provider tokens', () => {
  test('finds the shapes an issuer assigns', () => {
    expect(scanLine(`const t = "${GITHUB_TOKEN}"`)[0]?.name).toBe('a GitHub personal access token')
    expect(scanLine(`aws_access_key_id = ${AWS_KEY}`)[0]?.name).toBe('an AWS access key id')
    expect(scanLine(`STRIPE="${STRIPE_KEY}"`)[0]?.name).toBe('a Stripe secret key')
  })

  test('finds a private key header', () => {
    expect(scanLine('-----BEGIN RSA PRIVATE KEY-----')[0]?.name).toBe('a private key')
    expect(scanLine('-----BEGIN OPENSSH PRIVATE KEY-----')[0]?.name).toBe('a private key')
  })

  test('finds a password in a database URL', () => {
    expect(scanLine('DATABASE_URL=postgres://app:hunter2@db.internal:5432/prod')[0]?.name)
      .toBe('a database URL with a password in it')
  })

  /** A public key is not a private one, and people commit them constantly. */
  test('leaves a public key alone', () => {
    expect(scanLine('-----BEGIN PUBLIC KEY-----')).toEqual([])
    expect(scanLine('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexample chris@laptop')).toEqual([])
  })

  test('reports every distinct shape on one line, not just the first', () => {
    const found = scanLine(`${GITHUB_TOKEN} and ${AWS_KEY}`)

    expect(found).toHaveLength(2)
  })

  test('every provider pattern is marked certain', () => {
    expect(PROVIDER_PATTERNS.every(pattern => pattern.confidence === 'certain')).toBe(true)
  })
})

describe('the entropy heuristic', () => {
  const strong = 'Xk9pQ2mZ7vB4nR8tL1wY6cF3jH5sD0gA'

  test('fires on a high-entropy value assigned to a credential name', () => {
    const found = scanLine(`const apiKey = "${strong}"`)

    expect(found[0]?.name).toBe('a high-entropy value assigned to a credential')
    expect(found[0]?.confidence).toBe('likely')
  })

  test('reads the shell and yaml shapes too', () => {
    expect(scanLine(`API_TOKEN=${strong}`)).toHaveLength(1)
    expect(scanLine(`  client_secret: '${strong}'`)).toHaveLength(1)
  })

  /**
   * The name is half the signal. The same value under a name that says nothing
   * about credentials is a nonce, a hash, or a fixture.
   */
  test('does not fire without a name that says what the value is', () => {
    expect(scanLine(`const checksum = "${strong}"`)).toEqual([])
    expect(scanLine(`const id = "${strong}"`)).toEqual([])
  })

  /** The credential-shaped word has to be the name, not something else on the line. */
  test('does not fire on prose that happens to mention a key', () => {
    expect(scanLine(`// the api_key docs are here; width = "${strong}"`)).toEqual([])
  })

  test('does not fire on a short value', () => {
    expect(scanLine('const password = "hunter2"')).toEqual([])
  })

  test('does not fire on a low-entropy value', () => {
    expect(scanLine('const token = "aaaaaaaaaaaaaaaaaaaaaaaaaaaa"')).toEqual([])
  })
})

/**
 * Everything in this block is in somebody's README, `.env.example`, or test
 * fixture. Reporting any of them is how a team learns to bypass.
 */
describe('placeholders are not credentials', () => {
  const cases = [
    'const apiKey = "your-api-key-here-goes-something"',
    'API_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    'password: <your-password-goes-right-here>',
    'const secret = "${SECRET_FROM_ENVIRONMENT}"',
    'client_secret: {{ vault_client_secret_value }}',
    'API_KEY=changeme-changeme-changeme-changeme',
    'token = "EXAMPLE_TOKEN_VALUE_FOR_DOCUMENTATION"',
    'password = "0000000000000000000000000000"',
    'const apiKey = "REDACTED_FOR_THE_SCREENSHOT_HERE"',
    'secret: not-a-real-secret-just-a-placeholder',
  ]

  for (const line of cases) {
    test(`leaves alone: ${line.slice(0, 44)}`, () => {
      expect(scanLine(line)).toEqual([])
    })
  }

  /** The canonical AWS documentation key is still a real shape, and still refused. */
  test('but a documented example that is a real shape is still reported', () => {
    expect(scanLine(`aws_key = ${AWS_KEY}`)).toHaveLength(1)
  })
})

describe('redact', () => {
  test('keeps enough to find it and not enough to use it', () => {
    const redacted = redact(GITHUB_TOKEN)

    expect(redacted).toStartWith('ghp_')
    expect(redacted).not.toContain(GITHUB_TOKEN.slice(8, 24))
    expect(redacted.length).toBeLessThan(GITHUB_TOKEN.length)
  })

  test('a short value keeps almost nothing', () => {
    expect(redact('abcdef')).toBe('ab****')
  })

  /** The finding reaches a terminal, a log, and possibly a support thread. */
  test('nothing reported ever carries the whole value', () => {
    for (const finding of scanLine(`const apiKey = "${GITHUB_TOKEN}"`))
      expect(finding.excerpt).not.toBe(GITHUB_TOKEN)
  })
})

describe('entropy', () => {
  test('clears the threshold for a real key', () => {
    expect(entropy('Xk9pQ2mZ7vB4nR8tL1wY6cF3jH5sD0gA')).toBeGreaterThan(ENTROPY_THRESHOLD)
  })

  test('drops the shapes it is there to drop', () => {
    // A uuid and a version string, both of which get assigned to things with
    // credential-shaped names and neither of which is a secret.
    expect(entropy('550e8400e29b41d4a716446655440000')).toBeLessThan(ENTROPY_THRESHOLD)
    expect(entropy('1.2.3-4.5.6-7.8.9-10.11.12')).toBeLessThan(ENTROPY_THRESHOLD)
    expect(entropy('abababababababababababab')).toBeLessThan(ENTROPY_THRESHOLD)
  })

  /**
   * Worth pinning, because it is the reason entropy is never the only signal:
   * English words run together score *above* a real base64 key.
   */
  test('does not separate a key from prose, which is why the name matters', () => {
    expect(entropy('thequickbrownfoxjumpsoverthelazydog'))
      .toBeGreaterThan(entropy('aGVsbG93b3JsZHRoaXNpc2Fsb25nc3RyaW5n1234'))
  })

  test('is zero for one repeated character', () => {
    expect(entropy('aaaaaaaaaaaaaaaa')).toBe(0)
  })

  test('is zero for nothing', () => {
    expect(entropy('')).toBe(0)
  })
})

describe('scanDiff', () => {
  const diff = [
    'diff --git a/config/app.ts b/config/app.ts',
    'index 1234567..89abcde 100644',
    '--- a/config/app.ts',
    '+++ b/config/app.ts',
    '@@ -10,3 +10,4 @@',
    ' const config = {',
    `+  token: "${GITHUB_TOKEN}",`,
    ' }',
  ].join('\n')

  test('names the file and the line a reader can open', () => {
    const [finding] = scanDiff(diff)

    expect(finding).toMatchObject({ path: 'config/app.ts', line: 11 })
    expect(finding!.name).toBe('a GitHub personal access token')
  })

  /**
   * The one push that has to be allowed is the one that takes the secret out.
   * Refusing a removal would make the cleanup impossible.
   */
  test('ignores a removed line, so a secret can be deleted', () => {
    const removal = [
      '--- a/config/app.ts',
      '+++ b/config/app.ts',
      '@@ -10,4 +10,3 @@',
      ' const config = {',
      `-  token: "${GITHUB_TOKEN}",`,
      ' }',
    ].join('\n')

    expect(scanDiff(removal)).toEqual([])
  })

  test('keeps the line number right across context and removals', () => {
    const mixed = [
      '+++ b/a.ts',
      '@@ -1,5 +1,6 @@',
      ' one',
      '-two',
      ' three',
      `+  password = "Xk9pQ2mZ7vB4nR8tL1wY6cF3jH5sD0gA"`,
    ].join('\n')

    // `one` is 1, `three` is 2, the added line is 3.
    expect(scanDiff(mixed)[0]?.line).toBe(3)
  })

  test('follows the path across several files in one diff', () => {
    const twoFiles = [
      '+++ b/first.ts',
      '@@ -1 +1,2 @@',
      `+const a = "${AWS_KEY}"`,
      'diff --git a/second.ts b/second.ts',
      '+++ b/second.ts',
      '@@ -1 +1,2 @@',
      `+const b = "${STRIPE_KEY}"`,
    ].join('\n')

    expect(scanDiff(twoFiles).map(one => one.path)).toEqual(['first.ts', 'second.ts'])
  })

  test('finds nothing in a diff that carries nothing', () => {
    expect(scanDiff('+++ b/readme.md\n@@ -1 +1,2 @@\n+# hello\n')).toEqual([])
  })
})

describe('describeFinding', () => {
  test('says where and what, because a rejection nobody can act on gets bypassed', () => {
    const [finding] = scanDiff([
      '+++ b/config/app.ts',
      '@@ -1 +1,2 @@',
      `+token = "${GITHUB_TOKEN}"`,
    ].join('\n'))

    const message = describeFinding(finding!)

    expect(message).toContain('config/app.ts:1')
    expect(message).toContain('a GitHub personal access token')
    expect(message).not.toContain(GITHUB_TOKEN)
  })
})
