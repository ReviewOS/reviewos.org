import { describe, expect, test } from 'bun:test'
import { GitHubClient } from '../../app/Actions/Mirror/github-client'
import { metadataSince } from '../../app/Actions/Mirror/metadata'

describe('metadata checkpoints', () => {
  const now = Date.parse('2026-10-24T12:00:00Z')
  test('requires a completed, valid checkpoint and overlaps timestamp boundaries', () => {
    for (const value of [null, undefined, '', 'invalid', '2026-10-25T00:00:00Z'])
      expect(metadataSince(value, now)).toBeUndefined()
    expect(metadataSince('2026-10-24T11:00:00Z', now)).toBe('2026-10-24T10:59:00.000Z')
    expect(metadataSince(new Date('2026-10-24T11:00:00Z'), now)).toBe('2026-10-24T10:59:00.000Z')
  })
})

describe('incremental GitHub requests', () => {
  test('paginates complete authenticated issue listings without scanning pull requests', async () => {
    const cursors: unknown[] = []
    const client = new GitHubClient({ token: 'fixture', fetchImpl: (async (input, options) => {
      expect(String(input)).toBe('https://api.github.com/graphql')
      const request = JSON.parse(String(options?.body))
      cursors.push(request.variables.cursor)
      expect(request.variables.since).toBeNull()
      const next = request.variables.cursor === null
      return Response.json({ data: { repository: { issues: { pageInfo: { hasNextPage: next, endCursor: next ? 'next' : null }, nodes: [{ number: next ? 707 : 708, title: 'Dependency Dashboard', state: 'OPEN', author: { login: 'renovate' }, labels: { nodes: [] } }] } } } })
    }) as typeof fetch })
    const result = await client.issues('owner', 'project')
    expect(result.ok).toBe(true)
    expect(result.items.map(row => row.number)).toEqual([707, 708])
    expect(result.items[0].state).toBe('open')
    expect(cursors).toEqual([null, 'next'])
  })

  test('merges changed GraphQL issues with the REST pull request feed without duplicates', async () => {
    const since = '2026-10-24T10:59:00.000Z'
    const client = new GitHubClient({ token: 'fixture', fetchImpl: (async (input, options) => {
      const url = new URL(String(input))
      if (url.pathname === '/graphql') {
        expect(JSON.parse(String(options?.body)).variables.since).toBe(since)
        return Response.json({ data: { repository: { issues: { pageInfo: { hasNextPage: false }, nodes: [{ number: 707, title: 'Current', state: 'OPEN' }, { number: 708, title: 'Omitted by REST', state: 'CLOSED' }] } } } })
      }
      expect(url.searchParams.get('since')).toBe(since)
      return Response.json([{ number: 707, title: 'Older' }, { number: 9, pull_request: {} }])
    }) as typeof fetch })
    const result = await client.issues('owner', 'project', since)
    expect(result.ok).toBe(true)
    expect(result.items.map(row => row.number).sort((a, b) => a - b)).toEqual([9, 707, 708])
    expect(result.items.find(row => row.number === 707).title).toBe('Current')
    expect(result.items.filter(row => row.pull_request).map(row => row.number)).toEqual([9])
  })

  test('retains earlier GraphQL pages while reporting a later failure', async () => {
    let calls = 0
    const client = new GitHubClient({ token: 'fixture', fetchImpl: (async () => ++calls === 1
      ? Response.json({ data: { repository: { issues: { pageInfo: { hasNextPage: true, endCursor: 'next' }, nodes: [{ number: 707, state: 'OPEN' }] } } } })
      : Response.json({ errors: [{ message: 'rate limit reached' }] })) as typeof fetch })
    const result = await client.issues('owner', 'project')
    expect(result.ok).toBe(false)
    expect(result.items.map(row => row.number)).toEqual([707])
    expect(result.error).toContain('rate limit reached')
  })

  test('uses the changed issue feed and fetches only the named pull requests', async () => {
    const urls: URL[] = []
    const since = '2026-10-24T10:59:00.000Z'
    const client = new GitHubClient({ fetchImpl: (async (input) => {
      const url = new URL(String(input)); urls.push(url)
      if (url.pathname.endsWith('/issues')) return Response.json([{ number: 2 }, { number: 9, pull_request: {} }])
      if (url.pathname.endsWith('/pulls/9')) return Response.json({ number: 9, state: 'closed', merged_at: '2026-10-24T11:30:00Z' })
      if (url.pathname.endsWith('/issues/comments')) return Response.json([{ id: 40, body: 'edited' }])
      throw Error(`Unexpected request: ${url.pathname}`)
    }) as typeof fetch })
    const changed = await client.issues('owner', 'project', since)
    const pulls = await client.pullDetails('owner', 'project', changed.items.filter(row => row.pull_request).map(row => row.number))
    const comments = await client.issueComments('owner', 'project', since)
    expect(pulls.ok).toBe(true)
    expect(pulls.items[0]?.merged_at).toBe('2026-10-24T11:30:00Z')
    expect(comments.items[0]?.body).toBe('edited')
    expect(urls.map(url => url.pathname)).toEqual(['/repos/owner/project/issues', '/repos/owner/project/pulls/9', '/repos/owner/project/issues/comments'])
    expect(urls[0]?.searchParams.get('since')).toBe(since)
    expect(urls[2]?.searchParams.get('since')).toBe(since)
    expect((await client.pullDetails('owner', 'project', [])).items).toEqual([])
    expect(urls).toHaveLength(3)
  })

  test('keeps a partial result failed when a later pull request cannot be read', async () => {
    const client = new GitHubClient({ fetchImpl: (async (input) => String(input).endsWith('/1')
      ? Response.json({ number: 1 })
      : new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })) as typeof fetch })
    const result = await client.pullDetails('owner', 'project', [1, 1, 2])
    expect(result.ok).toBe(false)
    expect(result.items.map(row => row.number)).toEqual([1])
    expect(result.error).toContain('rate limited')
  })

  test('rejects a mismatched detail response and preserves the full first-pass endpoints', async () => {
    const paths: string[] = []
    const client = new GitHubClient({ fetchImpl: (async (input) => {
      paths.push(String(input))
      return String(input).endsWith('/8') ? Response.json({ number: 7 }) : Response.json([])
    }) as typeof fetch })
    expect((await client.pullDetails('owner', 'project', [8])).ok).toBe(false)
    await client.issues('owner', 'project')
    await client.pulls('owner', 'project')
    expect(paths[1]).not.toContain('since=')
    expect(paths[2]).toContain('/pulls?state=all')
  })
})
