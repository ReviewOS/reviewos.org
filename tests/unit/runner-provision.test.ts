import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
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
  await installBinary({ user: { name: 'runner' }, services: { 'reviewos-runner': { exec: '%h/reviewos-runner' } } }, 'fixture.invalid', binary, 'signal', {
    async exec(host, command) {
      expect(host).toBe('fixture.invalid')
      commands.push(command)
      return command.startsWith('getent ') ? '/home/runner' : command.startsWith('sha256sum ') ? createHash('sha256').update(command.includes('.next') ? 'new runner fixture' : 'old runner fixture').digest('hex') : ''
    },
    async scp(host, path, target) {
      expect(host).toBe('fixture.invalid')
      expect(path).toBe(binary)
      uploads.push(target)
    },
  })
  expect(uploads).toEqual(['/home/runner/reviewos-runner.next'])
  const signals = commands.filter(command => command.includes('systemctl'))
  expect(signals).toHaveLength(1)
  expect(signals[0]).toContain('systemctl --user kill --kill-who=main -s SIGUSR2 reviewos-runner.service')
  expect(commands.findIndex(command => command.includes('mv '))).toBeLessThan(commands.indexOf(signals[0]!))
})

test('keeps the two newest replaced runners and removes the older ones', async () => {
  const own = mkdtempSync(join(tmpdir(), 'reviewos-provision-prune-'))
  const binary = join(own, 'runner')
  writeFileSync(binary, 'new runner fixture')
  const commands: string[] = []
  await installBinary({ user: { name: 'runner' }, services: { 'reviewos-runner': { exec: '%h/reviewos-runner' } } }, 'fixture.invalid', binary, 'none', {
    async exec(_host, command) {
      commands.push(command)
      return command.startsWith('getent ') ? '/home/runner' : command.startsWith('sha256sum ') ? createHash('sha256').update(command.includes('.next') ? 'new runner fixture' : 'old runner fixture').digest('hex') : ''
    },
    async scp() {},
  })
  const prune = commands.find(command => command.includes('.before-') && command.includes('rm -f'))
  expect(prune).toBeDefined()
  expect(commands.indexOf(prune!)).toBeGreaterThan(commands.findIndex(command => command.includes('mv ')))

  // Run it against real files: a box collected one ~100 MB copy per update.
  const box = mkdtempSync(join(own, 'box-'))
  const names = ['aaa', 'bbb', 'ccc', 'ddd', 'eee']
  names.forEach((name, age) => {
    const file = join(box, `reviewos-runner.before-${name}`)
    writeFileSync(file, name)
    utimesSync(file, 1_700_000_000 + age * 60, 1_700_000_000 + age * 60)
  })
  writeFileSync(join(box, 'reviewos-runner'), 'current')
  const result = Bun.spawnSync(['sh', '-c', prune!.replaceAll('/home/runner/', `${box}/`)])
  expect(result.exitCode).toBe(0)
  expect(readdirSync(box).sort()).toEqual(['reviewos-runner', 'reviewos-runner.before-ddd', 'reviewos-runner.before-eee'])
  rmSync(own, { recursive: true, force: true })
})
