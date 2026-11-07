import { expect, test } from 'bun:test'
import { tsCloud } from '../../config/cloud'
import { deploymentHookSecret } from '../../cloud/git-hooks'

test('deployment hook credentials are stable, distinct from the application key and shared by both sites', () => {
  const key = 'fixture-application-key-never-a-real-secret'
  const secret = deploymentHookSecret(key)
  expect(secret).toMatch(/^[a-f0-9]{64}$/)
  expect(secret).toBe(deploymentHookSecret(key))
  expect(secret).not.toBe(key)
  expect(secret).not.toBe(deploymentHookSecret(key + 'other'))
  expect(deploymentHookSecret('')).toBe('')
  expect(deploymentHookSecret(key, 'a-separate-explicit-credential')).toBe('a-separate-explicit-credential')
  expect(() => deploymentHookSecret(key, 'short')).toThrow()
  const sites = (tsCloud as any).sites
  expect(sites.reviewos.env.GIT_HOOK_SECRET).toBe(sites.api.env.GIT_HOOK_SECRET)
  expect(sites.reviewos.env.GIT_HOOK_URL).toBe('http://127.0.0.1:3073')
  expect(sites.api.env.GIT_HOOK_URL).toBe(sites.reviewos.env.GIT_HOOK_URL)
  expect(sites.reviewos.preStart).toContain('bun node_modules/@stacksjs/buddy/dist/cli.js git:hooks')
})
