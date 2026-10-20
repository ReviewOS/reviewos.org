import { expect, test } from 'bun:test'
import { buildBoxSandboxConvergeScript } from '@stacksjs/ts-cloud/drivers'
import { boxes } from '../../cloud/boxes'

test('the maintained HQ declaration scopes its job Chrome policy without provisioning the box', () => {
  const box = boxes['hq-runner']!
  expect(box.sandboxedPackageProjects).toEqual(['/tmp/reviewos-job-*'])
  const script = buildBoxSandboxConvergeScript(box)
  const profiles = [...script.matchAll(/printf %s '([A-Za-z0-9+/=]+)'/g)]
    .map(match => Buffer.from(match[1]!, 'base64').toString('utf8'))
    .filter(text => text.includes('profile ts-cloud-pantry-chrome '))
  expect(profiles).toHaveLength(1)
  const attachment = profiles[0]!.match(/profile ts-cloud-pantry-chrome \/\{(.+)\} flags=/)![1]!
  const patterns = attachment.split(',').map(path => new Bun.Glob(`/${path}`))
  const allows = (path: string) => patterns.some(pattern => pattern.match(path))
  expect(allows('/tmp/reviewos-job-2388-obs38g/pantry/google.com/chrome/v155.0.8059.84.1/lib/chrome-for-testing/chrome')).toBe(true)
  expect(allows('/opt/pantry/pantry/google.com/chrome/v155.0.8059.84/lib/chrome-for-testing/chrome')).toBe(true)
  for (const path of [
    '/tmp/unrelated-job-2388/pantry/google.com/chrome/v155/lib/chrome-for-testing/chrome',
    '/tmp/reviewos-job-2388/subproject/pantry/google.com/chrome/v155/lib/chrome-for-testing/chrome',
    '/tmp/reviewos-job-2388/pantry/other.com/chrome/v155/lib/chrome-for-testing/chrome',
    '/tmp/reviewos-job-2388/pantry/google.com/chrome/v155/lib/chrome-for-testing/shell',
  ]) expect(allows(path)).toBe(false)
  for (const operation of ['pantry install', 'systemctl', 'resize', 'useradd', 'usermod', '/etc/rpx', 'curl', 'ssh '])
    expect(script).not.toContain(operation)
})
