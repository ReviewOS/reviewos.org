import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRepositoryWorkspace } from '../../app/Actions/Git/snapshotWorkspace'

test('snapshot scratch ownership preserves live and unjournaled data while completing only its own workspace', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-repository-workspace-'))
  try {
    const unjournaled = join(root, 'repository-work-unmanaged')
    mkdirSync(unjournaled); writeFileSync(join(unjournaled, 'retained'), 'preserved bytes')
    const first = await createRepositoryWorkspace(root, 'snapshot-1')
    writeFileSync(join(first.path, 'bundle'), 'active attempt')
    expect(statSync(join(first.path, 'workspace-owner.json')).mode & 0o077).toBe(0)
    const second = await createRepositoryWorkspace(root, 'restore-1')
    expect(readFileSync(join(first.path, 'bundle'), 'utf8')).toBe('active attempt')
    second.complete(); first.complete()
    expect(existsSync(first.path)).toBe(false)
    expect(existsSync(second.path)).toBe(false)
    expect(readFileSync(join(unjournaled, 'retained'), 'utf8')).toBe('preserved bytes')
    expect(readdirSync(join(root, 'repository-journal'))).toEqual([])
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})

test('unverifiable recovered ownership never authorizes scratch removal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-repository-workspace-'))
  try {
    const original = await createRepositoryWorkspace(root, 'snapshot-2')
    writeFileSync(join(original.path, 'workspace-owner.json'), JSON.stringify({ owner: { host: 'unknown' } }))
    writeFileSync(join(original.path, 'bundle'), 'keep this incomplete attempt')
    const next = await createRepositoryWorkspace(root, 'snapshot-3')
    expect(readFileSync(join(original.path, 'bundle'), 'utf8')).toBe('keep this incomplete attempt')
    next.complete(); original.complete()
  }
  finally { rmSync(root, { recursive: true, force: true }) }
})


test.skipIf(process.platform !== 'linux')('an exited snapshot worker leaves a recoverable journal and the next attempt retires only its scratch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reviewos-repository-workspace-'))
  try {
    const module = new URL('../../app/Actions/Git/snapshotWorkspace.ts', import.meta.url).pathname
    const child = Bun.spawn([process.execPath, '--no-env-file', '--config=/dev/null', '-e', `
      const { createRepositoryWorkspace } = await import(${JSON.stringify(module)});
      const workspace = await createRepositoryWorkspace(${JSON.stringify(root)}, 'snapshot-abandoned');
      await Bun.write(workspace.path + '/bundle', 'interrupted scratch');
      console.log('__workspace__' + workspace.path);
    `], { stdout: 'pipe', stderr: 'pipe', signal: AbortSignal.timeout(10000) })
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(code, error).toBe(0)
    const abandoned = output.match(/^__workspace__(.+)$/m)?.[1]
    expect(abandoned).toBeDefined()
    expect(readFileSync(join(abandoned!, 'bundle'), 'utf8')).toBe('interrupted scratch')
    const next = await createRepositoryWorkspace(root, 'snapshot-replacement')
    if (existsSync(abandoned!)) {
      const { TemporaryWorkspaceJournal } = await import('@stacksjs/storage')
      const { processLeaseOwnerStatus } = await import('@stacksjs/queue')
      const journal = new TemporaryWorkspaceJournal({ directory: join(root, 'repository-journal'), temporaryRoot: root, prefix: 'repository-work-' })
      const record = journal.list().find(row => row.path === abandoned)
      const owner = JSON.parse(readFileSync(join(abandoned!, 'workspace-owner.json'), 'utf8')).owner
      console.error('Recovery inspection', JSON.stringify({ owner: processLeaseOwnerStatus(owner), inspection: record ? await journal.inspectRetirement(record.id, () => true) : null }))
    }
    expect(existsSync(abandoned!)).toBe(false)
    expect(existsSync(next.path)).toBe(true)
    next.complete()
    expect(readdirSync(join(root, 'repository-journal'))).toEqual([])
  }
  finally { rmSync(root, { recursive: true, force: true }) }
}, 15000)
