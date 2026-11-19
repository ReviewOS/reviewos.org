import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkoutCode } from '../../app/Actions/Runner/checkout'

// Real Git/HTTP catches a detached bootstrap re-downloading known history.
// Controller authentication and the deployed gateway have separate coverage.
test('a later origin fetch negotiates from the exact bootstrap source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-negotiation-'))
  const source = join(root, 'source'), bare = join(root, 'origin.git'), workspace = join(root, 'workspace')
  mkdirSync(source); mkdirSync(workspace)
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' }
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd: source, env, stdout: 'pipe', stderr: 'pipe' })
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    return result.stdout.toString().trim()
  }
  git('init', '-q', '-b', 'main')
  writeFileSync(join(source, 'tracked.txt'), 'The qualified source.\n')
  git('add', '.'); git('commit', '-qm', 'qualified source')
  const sha = git('rev-parse', 'HEAD')
  git('clone', '--bare', '-q', source, bare)
  const requests: string[] = []
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url)
    const advertise = url.pathname.endsWith('/info/refs') && url.searchParams.get('service') === 'git-upload-pack'
    if (!advertise && !url.pathname.endsWith('/git-upload-pack')) return new Response('Not found', { status: 404 })
    const input = advertise ? undefined : new Uint8Array(await request.arrayBuffer())
    if (input) requests.push(new TextDecoder().decode(input))
    const child = Bun.spawnSync(['git', 'upload-pack', '--stateless-rpc', ...(advertise ? ['--advertise-refs'] : []), bare], { env, stdin: input, stdout: 'pipe', stderr: 'pipe' })
    if (child.exitCode !== 0) return new Response(child.stderr, { status: 500 })
    const body = advertise ? Buffer.concat([Buffer.from('001e# service=git-upload-pack\n0000'), child.stdout]) : child.stdout
    return new Response(body, { headers: { 'Content-Type': `application/x-git-upload-pack-${advertise ? 'advertisement' : 'result'}` } })
  } })
  const run = async (command: string, environment: Record<string, string> = {}) => {
    const child = Bun.spawn(['sh', '-c', command], { cwd: workspace, env: { ...env, ...environment }, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, errors, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { ok: exitCode === 0, exitCode, stdout, errors }
  }
  try {
    const boot = await checkoutCode({ reposRoot: join(root, 'absent'), fullName: 'acme/widgets', sha, workspace, baseUrl: server.url.origin, options: { depth: 0 }, onOutput: async () => {}, run: options => run(options.command, options.environment) })
    expect(boot.ok).toBe(true)
    writeFileSync(join(source, 'new.txt'), 'The origin advanced while checks ran.\n')
    git('add', '.'); git('commit', '-qm', 'advance origin'); git('push', '-q', bare, 'main')
    const latest = git('rev-parse', 'HEAD')
    requests.length = 0
    const fetched = await run('git fetch --quiet --no-tags origin refs/heads/main')
    expect(fetched.ok, fetched.errors).toBe(true)
    expect(requests.some(body => body.includes(`have ${sha}`)), 'the fetch must offer already verified history instead of requesting another full pack').toBe(true)
    expect(git('-C', workspace, 'rev-parse', 'FETCH_HEAD')).toBe(latest)
    expect(git('-C', workspace, 'rev-parse', 'HEAD')).toBe(sha)
  }
  finally { server.stop(true); rmSync(root, { recursive: true, force: true }) }
}, 30_000)
