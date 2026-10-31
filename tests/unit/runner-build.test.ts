import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import configureBuildRunner from '../../app/Commands/BuildRunner'

test('the compiled runner ignores application preload code and dotenv credentials in its working directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-standalone-build-'))
  const directory = join(root, 'binary')
  const marker = join(root, 'application-preload-ran')
  const authorizations: Array<string | null> = []
  const polls: Array<{ protocol: string | null, body: unknown }> = []
  const server = Bun.serve({ port: 0, async fetch(request) {
    authorizations.push(request.headers.get('authorization'))
    polls.push({ protocol: request.headers.get('x-runner-protocol'), body: await request.json() })
    return Response.json({})
  } })
  try {
    let build: ((options: { target: string, out: string }) => Promise<void>) | undefined
    const cli: any = {
      command: () => cli,
      option: () => cli,
      action: (handler: typeof build) => { build = handler; return cli },
    }
    configureBuildRunner(cli)
    await build!({ target: 'host', out: directory })
    const binary = join(directory, 'reviewos-runner')
    expect(existsSync(binary)).toBe(true)
    writeFileSync(join(root, 'bunfig.toml'), 'preload = ["./application-preload.ts"]\n')
    writeFileSync(join(root, 'application-preload.ts'), `await Bun.write(${JSON.stringify(marker)}, 'unexpected'); throw new Error('Application code must not run in the runner');\n`)
    const environment = Object.fromEntries(['HOME', 'PATH', 'TMPDIR', 'LANG', 'CI'].flatMap(name => process.env[name] ? [[name, process.env[name]!]] : []))
    const invoke = async (args: string[], policy: Record<string, string> = {}) => {
      const child = Bun.spawn([binary, ...args], { cwd: root, env: { ...environment, ...policy }, stdout: 'pipe', stderr: 'pipe' })
      const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      return { status, output: stdout + stderr }
    }
    const clean = await invoke([])
    expect(clean.status, clean.output).toBe(0)
    expect(clean.output).toContain('reviewos-runner - run a ReviewOS instance')
    expect(existsSync(marker)).toBe(false)
    writeFileSync(join(root, '.env'), `REVIEWOS_URL=http://127.0.0.1:${server.port}\nREVIEWOS_RUNNER_TOKEN=application-file-token\n`)
    const withDotenv = await invoke(['--once'])
    expect(withDotenv.status, withDotenv.output).toBe(0)
    expect(withDotenv.output).toContain('reviewos-runner - run a ReviewOS instance')
    expect(authorizations).toEqual([])
    const explicit = await invoke(['--once', '--url', `http://127.0.0.1:${server.port}`, '--token', 'explicit-runner-token'])
    expect(explicit.status, explicit.output).toBe(0)
    expect(explicit.output).toContain('nothing to run')
    expect(authorizations).toEqual(['Bearer explicit-runner-token'])
    const argumentsForPoll = ['--once', '--url', `http://127.0.0.1:${server.port}`, '--token', 'explicit-runner-token']
    const held = await invoke(argumentsForPoll, { REVIEWOS_RUNNER_MIN_FREE_DISK_MB: '1000000000' })
    expect(held.status, held.output).toBe(0)
    expect(held.output).toContain('Runner capacity hold')
    expect(polls.at(-1)).toEqual({ protocol: '2', body: { accept_work: false, hold_reason: expect.stringContaining('disk space') } })
    const resumed = await invoke(argumentsForPoll, { REVIEWOS_RUNNER_MIN_FREE_DISK_MB: '1' })
    expect(resumed.status, resumed.output).toBe(0)
    expect(polls.at(-1)).toEqual({ protocol: '2', body: {} })
    const loadHeld = await invoke(argumentsForPoll, { REVIEWOS_RUNNER_MAX_LOAD_PER_CPU: 'invalid' })
    expect(loadHeld.status, loadHeld.output).toBe(0)
    expect(loadHeld.output).toContain('maximum host load setting')
    expect(polls.at(-1)).toEqual({ protocol: '2', body: { accept_work: false, hold_reason: expect.stringContaining('maximum host load setting') } })
    const loadDisabled = await invoke(argumentsForPoll, { REVIEWOS_RUNNER_MAX_LOAD_PER_CPU: '0' })
    expect(loadDisabled.status, loadDisabled.output).toBe(0)
    expect(polls.at(-1)).toEqual({ protocol: '2', body: {} })
    expect(existsSync(marker)).toBe(false)
  }
  finally {
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
