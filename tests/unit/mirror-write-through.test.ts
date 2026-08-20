// Writing a review back to the forge it was mirrored from.
//
// The rule phase 13 wrote down is the one worth a test: *never write back with
// a shared or admin credential*. It is a rule about attribution rather than
// about secrets - a bot posting "on behalf of chris" drops the reviewer out of
// GitHub's own notifications, review-request accounting and protection counts,
// and leaves the author replying to a machine.
//
// So the interesting assertions here are about what happens when a reviewer has
// no credential: the review stays local, the caller is told why, and the mirror
// token that is sitting right there in the same module is not reached for.

import { describe, expect, test } from 'bun:test'
import {
  hostOf,
  mayWriteReviews,
  REVIEW_SCOPES,
  upstreamReviewEvent,
} from '../../app/Actions/Mirror/writeThrough'

describe('the host a credential is looked up by', () => {
  test('reads an https remote', () => {
    expect(hostOf('https://github.com/acme/widgets.git')).toBe('github.com')
  })

  test('reads the scp form git uses, which no URL parser accepts', () => {
    // Half the mirrors in the wild carry `git@host:owner/name.git`, and parsing
    // it as a URL throws - which would have sent every one of them to the
    // default host, and a token to a server it was not issued for.
    expect(hostOf('git@github.example.com:acme/widgets.git')).toBe('github.example.com')
  })

  test('keeps an enterprise host separate from the public one', () => {
    // The whole point of storing the host: a credential for a company's own
    // GitHub is not a credential for github.com, and trying it there discloses
    // it to a party it was never issued to.
    expect(hostOf('https://github.example.com/acme/widgets')).not.toBe('github.com')
  })

  test('falls back rather than throwing on something unparseable', () => {
    expect(hostOf('not a url at all')).toBe('github.com')
  })
})

describe('whether a credential may write a review', () => {
  test('a classic token needs one of the review scopes', () => {
    expect(mayWriteReviews({ id: 1, token: 't', login: null, scopes: ['read:user'] })).toBe(false)
    expect(mayWriteReviews({ id: 1, token: 't', login: null, scopes: ['repo'] })).toBe(true)
    expect(mayWriteReviews({ id: 1, token: 't', login: null, scopes: ['public_repo'] })).toBe(true)
  })

  test('a fine-grained token reports no scopes and is asked rather than guessed at', () => {
    // Fine-grained tokens carry their permissions out of band, so an empty list
    // means "unknown", not "none". Refusing them here would refuse the kind of
    // token the forge itself recommends.
    expect(mayWriteReviews({ id: 1, token: 't', login: null, scopes: [] })).toBe(true)
  })

  test('the scopes it accepts are the two GitHub actually issues', () => {
    expect([...REVIEW_SCOPES].sort()).toEqual(['public_repo', 'repo'])
  })
})

describe('the verdict, in the words upstream uses', () => {
  test('maps each state', () => {
    expect(upstreamReviewEvent('approved')).toBe('APPROVE')
    expect(upstreamReviewEvent('changes_requested')).toBe('REQUEST_CHANGES')
    expect(upstreamReviewEvent('commented')).toBe('COMMENT')
  })

  test('an unknown state comments rather than approving', () => {
    // The failure direction matters: guessing APPROVE would post an approval
    // somebody never wrote, and on a protected branch that is a merge they did
    // not authorise.
    expect(upstreamReviewEvent('something-new')).toBe('COMMENT')
  })
})

describe('the rule itself', () => {
  test('no path from a review to the mirror credential', async () => {
    // Read rather than exercised, because what is being asserted is an absence:
    // the mirror token resolver is one import away and must stay unreached.
    // A test that posts a review with no credential proves the branch works
    // today; this proves nobody wired a fallback in tomorrow.
    const source = await Bun.file(new URL('../../app/Actions/Mirror/writeThrough.ts', import.meta.url)).text()
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

    // The resolver that opens a mirror's shared token, and the environment it
    // reads from. Neither may appear in the code that posts as a person.
    expect(code).not.toContain('mirrorToken')
    expect(code).not.toContain('./credentials')
    expect(code).not.toContain('GITHUB_TOKEN')
    expect(code).not.toContain('process.env')

    // And the refusal is a value the caller has to handle, not a silent skip.
    expect(code).toContain("reason: 'no-credential'")
  })
})

describe('posting, against a fixture forge', () => {
  /** A GitHub that answers the reviews endpoint, and records what it was sent. */
  function forge(answer: { status: number, body: unknown }) {
    const seen: Array<{ url: string, method: string, authorization: string | null, body: any }> = []

    const fetchImpl = (async (url: any, init: any) => {
      seen.push({
        url: String(url),
        method: String(init?.method ?? 'GET'),
        authorization: new Headers(init?.headers).get('authorization'),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      })

      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      })
    }) as unknown as typeof fetch

    return { fetchImpl, seen }
  }

  test('sends the reviewer’s own token, the event, and the head it was written against', async () => {
    const { GitHubClient } = await import('../../app/Actions/Mirror/github-client')
    const { fetchImpl, seen } = forge({ status: 200, body: { id: 42, state: 'APPROVED', html_url: 'https://example/r/42' } })

    const client = new GitHubClient({ token: 'the-reviewers-own-token', fetchImpl, baseUrl: 'https://api.example' })

    const result = await client.postReview({
      owner: 'acme',
      name: 'widgets',
      number: 7,
      event: 'APPROVE',
      body: 'looks right',
      commitId: 'abc123',
      comments: [{ path: 'src/a.ts', line: 12, side: 'left', body: 'here' }],
    })

    expect(result.ok).toBe(true)
    expect(seen[0]?.url).toBe('https://api.example/repos/acme/widgets/pulls/7/reviews')
    expect(seen[0]?.method).toBe('POST')
    expect(seen[0]?.authorization).toBe('Bearer the-reviewers-own-token')
    expect(seen[0]?.body.event).toBe('APPROVE')
    // Anchored: without `commit_id` GitHub attaches the review to whatever is
    // current, so a verdict on one commit arrives labelled as one on the next.
    expect(seen[0]?.body.commit_id).toBe('abc123')
    expect(seen[0]?.body.comments[0].side).toBe('LEFT')
  })

  test('a refusal comes back with what upstream said, rather than throwing', async () => {
    // The review is already saved locally when this runs. An exception here
    // would lose the reason the reviewer needs and change nothing else.
    const { GitHubClient } = await import('../../app/Actions/Mirror/github-client')
    const { fetchImpl } = forge({ status: 422, body: { message: 'Can not approve your own pull request' } })

    const client = new GitHubClient({ token: 't', fetchImpl, baseUrl: 'https://api.example' })
    const result = await client.postReview({ owner: 'acme', name: 'widgets', number: 7, event: 'APPROVE', body: '' })

    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ status: 422, message: 'Can not approve your own pull request' })
  })
})

describe('connecting a credential', () => {
  test('the API base is derived from the host, never taken from the request', async () => {
    // The endpoint calls the forge to verify a token before storing it. If the
    // caller could name that URL, they could have this instance post their
    // token - or anybody's - to a server of their choosing, which is a
    // credential exfiltration primitive dressed as a convenience.
    const source = await Bun.file(new URL('../../app/Actions/Mirror/ForgeCredentialAction.ts', import.meta.url)).text()
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

    expect(code).toContain('const baseUrl = host === ')
    expect(code).not.toContain("request.get('baseUrl')")
    expect(code).not.toContain("request.get('url')")
    // And the host itself is constrained, so it cannot carry a path or a port
    // that would move where the request lands.
    expect(code).toContain('/^[a-z0-9.-]+$/.test(host)')
  })

  test('no path stores a credential for somebody else', async () => {
    const source = await Bun.file(new URL('../../app/Actions/Mirror/ForgeCredentialAction.ts', import.meta.url)).text()
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

    // Every statement keys on the signed-in user. An admin path to add one for
    // a person would defeat the attribution the whole feature exists for.
    expect(code).not.toContain("request.get('user_id')")
    expect(code).not.toContain("request.get('userId')")
    expect((code.match(/user_id/g) ?? []).length).toBeGreaterThan(2)
  })

  test('the token is never in a response', async () => {
    const source = await Bun.file(new URL('../../app/Actions/Mirror/ForgeCredentialAction.ts', import.meta.url)).text()

    // `sealed` is selected nowhere in the list, and the connect answer returns
    // the login rather than what was sent.
    expect(source).not.toMatch(/select\(\[[^\]]*'sealed'/)
    expect(source).not.toContain('token,\n      })')
  })
})
