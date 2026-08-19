/**
 * **Push write-ahead log**
 *
 * Whether a push is written down before it is acknowledged, and what happens
 * when it cannot be.
 *
 * Its own file rather than a key in `config/git.ts`, because that one is the
 * framework's commit-convention config - hooks, scopes, changelog - and has a
 * type from `@stacksjs/types` that does not describe this. Same precedent as
 * `config/push-protection.ts`: a ReviewOS feature setting, plainly exported.
 *
 * ## The three modes, and why the middle one exists
 *
 * - `off` - nothing is recorded. The behavior every install has today.
 * - `advisory` - every push is recorded, and a failure to record is logged and
 *   allowed. Backup, with no new way for a push to fail.
 * - `required` - a push that cannot be recorded is **refused**.
 *
 * `required` is the one that makes the log a guarantee rather than a
 * best-effort archive, and it is deliberately not the default, because it
 * inverts something this codebase has written down and relied on:
 *
 * > if the application cannot be reached, the push is allowed. A forge that
 * > stops accepting pushes because its web process restarted is a forge people
 * > work around by pushing somewhere else.
 *
 * That reasoning (in `app/Actions/Git/hooks.ts`) is still right for branch
 * protection, which is a guard rail against a mistake. It is *not* right for a
 * durability guarantee: a WAL that silently skips the pushes it could not
 * record is a backup with holes exactly where the incident was. The two want
 * opposite failure modes, so the mode is a choice an operator makes with their
 * eyes open rather than a default that changes what a push means.
 *
 * So the ladder is: ship `advisory`, let instances run it for a release and
 * see the log fill with no push refused, and let them choose `required` when
 * they want the guarantee. `off` stays supported forever for the instance that
 * wants none of it.
 */

import process from 'node:process'

export type WalMode = 'off' | 'advisory' | 'required'

export interface GitWalConfig {
  mode: WalMode
  /**
   * How many committed entries to keep behind the newest checkpoint.
   *
   * The checkpoint is a full bundle, so anything older than the checkpoint it
   * follows is replayable from that checkpoint instead - the WAL prefix is
   * then only useful for restoring to a point *between* checkpoints, which is
   * what this number buys.
   */
  keepEntries: number
}

const MODES: readonly WalMode[] = ['off', 'advisory', 'required']

/**
 * Read from the environment rather than imported as a config object, because
 * the gate endpoint that needs it runs on the push path and `app/Actions/Git/*`
 * is deliberately importable without booting the config layer.
 *
 * An unrecognised value falls back to `off` rather than to something stricter:
 * a typo must never be the reason pushes start being refused.
 */
export function walMode(env: Record<string, string | undefined> = process.env): WalMode {
  const raw = String(env.GIT_WAL ?? '').trim().toLowerCase()

  return (MODES as readonly string[]).includes(raw) ? raw as WalMode : 'off'
}

export function walKeepEntries(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.GIT_WAL_KEEP ?? 0)

  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 500
}

export default {
  mode: walMode(),
  keepEntries: walKeepEntries(),
} satisfies GitWalConfig
