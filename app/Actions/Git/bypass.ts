/**
 * Overriding a push-protection finding, and paying for it in the record.
 *
 * The argument for having a bypass at all is the same one that argues for the
 * feature: a scanner people cannot get past is a scanner people turn off. A
 * false positive on a test fixture at six in the evening, with a release
 * waiting, ends one of two ways - the pusher writes a sentence and continues,
 * or somebody sets `enabled: false` and nobody ever turns it back on. The first
 * costs one line in an audit log. The second costs the whole feature, silently,
 * and the person who did it was right that once.
 *
 * So the bypass is deliberately easy to *use* and impossible to use *quietly*:
 *
 *     git push -o secret-scan=bypass -o reason="fixture, not a real key"
 *
 * A reason is required and has to be long enough to be a sentence. What it
 * buys is not the words - it is that somebody had to stop, decide, and put
 * their name next to the decision, and that the next person to look at the
 * repository can see what was pushed and why.
 *
 * Pure. What a set of push options *means* is decided here and tested without
 * git; recording it is the caller's job.
 */

export interface BypassRequest {
  requested: boolean
  reason: string
}

/**
 * Read the push options.
 *
 * `secret-scan=bypass` is the switch. `reason=…` carries the sentence, and is
 * read from any option so that `-o reason=…` works whichever order somebody
 * writes the two in - people do not read the documentation twice.
 */
export function readBypass(options: readonly string[]): BypassRequest {
  let requested = false
  let reason = ''

  for (const raw of options) {
    const option = String(raw ?? '').trim()

    if (/^secret[-_]?scan=(?:bypass|skip|off)$/i.test(option) || /^skip[-_]?secret[-_]?scan$/i.test(option)) {
      requested = true
      continue
    }

    const named = /^(?:reason|bypass[-_]?reason|justification)=([\s\S]+)$/i.exec(option)
    if (named)
      reason = named[1]!.trim()
  }

  return { requested, reason }
}

export type BypassOutcome =
  | { allowed: true, reason: string }
  | { allowed: false, message: string }

/**
 * Whether an override may proceed.
 *
 * Every refusal here says what to do next, because a refusal that does not is
 * the one that turns into "just disable the scanner". Somebody who has asked
 * to bypass has already decided the finding is wrong; the only useful thing to
 * tell them is what the override needs.
 */
export function decideBypass(
  request: BypassRequest,
  settings: { allowBypass: boolean, minimumReasonLength: number },
): BypassOutcome {
  if (!request.requested)
    return { allowed: false, message: '' }

  if (!settings.allowBypass) {
    return {
      allowed: false,
      message: 'Push protection cannot be bypassed on this instance. Remove the credential from the commit, or ask an administrator.',
    }
  }

  const reason = request.reason.trim()

  if (reason.length === 0) {
    return {
      allowed: false,
      message: 'A bypass needs a reason: git push -o secret-scan=bypass -o reason="why this is not a credential"',
    }
  }

  if (reason.length < settings.minimumReasonLength) {
    return {
      allowed: false,
      message: `That reason is too short - say what this is in at least ${settings.minimumReasonLength} characters. It goes in the audit log next to your name.`,
    }
  }

  // Bounded before it reaches a column and a terminal. Somebody pasting a stack
  // trace as their reason should not be refused, but nor should the whole thing
  // be stored.
  return { allowed: true, reason: reason.slice(0, 500) }
}
