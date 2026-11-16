import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { apiCommand, readApiBody } from '../../app/Cli/api-command'
import { call } from '../../app/Cli/api'

for (const method of ['GET', 'POST'] as const) {
  test(`an interrupted ${method} response reports the incomplete answer without repeating the request`, async () => {
    let requests = 0
    const server = createServer((request, response) => {
      request.resume()
      requests++
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1024' })
      response.flushHeaders()
      response.write('{"private":"must-not-appear-in-the-error"')
      // Send real headers and part of a body, then break the transport.
      setTimeout(() => response.destroy(), 25)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const instance = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    try {
      const answer = await call({ instance, token: 'synthetic-token' }, method, '/api/probe')
      expect(answer.ok).toBe(false)
      if (answer.ok) throw new Error('An incomplete response cannot succeed')
      expect(answer.status).toBe(0)
      expect(answer.code).toBe('response_interrupted')
      expect(answer.message).toContain(instance)
      expect(JSON.stringify(answer)).not.toContain('must-not-appear-in-the-error')
      expect(answer.fix).toContain(method === 'GET' ? 'Try the command again' : 'may already have been applied')
      expect(requests).toBe(1)
    }
    finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })
}

test('the machine client preserves API metadata and sends structured input through normal authentication', async () => {
  const seen: Array<{ path: string, method: string, auth: string | null, body: unknown }> = []
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    seen.push({ path: new URL(request.url).pathname + new URL(request.url).search, method: request.method, auth: request.headers.get('authorization'), body: request.method === 'GET' ? null : await request.json() })
    return Response.json({ workflow_runs: [{ number: 42, head_sha: 'a'.repeat(40), state: 'succeeded' }], next: null })
  } })
  const output: unknown[] = []
  const instance = `http://127.0.0.1:${server.port}`
  const original = process.env.REVIEWOS_TOKEN
  process.env.REVIEWOS_TOKEN = 'owned-fixture-token'
  try {
    expect(await apiCommand('/api/repos/workflow-runs?owner=stacks&repo=training', { instance, write: value => output.push(JSON.parse(value)) })).toBe(0)
    expect(output).toEqual([{ workflow_runs: [{ number: 42, head_sha: 'a'.repeat(40), state: 'succeeded' }], next: null }])
    expect(await apiCommand('/api/repos/workflows/dispatch', { instance, method: 'POST', body: { workflow: 'ci.yml', inputs: { upload: false } }, write: () => {} })).toBe(0)
    expect(seen).toEqual([
      { path: '/api/repos/workflow-runs?owner=stacks&repo=training', method: 'GET', auth: 'Bearer owned-fixture-token', body: null },
      { path: '/api/repos/workflows/dispatch', method: 'POST', auth: 'Bearer owned-fixture-token', body: { workflow: 'ci.yml', inputs: { upload: false } } },
    ])
    for (const path of ['https://outside.invalid/api/repos', '//outside.invalid/api/repos', '/api/../login', '/api/%2e%2e/login', '/api/repos#fragment'])
      expect(await apiCommand(path, { instance, write: () => {} })).toBe(1)
    expect(await apiCommand('/api/repos', { instance, method: 'GET', body: { upload: true }, write: () => {} })).toBe(1)
    expect(await apiCommand('/api/repos', { instance, method: 'TRACE', write: () => {} })).toBe(1)
    expect(seen).toHaveLength(2)
  }
  finally {
    if (original === undefined) delete process.env.REVIEWOS_TOKEN
    else process.env.REVIEWOS_TOKEN = original
    server.stop(true)
  }
})

test('API credentials stay on a canonical endpoint and cancelled requests do not start', async () => {
  const { call } = await import('../../app/Cli/api')
  let redirected = 0
  const target = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch() { redirected++; return Response.json({ ok: true }) } })
  const source = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch() { return Response.redirect(`http://127.0.0.1:${target.port}/api/capture`, 302) } })
  const connection = { instance: `http://127.0.0.1:${source.port}`, token: 'fixture-token' }
  try {
    expect((await call(connection, 'GET', '/api/redirect')).ok).toBe(false)
    expect(redirected).toBe(0)
    expect((await call(connection, 'GET', '/api/cancelled', { signal: AbortSignal.abort() })).ok).toBe(false)
    expect(redirected).toBe(0)
  }
  finally { source.stop(true); target.stop(true) }
})

test('structured API input is bounded and malformed JSON never exposes its contents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'reviewos-api-input-'))
  const file = join(directory, 'input.json')
  try {
    await writeFile(file, '{"upload":true}')
    expect(await readApiBody(file)).toEqual({ upload: true })
    await writeFile(file, 'private-malformed-value')
    await expect(readApiBody(file)).rejects.toThrow('API input must be valid JSON')
    await writeFile(file, ' '.repeat(1_048_577))
    await expect(readApiBody(file)).rejects.toThrow('exceeds 1 MiB')
  }
  finally { await rm(directory, { recursive: true, force: true }) }
})
