import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkoutCode } from '../../app/Actions/Runner/checkout'

test.each(['interrupted', 'forbidden', 'persistent'] as const)('remote checkout handles %s transfers without replaying initialization', async (failure) => {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-transfer-'))
  const source = join(root, 'source'), bare = join(root, 'widgets.git'), workspace = join(root, 'workspace')
  mkdirSync(source); mkdirSync(workspace)
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd: source, env })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    return result.stdout.toString().trim()
  }
  git('init', '-q', '-b', 'main')
  writeFileSync(join(source, 'tracked.txt'), 'The exact requested source.\n')
  git('add', '.'); git('commit', '-qm', 'fixture')
  const sha = git('rev-parse', 'HEAD')
  git('clone', '--bare', '-q', source, bare)
  git('-C', bare, 'repack', '-ad'); git('-C', bare, 'update-server-info')
  let packs = 0, rejected = 0
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    const prefix = '/git/acme/widgets.git/'
    if (!path.startsWith(prefix)) return new Response('Not found', { status: 404 })
    if (failure === 'forbidden') { rejected++; return new Response('Forbidden', { status: 403 }) }
    const relative = path.slice(prefix.length)
    if (relative.includes('..')) return new Response('Not found', { status: 404 })
    const file = Bun.file(join(bare, relative))
    if (!await file.exists()) return new Response('Not found', { status: 404 })
    if (path.endsWith('.pack') && (++packs === 1 || failure === 'persistent')) {
      const bytes = new Uint8Array(await file.arrayBuffer())
      // A real HTTP body ends before its advertised length, the failure
      // observed on the owned Mac. Git must reject it and refetch its SHA.
      return new Response(bytes.slice(0, Math.floor(bytes.length / 2)), { headers: { 'Content-Length': String(bytes.length), 'Content-Type': 'application/octet-stream' } })
    }
    return new Response(file, { headers: { 'Content-Type': 'text/plain' } })
  } })
  const commands: string[] = [], output: string[] = []
  try {
    const result = await checkoutCode({ reposRoot: join(root, 'absent'), fullName: 'acme/widgets', sha, workspace, baseUrl: server.url.origin, options: { depth: 0 }, onOutput: async text => { output.push(text) }, run: async options => {
      commands.push(options.command)
      const proc = Bun.spawn(['sh', '-c', options.command], { cwd: options.cwd, env: { ...env, ...options.environment, GIT_HTTP_LOW_SPEED_LIMIT: '1', GIT_HTTP_LOW_SPEED_TIME: '2' }, stdout: 'pipe', stderr: 'pipe' })
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      await options.onOutput(stdout, 'stdout'); await options.onOutput(stderr, 'stderr')
      return { ok: code === 0, exitCode: code }
    } })
    expect(commands.filter(command => command.includes('git init'))).toHaveLength(1)
    expect(commands.filter(command => command.includes('git remote add'))).toHaveLength(1)
    if (failure === 'interrupted') {
      expect(result.ok, output.join('')).toBe(true)
      expect(packs).toBe(2)
      expect(readFileSync(join(workspace, 'tracked.txt'), 'utf8')).toBe('The exact requested source.\n')
      expect(git('-C', workspace, 'rev-parse', 'HEAD')).toBe(sha)
    }
    else {
      expect(result.ok).toBe(false)
      expect(commands.some(command => command.startsWith('git checkout'))).toBe(false)
      if (failure === 'forbidden') expect(rejected).toBe(1)
      else expect(packs).toBe(3)
    }
  }
  finally { server.stop(true); rmSync(root, { recursive: true, force: true }) }
}, 30_000)
