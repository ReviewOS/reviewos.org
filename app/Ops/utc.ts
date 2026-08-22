/**
 * **This process runs in UTC.**
 *
 * Not a preference, and not about how dates are displayed. It is the only thing
 * standing between this application and every timestamp comparison in it being
 * wrong by an offset.
 *
 * ## What goes wrong without it
 *
 * All two hundred and sixty-one timestamp columns in this schema are
 * `timestamp without time zone`, and every one of them holds a **UTC wall
 * clock**: the column defaults pin it there (`now() AT TIME ZONE 'utc'` on
 * Postgres, `UTC_TIMESTAMP` on MySQL) and anything this application writes goes
 * through `dbTimestamp`, which is `toISOString`.
 *
 * A naive column has no offset in it, so when the driver reads one back it has
 * to choose a frame to build a `Date` in, and it chooses **this process's**.
 * With the process in `America/Los_Angeles`, a row stored as
 * `2026-08-22 18:40:32` comes back as the instant `2026-08-23T01:40:32Z` -
 * seven hours late. Measured, not inferred: the skew was exactly 25,199,262ms.
 *
 * Fifty-four places in this application then compare such a value against
 * `Date.now()`, and most of them decide whether something has expired. West of
 * UTC everything lives longer than it should: a two-minute WebAuthn challenge
 * in `PasskeyAction` stays valid for seven hours and two minutes, and an
 * expired access token keeps working. East of UTC the sign flips and things
 * expire before they are issued, which breaks passkeys outright.
 *
 * ## Why it was invisible
 *
 * Bun's test runner resolves the timezone to UTC on its own, so the entire
 * suite ran in the one configuration where the bug cannot appear -
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` is `UTC` under `bun test`
 * and `America/Los_Angeles` in the same checkout outside it. Six thousand
 * passing tests said nothing about it. `tests/unit/utc.test.ts` closes that by
 * running a subprocess in a *different* zone, which is the only arrangement
 * that can fail.
 *
 * ## Why here rather than at each of the fifty-four
 *
 * Because the fifty-fifth would forget. Converting at the read sites is
 * correct and is what a future one has to remember to do; running the process
 * in the frame its data is already stored in is correct for all of them at
 * once, including the ones written next year. Servers run in UTC for exactly
 * this reason.
 *
 * Loaded from `bunfig.toml`'s `preload`, so it applies to every way this
 * project starts - `bun test`, `./buddy`, `bun run`, the server - rather than
 * to whichever entry points somebody remembered.
 *
 * Assigning `process.env.TZ` at runtime is enough: Bun re-reads it, and it
 * takes effect even for `Date`s constructed after the assignment in a process
 * that already made some.
 */

import process from 'node:process'

/** The zone this process runs in, whatever the machine underneath it thinks. */
export const PROCESS_TIMEZONE = 'UTC'

/**
 * Set unconditionally, including over an explicit `TZ`.
 *
 * Deferring to one that was already set is the tempting version and it is
 * wrong. `TZ` in a container is almost never a considered decision about this
 * application - it is inherited from a base image, or set in a compose file so
 * that logs read in somebody's local time. Nobody who sets it is asking for
 * access tokens to expire seven hours late, and honouring it silently is
 * exactly how that would happen.
 *
 * This costs nothing that matters. Showing a time in a reader's own zone is a
 * formatting concern and is handled where the reader's zone is actually known:
 * `notification_schedules.timezone` holds it per person, which is the only
 * place a correct answer exists. The process clock is not that place, and a
 * server that guesses from its host is guessing.
 */
process.env.TZ = PROCESS_TIMEZONE
