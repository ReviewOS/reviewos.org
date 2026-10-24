import { describe, expect, test } from 'bun:test'
import { discoverAccount } from '../../app/Actions/Mirror/account'
import { GitHubClient } from '../../app/Actions/Mirror/github-client'

describe('GitHub account discovery', () => {
  test('includes personal and active administered organizations, preserving private metadata', async () => {
    const fixtures: Record<string, any> = {
      '/user': { login: 'owner' },
      '/user/memberships/orgs': [
        { role: 'admin', state: 'active', organization: { login: 'Owned' } },
        { role: 'member', state: 'active', organization: { login: 'Client' } },
        { role: 'admin', state: 'pending', organization: { login: 'Pending' } },
      ],
      '/user/repos': [
        { name: 'personal', owner: { login: 'owner' }, private: true },
        { name: 'org', owner: { login: 'owned' }, private: false },
        { name: 'client', owner: { login: 'Client' } },
        { name: 'collaboration', owner: { login: 'stranger' } },
      ],
    }
    const client = new GitHubClient({ fetchImpl: (async (url: string) => Response.json(fixtures[new URL(url).pathname])) as typeof fetch })
    const found = await discoverAccount(client)
    expect(found.repositories.map(row => row.name)).toEqual(['personal', 'org'])
    expect(found.repositories[0].private).toBe(true)
    expect(found.organizations.map(row => row.login)).toEqual(['Owned'])
  })

  test('does not report success when a collection cannot be read', async () => {
    const client = new GitHubClient({ fetchImpl: (async (url: string) => new URL(url).pathname === '/user'
      ? Response.json({ login: 'owner' })
      : new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } })) as typeof fetch })
    await expect(discoverAccount(client)).rejects.toThrow('rate limited')
  })
})

describe('batched review discovery', () => {
  test('follows pull request cursors and preserves reviewer identity and commit', async () => {
    const cursors: Array<string | null> = []
    const client = new GitHubClient({ token: 'fixture', fetchImpl: (async (_url: string, options: any) => {
      const cursor = JSON.parse(options.body).variables.cursor
      cursors.push(cursor)
      return Response.json({ data: { repository: { pullRequests: {
        pageInfo: { hasNextPage: cursor === null, endCursor: 'second' },
        nodes: [{ number: cursor === null ? 1 : 2, reviews: { pageInfo: { hasNextPage: false }, nodes: [
          { databaseId: cursor === null ? 10 : 20, state: 'APPROVED', author: { login: 'reviewer' }, commit: { oid: 'a'.repeat(40) } },
        ] } }],
      } } } })
    }) as typeof fetch })
    const result = await client.repositoryReviews('owner', 'name')
    expect(result.ok).toBe(true)
    expect(cursors).toEqual([null, 'second'])
    expect(result.items.map(row => [row.pull_number, row.id, row.user.login, row.commit_id])).toEqual([
      [1, 10, 'reviewer', 'a'.repeat(40)], [2, 20, 'reviewer', 'a'.repeat(40)],
    ])
  })

  test('reports GraphQL errors instead of calling an empty result complete', async () => {
    const client = new GitHubClient({ token: 'fixture', fetchImpl: (async () => Response.json({ errors: [{ message: 'Rate limit exceeded' }] })) as typeof fetch })
    const result = await client.repositoryReviews('owner', 'name')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('Rate limit exceeded')
  })
})


test('public review discovery uses REST when no token is configured', async () => {
  const client = new GitHubClient({ fetchImpl: (async (url: string) => Response.json(new URL(url).pathname.endsWith('/reviews')
    ? [{ id: 12, state: 'APPROVED' }] : [{ number: 7 }])) as typeof fetch })
  const result = await client.repositoryReviews('owner', 'repository')
  expect(result.ok).toBe(true)
  expect(result.items).toEqual([{ id: 12, state: 'APPROVED', pull_number: 7 }])
})
