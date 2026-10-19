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
    // A larger type only applies with `resize:` (it powers the box off).
    size: 'cx23',
    location: 'fsn1',
    pantryVersion: '0.11.99',
    packages: ['bun.sh@1.4.3', 'git-scm.org@2.53.0', 'google.com/chrome@155.0.8059.84'],
    // Chrome's pantry tree is about 9 GB on Linux; a job needs room of its own after it.
    minFreeDiskGb: 12,
    user: { name: 'runner', groups: ['docker'] },
    services: {
      'reviewos-runner': {
        description: 'ReviewOS runner for stacks/hq.training (reviewos.org)',
        exec: '%h/reviewos-runner',
        workingDirectory: '%h/work',
        environmentFile: '%h/.config/reviewos-runner.env',
        // Finish the job in hand, claim no other, exit (runner 83b4f4c3+).
        // A resize drains with it before powering the box off.
        drainSignal: 'SIGUSR2',
      },
    },
  },
}
