import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installBinary } from '../../app/Commands/RunnerProvision'

const directory = mkdtempSync(join(tmpdir(), 'reviewos-provision-'))
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

test('installing a new runner signals only its main process, preserving active jobs', async () => {
  const binary = join(directory, 'runner')
  writeFileSync(binary, 'new runner fixture')
  const commands: string[] = []
  const uploads: string[] = []
  await installBinary({ user: { name: 'runner' }, services: { 'reviewos-runner': { exec: '%h/reviewos-runner' } } }, 'fixture.invalid', binary, 'signal', '/fixture/key', {
    async sshExecOrThrow(host, command) {
      expect(host).toBe('fixture.invalid')
      commands.push(command)
      return command.startsWith('getent ') ? '/home/runner' : command.startsWith('sha256sum ') ? createHash('sha256').update('old runner fixture').digest('hex') : ''
    },
    async scpUpload(host, paths, target) {
      expect(host).toBe('fixture.invalid')
      expect(paths).toEqual([binary])
      uploads.push(target)
    },
  })
  expect(uploads).toEqual(['/home/runner/reviewos-runner.next'])
  const signals = commands.filter(command => command.includes('systemctl'))
  expect(signals).toHaveLength(1)
  expect(signals[0]).toContain('systemctl --user kill --kill-who=main -s SIGUSR2 reviewos-runner.service')
  expect(commands.findIndex(command => command.includes('mv '))).toBeLessThan(commands.indexOf(signals[0]!))
})
