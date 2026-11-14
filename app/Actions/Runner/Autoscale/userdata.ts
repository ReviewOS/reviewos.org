import type { BoxConfig } from '@stacksjs/ts-cloud'
import { BOX_PANTRY_BIN_DIR, buildWorkerUserData } from '@stacksjs/ts-cloud/drivers'
import type { RunnerGroup } from './types'

/**
 * What a runner group's instance runs when it boots: ts-cloud's worker boot
 * script, with the ReviewOS runner as the worker.
 *
 * ts-cloud converges the machine with the same script a box in
 * `cloud/boxes.ts` gets (so a job cannot tell an autoscaled machine from the
 * long-lived one), keeps the runner user away from the metadata service, and
 * terminates the instance when the runner exits. This file only says how the
 * runner starts: downloaded from this instance, registered with the pool's
 * token, named after the instance so the scaler can match machine to runner.
 */
export const RUNNER_ENV = {
  REVIEWOS_ACTION_HOSTS: 'github.com',
  REVIEWOS_ACTION_DEFAULT_HOST: 'github.com',
  REVIEWOS_ACTION_PINNED: '1',
}

export function groupBox(group: RunnerGroup): BoxConfig {
  return {
    name: group.name,
    size: group.instanceTypes[0] ?? '',
    pantryVersion: group.pantryVersion,
    packages: group.packages,
    sandboxedPackageProjects: ['/tmp/reviewos-job-*'],
    minFreeDiskGb: Math.min(12, Math.max(4, Math.floor(group.diskGb / 4))),
    user: { name: 'runner', groups: [] },
  } as BoxConfig
}

function sh(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

export function buildUserData(group: RunnerGroup, options: { instance: string, registrationToken: string }): string {
  const instance = options.instance.replace(/\/$/, '')
  if (!/^https:\/\//.test(instance))
    throw new Error(`The instance URL must be https, not "${instance}"`)
  if (!options.registrationToken.trim())
    throw new Error('A pool registration token is required: the instance registers with it, once')

  const download = `${instance}/api/runner/download?target=linux-x64`
  return buildWorkerUserData({
    box: groupBox(group),
    user: 'runner',
    env: {
      ...RUNNER_ENV,
      PATH: `${BOX_PANTRY_BIN_DIR}:/usr/local/bin:/usr/bin:/bin`,
      REVIEWOS_URL: instance,
      REVIEWOS_REGISTRATION_TOKEN: options.registrationToken,
    },
    command: [
      // The machine's own curl, by path. PATH puts Pantry's tools first, and a
      // curl that came in as somebody's dependency is not this script's to
      // rely on: one built against a newer glibc than the image has (curl.se
      // 8.23.0.2, 2026-11-13) stopped every machine before it could register.
      `sh -c '/usr/bin/curl -fsSL "$0" -o "$HOME/reviewos-runner" && chmod 755 "$HOME/reviewos-runner" && exec "$HOME/reviewos-runner" "$@"' ${sh(download)}`,
      `--name "$INSTANCE_ID" --labels ${sh(group.labels.join(','))} --idle-timeout ${Math.max(60, Math.floor(group.idleTimeoutSeconds))}`,
    ].join(' '),
  })
}
