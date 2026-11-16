import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOnce } from '../../app/Actions/Runner/localExecutor'

// The public claim/execute/report seam exercises real Git and step files. It
// catches destructive duplicate checkout and shallow ancestry, not forge auth.
test('a standard checkout action preserves runner state and checks out full exact-source history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-checkout-action-'))
  const source = join(root, 'source'), repos = join(root, 'repos'), bare = join(repos, 'acme/widgets.git')
  mkdirSync(source); mkdirSync(join(repos, 'acme'), { recursive: true })
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd: source, env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' } })
    if (result.exitCode) throw Error(result.stderr.toString())
    return result.stdout.toString().trim()
  }
  git('init', '-q', '-b', 'main')
  writeFileSync(join(source, 'tracked.txt'), 'first'); git('add', '.'); git('commit', '-qm', 'first')
  writeFileSync(join(source, 'tracked.txt'), 'second'); git('commit', '-qam', 'second')
  const sha = git('rev-parse', 'HEAD'); git('clone', '--bare', '-q', source, bare)
  const recorded = new Map<number, any>()
  let pending = true, logs = '', reported = ''
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    const body = await request.json().catch(() => ({}))
    for (const step of body.steps ?? []) recorded.set(step.position, step)
    if (path.endsWith('/logs')) logs += String(body.content ?? '')
    if (path.endsWith('/report')) reported = body.state
    if (path !== '/api/runner/claim' || !pending) return Response.json({ ok: true, held: true })
    pending = false
    return Response.json({ job: { id: 9813, token: 'synthetic-lease-token', key: 'checkout', repository_full_name: 'acme/widgets', checkout: { depth: 1 }, run: { id: 1, number: 1, event: 'push', ref: 'refs/heads/main', head_sha: sha }, steps: [
      { uses: 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262', with: { 'fetch-depth': 0, 'persist-credentials': false } },
      { run: 'git rev-list --count HEAD > history.txt\nprintf "%s" "$GITHUB_SERVER_URL" > controller.txt' },
    ] } })
  } })
  try {
    const outcome = await runOnce({ baseUrl: `http://127.0.0.1:${server.port}`, token: 'synthetic-runner', workspaceRoot: root, reposRoot: repos, tools: false, policy: { defaultHost: 'github.com', allowedHosts: ['github.com'], requirePinnedSha: true, allowLocal: true, allowContainers: false } as any })
    expect(outcome?.state, logs).toBe('succeeded')
    const workspace = join(root, 'job-9813')
    expect(readFileSync(join(workspace, 'tracked.txt'), 'utf8')).toBe('second')
    expect(readFileSync(join(workspace, 'history.txt'), 'utf8').trim()).toBe('2')
    expect(readFileSync(join(workspace, 'controller.txt'), 'utf8')).toBe(`http://127.0.0.1:${server.port}`)
    expect(reported).toBe('succeeded')
    expect([...recorded.keys()].sort()).toEqual([0, 1])
    expect(recorded.get(0)?.state).toBe('succeeded')
    expect(recorded.get(0)?.outputs?.commit).toBe(sha)
    expect(logs).not.toContain('synthetic-lease-token')
  }
  finally { server.stop(true); rmSync(root, { recursive: true, force: true }) }
}, 30_000)

// The same public executor seam proves the default action reuses the verified
// bootstrap commit while still cleaning a dirty workspace. It does not test
// the remote server's HTTP transport, which has separate wire regressions.
test.each([{ depth: 1, changedHead: false }, { depth: 1, changedHead: true }, { depth: 2, changedHead: false }, { depth: 0, changedHead: false }])('checkout depth $depth with changed HEAD $changedHead preserves its fetch requirement', async ({ depth, changedHead }) => {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-checkout-reuse-'))
  const source = join(root, 'source'), repos = join(root, 'repos')
  mkdirSync(source); mkdirSync(join(repos, 'acme'), { recursive: true })
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd: source, env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' } })
    if (result.exitCode) throw Error(result.stderr.toString())
    return result.stdout.toString().trim()
  }
  git('init', '-q', '-b', 'main')
  writeFileSync(join(source, 'tracked.txt'), 'original'); git('add', '.'); git('commit', '-qm', 'source')
  const sha = git('rev-parse', 'HEAD')
  git('clone', '--bare', '-q', source, join(repos, 'acme/widgets.git'))
  let pending = true, logs = ''
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const path = new URL(request.url).pathname
    const body = await request.json().catch(() => ({}))
    if (path.endsWith('/logs')) logs += String(body.content ?? '')
    if (path !== '/api/runner/claim' || !pending) return Response.json({ ok: true, held: true })
    pending = false
    return Response.json({ job: { id: 9814, token: 'synthetic-lease-token', key: 'checkout', repository_full_name: 'acme/widgets', checkout: { depth: 1 }, run: { id: 1, number: 1, event: 'push', ref: 'refs/heads/main', head_sha: sha }, steps: [
      { run: `${changedHead ? 'git -c user.name=Fixture -c user.email=fixture@example.test commit --allow-empty -qm intervening\n' : ''}git remote set-url origin ./unavailable-origin.git\nprintf dirty > tracked.txt\nprintf disposable > disposable.txt` },
      { uses: 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262', with: { 'fetch-depth': depth } },
      { run: 'test ! -e disposable.txt && test -d .reviewos-runner' },
    ] } })
  } })
  try {
    const outcome = await runOnce({ baseUrl: `http://127.0.0.1:${server.port}`, token: 'synthetic-runner', workspaceRoot: root, reposRoot: repos, tools: false, policy: { defaultHost: 'github.com', allowedHosts: ['github.com'], requirePinnedSha: true, allowLocal: true, allowContainers: false } as any })
    expect(outcome?.state, logs).toBe(depth === 1 && !changedHead ? 'succeeded' : 'failed')
    expect(readFileSync(join(root, 'job-9814/tracked.txt'), 'utf8')).toBe(depth === 1 && !changedHead ? 'original' : 'dirty')
    expect(logs).not.toContain('synthetic-lease-token')
  }
  finally { server.stop(true); rmSync(root, { recursive: true, force: true }) }
}, 30_000)
