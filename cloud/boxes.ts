import type { BoxConfig } from '@stacksjs/ts-cloud'

/**
 * The machines this instance's runners live on.
 *
 * Declared here and converged by `buddy runner:provision`, which hands each
 * box to ts-cloud: it finds the server by name (an existing one is adopted,
 * never recreated), applies its firewall, and runs one idempotent script that
 * installs the pinned pantry and the packages below into /opt/pantry, keeps
 * the service user lingering, and writes the runner's systemd user unit.
 * Pantry's packages reach jobs through the unit's PATH, so a step finds the
 * box's Chrome with `command -v google-chrome-stable` instead of installing a
 * 9 GB browser tree into its own workspace on every run.
 *
 * Apply with `buddy runner:provision` (this instance's command: converge, then
 * install a new runner binary and drain onto it), or ts-cloud's own
 * `boxes:apply --dry-run` to see what would change.
 *
 * The runner's credential is not here. It is minted on the machine when the
 * runner registers (`buddy runner:local --register`) and lives in the env file
 * the unit names; the declaration only says where.
 */
export const boxes: Record<string, BoxConfig> = {
  'hq-runner': {
    name: 'reviewos-runner-hq',
    // 8 cores, 16 GB, 160 GB: HQ's api-e2e holds two cores at 100% for 15
    // minutes and every other job queued behind it on the cx23's two.
    size: 'cx43',
    location: 'fsn1',
    // Applying this drains the runner (it finishes the job it holds), powers
    // the box off and changes its type - but only once Hetzner lists cx43 in
    // stock in fsn1. Until then every provision keeps the cx23 and converges
    // as usual, so the retry costs nothing. (Asking placement out of stock was
    // refused on 2026-10-19, 412 resource_unavailable, a minute of downtime.)
    // Chris, 2026-10-19: wait for cx43 rather than pay for cpx42; an AWS
    // runner is the plan once the AWS credits arrive.
    resize: { whenUnavailable: 'keep-current' },
    pantryVersion: '0.11.99',
    packages: ['bun.sh@1.4.3', 'git-scm.org@2.53.0', 'google.com/chrome@155.0.8059.84'],
    sandboxedPackageProjects: ['/tmp/reviewos-job-*'],
    // Chrome's pantry tree is about 9 GB on Linux; a job needs room of its own after it.
    minFreeDiskGb: 12,
    user: { name: 'runner', groups: ['docker'] },
    services: {
      'reviewos-runner': {
        description: 'ReviewOS runner for stacks/hq.training (reviewos.org)',
        exec: '%h/reviewos-runner',
        workingDirectory: '%h/work',
        environmentFile: '%h/.config/reviewos-runner.env',
        // Where `uses:` actions come from: github.com only, pinned to a full
        // commit. Was a hand-written drop-in (pantry-actions.conf, same values).
        environment: {
          REVIEWOS_ACTION_HOSTS: 'github.com',
          REVIEWOS_ACTION_DEFAULT_HOST: 'github.com',
          REVIEWOS_ACTION_PINNED: '1',
        },
        // Finish the job in hand, claim no other, exit (runner 83b4f4c3+).
        // A resize drains with it before powering the box off.
        drainSignal: 'SIGUSR2',
      },
    },
  },
}
