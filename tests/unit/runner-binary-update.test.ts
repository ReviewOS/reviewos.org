import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installBinary, runnerUpdateTransport } from '../../app/Commands/RunnerProvision'

for (const unchanged of [false, true]) {
  test(`runner binary updates pin every SSH connection and ${unchanged ? 'leave an identical binary alone' : 'drain only after preserving and replacing the binary'}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'reviewos-runner-update-'))
    try {
      const binary = join(root, 'reviewos-runner')
      writeFileSync(binary, 'synthetic compiled runner')
      const digest = createHash('sha256').update('synthetic compiled runner').digest('hex')
      const calls: Array<{ argv: string[], script: string }> = []
      const transport = runnerUpdateTransport('/synthetic/operator-key', '/synthetic/known_hosts', { run: async (argv, input) => {
        calls.push({ argv, script: input ?? '' })
        return { code: 0, stderr: '', stdout: input?.includes('getent passwd') ? '/home/runner\n' : input?.includes('sha256sum') ? `${unchanged || input.includes('.next') ? digest : 'a'.repeat(64)}\n` : '' }
      } })
      await installBinary({ user: { name: 'runner' }, services: { 'reviewos-runner': { exec: '%h/reviewos-runner' } } }, '192.0.2.10', binary, 'signal', transport)
      for (const call of calls) {
        expect(call.argv).toContain('StrictHostKeyChecking=yes')
        expect(call.argv).toContain('UserKnownHostsFile=/synthetic/known_hosts')
        expect(call.argv).not.toContain('UserKnownHostsFile=/dev/null')
      }
      expect(calls.some(call => call.argv[0] === 'scp')).toBe(!unchanged)
      if (!unchanged) {
        const scripts = calls.map(call => call.script)
        expect(scripts.findIndex(script => script.includes('cp -p'))).toBeLessThan(scripts.findIndex(script => script.includes('SIGUSR2')))
        expect(scripts.find(script => script.includes('mv '))).toContain('/home/runner/reviewos-runner.next /home/runner/reviewos-runner')
      }
    }
    finally { rmSync(root, { recursive: true, force: true }) }
  })
}
