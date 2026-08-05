/**
 * Push protection: refusing a credential before the push carrying it lands.
 *
 * Scanning after the fact is a cleanup procedure rather than a defense. By the
 * time an alert is read the secret is in the reflog, in every clone somebody
 * has fetched, and possibly in a mirror on another host - so the only version
 * of this feature that prevents anything is the one that refuses at receive
 * time, which is what this configures.
 *
 * The built-in detectors live in `app/Actions/Git/secrets.ts` and cover the
 * providers whose tokens carry an assigned prefix. What belongs *here* is the
 * credentials only this instance issues: an internal service token, a licence
 * key, a signing secret from a vendor with three customers. Nothing else knows
 * about those, and an instance that has to fork the detector file to add one is
 * an instance that never adds one.
 */

export interface PushProtectionPattern {
  /** Reads after "looks like": `an Acme service token`. */
  name: string
  /** A regular expression, as a string, so it can be copied from a vendor's docs. */
  pattern: string
  /**
   * `certain` for a shape that cannot be anything else - an assigned prefix
   * with a fixed length. `likely` for everything else, which is the default:
   * a configured pattern has not been through the review the built-in ones
   * have, and confidence is what a reader weighs a finding by.
   */
  confidence?: 'certain' | 'likely'
}

export interface PushProtectionConfig {
  /**
   * Whether a push carrying a credential is refused.
   *
   * Off means the scan does not run at all, rather than running and reporting:
   * a warning nobody has to act on is a warning nobody reads, and the scan is
   * not free.
   */
  enabled: boolean

  /**
   * Whether a pusher may override a finding.
   *
   * On, and deliberately. A false positive on a test fixture at six in the
   * evening with no way past it is how the whole feature gets turned off -
   * permanently, by somebody who was right that once. A bypass that costs a
   * sentence and leaves a record is the version people keep.
   *
   *     git push -o secret-scan=bypass -o reason="fixture, not a real key"
   */
  allowBypass: boolean

  /**
   * How much of a reason a bypass has to carry.
   *
   * Long enough that "x" does not pass, short enough that somebody in a hurry
   * still writes one. The point is not the length - it is that a person had to
   * stop and say why, and that what they said is in the audit log next to what
   * they pushed.
   */
  minimumReasonLength: number

  /** Credentials only this instance issues. */
  patterns: PushProtectionPattern[]
}

export default {
  enabled: true,
  allowBypass: true,
  minimumReasonLength: 12,

  patterns: [
    // {
    //   name: 'an Acme service token',
    //   pattern: 'acme_[A-Za-z0-9]{32}',
    //   confidence: 'certain',
    // },
  ],
} satisfies PushProtectionConfig
