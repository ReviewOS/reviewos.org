// GitLab, translated.
//
// Gitea needed four parameters because it answers GitHub's API deliberately.
// GitLab is a different vocabulary for the same ideas, and every translation
// below is a place an importer can be confidently wrong and lose data while
// reporting success.
//
// The one that would do the most damage is `iid`. Every GitLab object has both
// `id` and `iid`: `id` is unique across the instance, `iid` is the number in
// the URL and in `#123`. Reading `id` gives a repository whose issues are
// numbered 4,318 and 4,319 where the highest was 12 - and every cross reference
// in its own history breaks quietly, because the numbers are still plausible.

import { describe, expect, test } from 'bun:test'
import {
  asIssue,
  asIssueComment,
  asPullRequest,
  asRelease,
  asReviewComment,
  author,
  issueState,
  mergeRequestState,
  projectPath,
} from '../../app/Actions/Import/gitlab'

describe('the number that matters', () => {
  test('an issue is numbered by iid, not id', () => {
    expect(asIssue({ iid: 12, id: 4318, title: 'x' }).number).toBe(12)
  })

  test('and so is a merge request', () => {
    expect(asPullRequest({ iid: 4, id: 9001, title: 'x' }).number).toBe(4)
  })
})

describe('state', () => {
  test('GitLab says opened where everything else says open', () => {
    expect(issueState('opened')).toBe('open')
    expect(issueState('closed')).toBe('closed')
  })

  test('a merged merge request is merged, not merely closed', () => {
    /*
     * `merged` is a state in GitLab and a timestamp in GitHub. Recording it as
     * closed loses the fact that the work landed, which is the single thing
     * anybody opens a closed pull request to find out.
     */
    expect(mergeRequestState({ state: 'merged', merged_at: '2026-01-01T00:00:00Z' }))
      .toEqual({ state: 'merged', mergedAt: '2026-01-01T00:00:00Z' })

    expect(mergeRequestState({ state: 'closed' })).toEqual({ state: 'closed', mergedAt: null })
    expect(mergeRequestState({ state: 'opened' })).toEqual({ state: 'open', mergedAt: null })
  })
})

describe('who wrote it', () => {
  test('is author.username, not user.login', () => {
    expect(author({ author: { username: 'alice', name: 'Alice' } })?.login).toBe('alice')
  })

  test('and an object with neither maps nobody', () => {
    // Rather than an empty-string login, which would match an account whose
    // handle is somehow empty and attribute a stranger's words to them.
    expect(author({})).toBeNull()
    expect(author({ author: {} })).toBeNull()
  })
})

describe('review comments, which live in a position', () => {
  test('a comment on an added line reads new_line and the right side', () => {
    const mapped = asReviewComment({
      id: 1,
      body: 'x',
      position: { new_path: 'src/cart.ts', new_line: 42, old_line: null },
    }, 7)

    expect(mapped).toMatchObject({ path: 'src/cart.ts', line: 42, side: 'RIGHT' })
  })

  test('a comment on a deleted line reads old_line and the left side', () => {
    /*
     * The one that produces an anchorless comment. A deleted line has only
     * `old_line`, and reading `new_line` there gives null - which is exactly
     * the loss this importer exists to prevent.
     */
    const mapped = asReviewComment({
      id: 2,
      body: 'x',
      position: { old_path: 'src/cart.ts', new_line: null, old_line: 17 },
    }, 7)

    expect(mapped).toMatchObject({ path: 'src/cart.ts', line: 17, side: 'LEFT' })
  })

  test('a note with no position is not a review comment', () => {
    // It is an ordinary comment on the merge request. Filing it as a review
    // comment would put a general remark on an arbitrary line of an arbitrary
    // file.
    expect(asReviewComment({ id: 3, body: 'looks good' }, 7)).toBeNull()
  })

  test('and it carries the merge request it belongs to', () => {
    const mapped = asReviewComment({ id: 4, body: 'x', position: { new_path: 'a', new_line: 1 } }, 7)

    expect(mapped?.pull_request_url).toBe('/pulls/7')
  })
})

describe('issue comments', () => {
  test('a system note is dropped', () => {
    /*
     * GitLab records "changed the milestone" and "mentioned in commit abc" as
     * notes. Imported, they bury every real comment under machine chatter that
     * reads, in this product, as though a person wrote it.
     */
    expect(asIssueComment({ id: 1, body: 'changed milestone to v2', system: true }, 7)).toBeNull()
  })

  test('a real one keeps its subject', () => {
    expect(asIssueComment({ id: 2, body: 'I can reproduce this' }, 7))
      .toMatchObject({ issue_url: '/issues/7', body: 'I can reproduce this' })
  })
})

describe('releases', () => {
  test('assets are links, because that is what GitLab releases have', () => {
    // A GitLab release links to a package registry or a CI artefact; there is
    // no file attached to the release itself.
    const mapped = asRelease({
      tag_name: 'v1',
      description: 'notes',
      assets: { links: [{ name: 'binary', direct_asset_url: 'https://example.invalid/binary' }] },
    })

    expect(mapped.tag_name).toBe('v1')
    expect((mapped.assets as any[])[0]).toMatchObject({ name: 'binary', browser_download_url: 'https://example.invalid/binary' })
  })
})

describe('addressing a project', () => {
  test('the whole path is one encoded segment', () => {
    /*
     * `/projects/acme/api` is a different endpoint and answers 404 - the same
     * shape of failure as everything else here: it looks like the repository
     * does not exist.
     */
    expect(projectPath('acme', 'api')).toBe('acme%2Fapi')
  })

  test('including a subgroup, which has more than one slash', () => {
    expect(projectPath('acme/platform', 'api')).toBe('acme%2Fplatform%2Fapi')
  })
})
