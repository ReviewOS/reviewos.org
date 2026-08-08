import type { BuddyBotConfig } from 'buddy-bot'

/**
 * Dependency updates for this repository.
 *
 * buddy-bot ran here on defaults, which is why this file exists: the workflow
 * in `.github/workflows/buddy-bot.yml` has been calling `bunx buddy-bot` with
 * nothing to read, so every choice below was being made implicitly and none of
 * them were written down.
 *
 * The shape of this project makes three of those choices non-obvious, and each
 * one has already gone wrong at least once.
 */
export default {
  repository: {
    provider: 'github',
    owner: 'stacksjs',
    name: 'reviewos.org',
    baseBranch: 'main',
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
