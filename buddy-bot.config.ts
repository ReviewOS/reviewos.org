import type { BuddyBotConfig } from 'buddy-bot'

/**
 * Dependency updates and advisory scanning for this repository.
 *
 * buddy-bot ran here on defaults, which is why this file exists: the workflow
 * in `.github/workflows/buddy-bot.yml` has been calling `bunx buddy-bot` with
 * nothing to read, so every choice below was being made implicitly and none of
 * them were written down.
 *
 * The shape of this project makes several of those choices non-obvious, and
 * each one has already gone wrong at least once.
 *
 * ## Here, and not in `config/`
 *
 * There was a second copy at `config/buddy-bot.ts`, from the template this
 * project started from, and **buddy-bot never read it**: bunfig looks for
 * `<name>.config.*`, so a file called `config/buddy-bot.ts` is not a candidate
 * under any of its search paths. Two config files where one silently wins is
 * worse than one in the less conventional place, because the next person edits
 * the one that reads better and nothing happens. That copy is gone.
 *
 * ## One bot, not two
 *
 * `.github/renovate.json` sat beside it, also inherited. Two bots on one
 * repository is not redundancy - it is two pull requests per update, neither
 * aware of the other, both going stale while somebody decides. That is gone
 * too; `AGENTS.md` has said buddy-bot is the one this project uses since
 * before either file was looked at.
 */
export default {
  repository: {
    provider: 'github',
    /*
     * `ReviewOS`, which it was not.
     *
     * It said `stacksjs`, carried in from the template and never changed, so
     * every lookup and every pull request was aimed at a repository that does
     * not exist. The failure mode is the quiet one: nothing appears here, and
     * nothing says why.
     */
    owner: 'ReviewOS',
    name: 'reviewos.org',
    baseBranch: 'main',
  },

  /*
   * Advisory scanning, and the half of this file that is not about churn.
   *
   * Every declared dependency version is checked against OSV.dev, and an update
   * that resolves a known vulnerability is separated into its own pull request
   * created *first*. That ordering is the point rather than a nicety: a
   * security fix sitting behind twenty routine bumps is a security fix waiting
   * for somebody to have an afternoon.
   *
   * OSV rather than `npm audit` - it covers npm and Packagist from one query,
   * needs no registry credential, and is where GitHub's own advisories land. It
   * is also a network call, which is why it can be switched off: an air-gapped
   * build should still be able to run the update side.
   *
   * `minimumSeverity: 'low'`, meaning everything. Filtering here decides on
   * somebody else's behalf which vulnerabilities in a *forge* are not worth
   * reading about, and the severity is on the pull request for whoever does
   * decide.
   *
   * These are buddy-bot's defaults. Written out anyway, because "the default is
   * on" is not something anybody can see from this repository, and the whole
   * reason this file exists is that implicit choices were being made.
   */
  security: {
    enabled: true,
    prioritize: true,
    label: 'security',
    minimumSeverity: 'low',
  },

  packages: {
    /*
     * Patch and minor, automatically. Major is deliberately not in here.
     *
     * Almost every dependency in this tree is a first-party package on a
     * fast release cadence - `@stacksjs/*` moved through eleven patch versions
     * during a single day's work - and a bot that opens a pull request per
     * patch across that many packages is a bot people mute. Grouping below is
     * what makes the volume tolerable; excluding major is what keeps the
     * grouped pull request reviewable, because a major is the one update where
     * reading the changelog is the whole job.
     */
    strategy: 'minor',
    excludeMajor: true,

    /*
     * One pull request per family, not per package.
     *
     * The `@stacksjs/*` packages are released together and versioned in
     * lockstep - a release publishes all seventy-nine at the same number - so
     * updating them one at a time produces a pull request that cannot pass CI
     * on its own, because the package it was split from moved too. They have to
     * land together or not at all.
     */
    groups: [
      {
        name: 'stacks',
        patterns: ['@stacksjs/*', 'stacks'],
        strategy: 'minor',
      },
      {
        name: 'in-house tooling',
        // Released independently of Stacks but on the same cadence and by the
        // same hands, so they belong in one pull request for the same reason.
        patterns: ['ts-*', 'bun-*', 'pickier', 'better-dx', 'buddy-bot'],
        strategy: 'minor',
      },
    ],

    /*
     * `stacks` is a dependency here *and* a local binary at `./buddy`.
     *
     * `package.json` carries `"stacks": "./buddy"` under scripts and
     * `"stacks": "^0.70.317"` under dependencies, which are two different
     * things sharing a name. Nothing has confused them yet; this is written
     * down so that when something does, the reason is on the page.
     */
    ignore: [],

    ignorePaths: [
      // Generated, and regenerated from `config/deps.ts` by `buddy setup`. A
      // pull request editing it is a pull request against the wrong file - the
      // config is the source, and the next setup run would revert it.
      'deps.yaml',
      // The framework's own vendored copies. Updating a version inside
      // `storage/framework/defaults` changes what every scaffolded project
      // gets, which is a decision for the Stacks repository rather than for
      // this one.
      'storage/framework/**',
      // Worktrees other sessions are working in. Their package.json files are
      // copies of this one and a pull request touching them is noise.
      '.claude/worktrees/**',
    ],
  },

  pullRequest: {
    /*
     * Squash, matching what this repository does by hand.
     *
     * A dependency bump is one change however many files it touched, and a
     * merge commit per bump makes the history of a fast-moving tree unreadable.
     */
    strategy: 'squash',
    labels: ['dependencies'],
  },
} satisfies BuddyBotConfig
