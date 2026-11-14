/**
 * Autoscaled runner groups: the ReviewOS half.
 *
 * ts-cloud owns the cloud side (the Auto Scaling group, the scaling decision,
 * the worker boot script) and tests it there. What is pinned here is what only
 * ReviewOS knows: which jobs a group is for, and how its runner starts.
 */

import { describe, expect, it } from 'bun:test'
import { autoscalingGroups } from '../../cloud/autoscaling'
import { jobFits } from '../../app/Actions/Runner/Autoscale/tick'
import { buildUserData } from '../../app/Actions/Runner/Autoscale/userdata'

describe('which jobs a group is for', () => {
  it('takes a job whose every label the group carries', () => {
    expect(jobFits('ubuntu-latest', ['ubuntu-latest', 'self-hosted', 'aws'])).toBe(true)
    expect(jobFits('ubuntu-latest\nself-hosted', ['ubuntu-latest', 'self-hosted', 'aws'])).toBe(true)
  })

  it('leaves a job that asks for anything it lacks, or for nothing', () => {
    expect(jobFits('macos-latest', ['ubuntu-latest', 'self-hosted', 'aws'])).toBe(false)
    expect(jobFits('ubuntu-latest\ngpu', ['ubuntu-latest', 'self-hosted', 'aws'])).toBe(false)
    expect(jobFits('', ['ubuntu-latest'])).toBe(false)
  })
})

describe('the HQ group', () => {
  const hq = autoscalingGroups['hq-aws']!

  it('is x86 spot in us-east-1, scaling from zero', () => {
    expect(hq.region).toBe('us-east-1')
    expect(hq.min).toBe(0)
    expect(hq.market).toEqual({ spot: true, onDemandBaseCapacity: 0, onDemandPercentageAboveBase: 0 })
    expect(hq.instanceTypes.every(type => /^(c|m)[5-7]a\./.test(type))).toBe(true)
  })
})

describe('how the runner starts', () => {
  const hq = autoscalingGroups['hq-aws']!
  const script = buildUserData(hq, { instance: 'https://reviewos.org', registrationToken: 'reg-token-123' })

  it('downloads the runner from this instance and names it after the machine', () => {
    expect(script).toContain('https://reviewos.org/api/runner/download?target=linux-x64')
    expect(script).toContain(`--name "$INSTANCE_ID" --labels 'ubuntu-latest,self-hosted,aws' --idle-timeout 300`)
  })

  it('fetches the runner with the image\'s curl, not whichever one a package put on PATH', () => {
    // Pantry's bin directory leads the runner's PATH. When a rebuilt curl there
    // needed a newer glibc than the image, no machine ever registered.
    expect(script).toContain(`sh -c '/usr/bin/curl -fsSL "$0" -o "$HOME/reviewos-runner"`)
    expect(script).not.toMatch(/sh -c 'curl /)
  })

  it('pins the curl that jobs find to one that runs on the image', () => {
    expect(hq.packages[0]).toBe('curl.se@8.23.0')
    expect(hq.packages.indexOf('curl.se@8.23.0')).toBeLessThan(hq.packages.findIndex(spec => spec.startsWith('git-scm.org@')))
  })

  it('registers with the pool token, through the environment rather than argv', () => {
    expect(script).toContain("REVIEWOS_REGISTRATION_TOKEN='reg-token-123'")
    expect(script).not.toContain('--registration-token')
  })

  it('runs as the runner user, which cannot reach the metadata service', () => {
    expect(script).toContain('--uid-owner runner -d 169.254.169.254/32 -j REJECT')
    expect(script).toContain('sudo -u runner')
  })

  it('refuses a plain-http instance or a missing token', () => {
    expect(() => buildUserData(hq, { instance: 'http://reviewos.org', registrationToken: 'x' })).toThrow('https')
    expect(() => buildUserData(hq, { instance: 'https://reviewos.org', registrationToken: ' ' })).toThrow('registration token')
  })
})
