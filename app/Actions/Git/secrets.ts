/**
 * Finding a credential in a diff, before the push that carries it lands.
 *
 * Scanning after the fact is a cleanup procedure rather than a defense: by then
 * the secret is in the reflog, in every clone somebody has already fetched, and
 * possibly in a mirror on another host. Receive time is the one moment where
 * refusing still prevents something, which is why this is called from the
 * pre-receive gate and not from a job.
 *
 * ## The failure mode that matters is the false positive
 *
 * A miss costs one leaked credential. A false positive on a test fixture at
 * six in the evening costs the whole feature: somebody bypasses it once,
 * discovers that bypassing is easy, and the next real finding is bypassed
 * without being read. So the detectors are ordered by how sure they are, and
 * the least sure one is deliberately the narrowest:
 *
 * 1. **Provider tokens with a known prefix.** `ghp_`, `sk-`, `AKIA`. These are
 *    unambiguous - the prefix is assigned by the provider and appears nowhere
 *    else - so they are reported with high confidence and no heuristics.
 * 2. **Private keys.** A PEM header is not something anybody types by accident.
 * 3. **High-entropy strings in assignment position.** The only heuristic here,
 *    and the only one that can be wrong. It requires a variable name that says
 *    what it holds, a long value, real entropy, *and* that the value is not one
 *    of the placeholders every README in the world contains.
 *
 * Everything here is pure and works on one line at a time, so a fixture can be
 * a string in a test rather than a repository.
 */

export type Confidence = 'certain' | 'likely'

export interface SecretPattern {
  /** Shown to the pusher: "an AWS access key id". Reads after "looks like". */
  name: string
  test: RegExp
  confidence: Confidence
}

export interface Finding {
  /** The file the line came from. */
  path: string
  /** 1-indexed, and the line number in the *new* file. */
  line: number
  name: string
  confidence: Confidence
  /** The matched text, redacted. Enough to find it, not enough to use it. */
  excerpt: string
}

/**
 * Tokens whose prefix is assigned by a provider.
 *
 * Every one of these is a shape the issuer chose precisely so it can be
 * recognised, which is what makes them safe to report without a second signal.
 * A self-hosted instance adds its own through `config/security.ts` rather than
 * by editing this list.
 */
export const PROVIDER_PATTERNS: readonly SecretPattern[] = [
  { name: 'a GitHub personal access token', test: /\bghp_[A-Za-z0-9]{36}\b/, confidence: 'certain' },
  { name: 'a GitHub OAuth token', test: /\bgho_[A-Za-z0-9]{36}\b/, confidence: 'certain' },
  { name: 'a GitHub app token', test: /\b(?:ghu|ghs)_[A-Za-z0-9]{36}\b/, confidence: 'certain' },
  { name: 'a GitHub refresh token', test: /\bghr_[A-Za-z0-9]{36}\b/, confidence: 'certain' },
  { name: 'a GitHub fine-grained token', test: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/, confidence: 'certain' },
  { name: 'a GitLab personal access token', test: /\bglpat-[A-Za-z0-9\-_]{20}\b/, confidence: 'certain' },
  { name: 'an AWS access key id', test: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/, confidence: 'certain' },
  { name: 'an OpenAI API key', test: /\bsk-(?:proj-)?[A-Za-z0-9\-_]{20,}\b/, confidence: 'certain' },
  { name: 'an Anthropic API key', test: /\bsk-ant-[A-Za-z0-9\-_]{20,}\b/, confidence: 'certain' },
  { name: 'a Slack token', test: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/, confidence: 'certain' },
  { name: 'a Stripe secret key', test: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{24,}\b/, confidence: 'certain' },
  { name: 'a Google API key', test: /\bAIza[A-Za-z0-9\-_]{35}\b/, confidence: 'certain' },
  { name: 'a SendGrid API key', test: /\bSG\.[A-Za-z0-9\-_]{22}\.[A-Za-z0-9\-_]{43}\b/, confidence: 'certain' },
  { name: 'a npm access token', test: /\bnpm_[A-Za-z0-9]{36}\b/, confidence: 'certain' },
  { name: 'a Twilio account sid', test: /\bAC[0-9a-f]{32}\b/, confidence: 'certain' },
  { name: 'a private key', test: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/, confidence: 'certain' },
  { name: 'a JSON Web Token', test: /\beyJ[A-Za-z0-9\-_]{10,}\.eyJ[A-Za-z0-9\-_]{10,}\.[A-Za-z0-9\-_]{10,}\b/, confidence: 'certain' },
  { name: 'a database URL with a password in it', test: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:/@]+:[^\s:/@]+@/, confidence: 'certain' },
]

/**
 * A variable name that says the value is a credential.
 *
 * The name is most of the signal for the entropy detector. `const timeout =
 * ...` with a long random-looking value is a nonce or a fixture; `const apiKey
 * = ...` with the same value is a leak, and the difference is only visible in
 * what somebody called it.
 *
 * The boundaries are written out rather than using `\b`, because `_` is a word
 * character: `\btoken\b` does not match inside `API_TOKEN`, which is the single
 * most common way this is spelled in the files worth scanning.
 */
const CREDENTIAL_NAME = /(?:^|[^A-Za-z0-9])(?:api[_-]?key|secret|passwd|password|token|auth|credential|private[_-]?key|access[_-]?key|client[_-]?secret|bearer)(?:[^A-Za-z0-9]|$)/i

/** `name = "value"`, `name: 'value'`, `NAME=value`. */
const ASSIGNMENT = /([\w.\-[\]"']{1,64})\s*[:=]\s*["'`]?([A-Za-z0-9+/=\-_]{20,120})["'`]?/g

/**
 * Values that mean "put your key here".
 *
 * Every one of these is in somebody's README, `.env.example`, or test fixture,
 * and reporting them is how a team learns to bypass without reading. Matched
 * against the whole value case-insensitively, plus a few shapes: a value that
 * is all one repeated character, and the `xxxx`/`0000` families.
 */
const PLACEHOLDERS: readonly RegExp[] = [
  /^(?:your|my|the)[-_]?/i,
  /(?:example|sample|placeholder|changeme|change[-_]?me|dummy|fake|test|todo|redacted|insert|replace|value|xxx+|yyy+|zzz+|abc123|foobar|not[-_]?a[-_]?real)/i,
  /^[*x.\-_0]+$/i,
  /^\$\{?[\w.]+\}?$/,
  /^<.*>$/,
  /^\{\{.*\}\}$/,
]

function isPlaceholder(value: string): boolean {
  if (PLACEHOLDERS.some(pattern => pattern.test(value)))
    return true

  // One character repeated is never a key, however long it is.
  return new Set(value.replaceAll('=', '')).size <= 2
}

/**
 * Shannon entropy per character, in bits.
 *
 * **It does not separate a key from prose**, and it is worth saying so where
 * somebody would otherwise trust it. Measured over realistic candidates:
 *
 *     random base64, 32 chars   5.00
 *     english words run together 4.54
 *     random base64, 40 chars   4.40
 *     a hex sha1                3.74
 *     a uuid                    3.25
 *
 * English scores *above* a real key. Entropy is the weakest of the three
 * signals here and is only ever consulted after the variable name already says
 * the value is a credential and the placeholder filter has passed - it is there
 * to drop uuids, version strings and repeated filler, not to make the decision.
 */
export function entropy(value: string): number {
  if (value.length === 0)
    return 0

  const counts = new Map<string, number>()
  for (const character of value)
    counts.set(character, (counts.get(character) ?? 0) + 1)

  let bits = 0
  for (const count of counts.values()) {
    const p = count / value.length
    bits -= p * Math.log2(p)
  }

  return bits
}

/**
 * Low enough to keep hex keys, high enough to drop uuids and version strings.
 *
 * Set against the measurements above rather than by feel. It is deliberately
 * permissive, because it is the last check rather than the first: a value only
 * reaches it having already been assigned to something called `api_key`.
 */
export const ENTROPY_THRESHOLD = 3.5

/**
 * Redact a matched value, keeping enough to find it in the file.
 *
 * The finding travels to the pusher's terminal, into the audit log, and
 * possibly into a support conversation. A message that quotes the whole
 * credential leaks it a second time to help with the first.
 */
export function redact(value: string): string {
  if (value.length <= 12)
    return `${value.slice(0, 2)}${'*'.repeat(Math.max(0, value.length - 2))}`

  return `${value.slice(0, 4)}${'*'.repeat(8)}${value.slice(-4)}`
}

/**
 * Everything one line looks like it contains.
 *
 * Returns every distinct detector that fired, rather than the first: a line
 * with two different credentials on it should say so, because a pusher who
 * fixes only the one they were told about pushes again and is refused again.
 */
export function scanLine(line: string, extra: readonly SecretPattern[] = []): Array<{ name: string, confidence: Confidence, excerpt: string }> {
  const found: Array<{ name: string, confidence: Confidence, excerpt: string }> = []
  const seen = new Set<string>()

  // A very long line is minified output or a data blob, and running a dozen
  // patterns over a megabyte of it per commit is how a push times out.
  const subject = line.length > 4000 ? line.slice(0, 4000) : line

  for (const pattern of [...PROVIDER_PATTERNS, ...extra]) {
    const match = pattern.test.exec(subject)
    if (!match || seen.has(pattern.name))
      continue

    seen.add(pattern.name)
    found.push({ name: pattern.name, confidence: pattern.confidence, excerpt: redact(match[0]) })
  }

  // The heuristic, last and narrowest. Skipped entirely when something certain
  // already fired on this line: the pusher does not need to be told twice.
  if (found.length > 0)
    return found

  if (!CREDENTIAL_NAME.test(subject))
    return found

  ASSIGNMENT.lastIndex = 0
  for (let match = ASSIGNMENT.exec(subject); match !== null; match = ASSIGNMENT.exec(subject)) {
    const [, name, value] = match as unknown as [string, string, string]

    // The *name* has to be the credential-shaped one, not something else on
    // the line: `// see api_key docs` next to `const width = "..."` is prose.
    if (!CREDENTIAL_NAME.test(name))
      continue

    if (isPlaceholder(value) || entropy(value) < ENTROPY_THRESHOLD)
      continue

    if (seen.has('a high-entropy value assigned to a credential'))
      break

    seen.add('a high-entropy value assigned to a credential')
    found.push({
      name: 'a high-entropy value assigned to a credential',
      confidence: 'likely',
      excerpt: redact(value),
    })
  }

  return found
}

/**
 * The added lines of a unified diff, scanned.
 *
 * Added lines only. A push that *removes* a credential is somebody cleaning up,
 * and refusing it would make the cleanup impossible - the one push that has to
 * be allowed is the one that takes the secret out.
 *
 * The `+++ b/path` headers and `@@` hunk headers are read as the diff goes by,
 * so a finding can name the file and the line in it rather than an offset into
 * a patch nobody has open.
 */
export function scanDiff(diff: string, extra: readonly SecretPattern[] = []): Finding[] {
  const findings: Finding[] = []
  let path = ''
  let lineNumber = 0

  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const named = raw.slice(4).trim()
      path = named === '/dev/null' ? '' : named.replace(/^b\//, '')
      continue
    }

    if (raw.startsWith('@@')) {
      // `@@ -old,count +new,count @@`. The new-side start is what a reader
      // needs, because it is the line number the file will have.
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw)
      lineNumber = hunk ? Number(hunk[1]) : 0
      continue
    }

    if (raw.startsWith('---') || raw.startsWith('diff ') || raw.startsWith('index '))
      continue

    if (raw.startsWith('+')) {
      const content = raw.slice(1)

      for (const hit of scanLine(content, extra))
        findings.push({ path, line: lineNumber, ...hit })

      lineNumber += 1
      continue
    }

    // A context line advances the new-side counter; a removed line does not.
    if (!raw.startsWith('-'))
      lineNumber += 1
  }

  return findings
}

/**
 * How a finding reads in a terminal.
 *
 * Named file, named line, named shape. A rejection somebody cannot act on is a
 * rejection that gets bypassed, and "push contains a secret" is not actionable.
 */
export function describeFinding(finding: Finding): string {
  const where = finding.path ? `${finding.path}:${finding.line}` : `line ${finding.line}`

  return `${where} looks like ${finding.name} (${finding.excerpt})`
}
