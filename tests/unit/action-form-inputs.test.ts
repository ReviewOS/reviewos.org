// The body the interface posts, checked against the rules the endpoint declares.
//
// An action's `validations` block runs *before* its handler, so a rule that
// does not match what the form sends is a 422 the handler never gets to answer
// - and the reader, whose form posted straight to the API endpoint, lands on a
// page of raw JSON with no way back to what they had typed.
//
// "Issue a token" shipped that way. `repository_ids` was declared
// `schema.array()`; the settings form posts the chosen repositories as a
// comma-joined hidden field, because a repeated field name arrives as a string
// for one occurrence and an array for two and a settings page should not be
// betting on which. So the declared rule refused every scoped token the page
// could issue - one repository or six - with
// `{"repository_ids":["Must be an array"]}`, and the feature did not work at
// all. The new-issue form's label checkboxes failed the same way on exactly one
// tick.
//
// Nothing caught it because nothing exercised a declared rule. `tests/e2e`
// drives `action.handle(...)` directly, which is the right way to test what the
// rows mean and skips validation entirely; `tests/unit/action-inputs.test.ts`
// reads the source and cannot know what a form sends. So: the real payloads,
// through the real validator, per form-backed endpoint. A rule that drifts from
// its form fails here.
//
// **Numbers are the one thing to keep out of these payloads.** The router
// coerces a form's string to a number or a boolean before validation when the
// rule asks for one, and this calls the validator directly, so `schema.number()`
// on a field written here as `'41'` would fail a test about a field that works
// in a browser. It coerces nothing into an array, which is the whole reason the
// list fields below are worth pinning: there is no layer that was going to
// rescue them.

import { describe, expect, test } from 'bun:test'
import { validate } from '@stacksjs/validation'

/**
 * Validate a body the way the router does, and report what was wrong with it.
 *
 * Empty means accepted. A refusal reports per-field messages where the error
 * carries them and its own message where it does not - a missing `required`
 * field throws without the `errors` bag that a wrong *type* comes with, and
 * reading only the bag reported "nothing wrong" for the one case these tests
 * use to prove the rules are still being enforced at all.
 */
async function check(validations: unknown, body: Record<string, unknown>): Promise<string[]> {
  try {
    await validate(body, validations as any, { source: 'data' })

    return []
  }
  catch (error: any) {
    const errors = (error?.data?.errors ?? {}) as Record<string, string[]>
    const fields = Object.entries(errors).map(([field, messages]) => `${field}: ${messages.join('; ')}`).sort()

    return fields.length > 0 ? fields : [String(error?.message ?? 'refused')]
  }
}

/**
 * What `resources/views/settings/tokens.stx` posts.
 *
 * One field per scope rather than a `permissions` array, and `repository_ids`
 * comma-joined by the hidden input - both as that form writes them, so this
 * breaks when the form and the rules stop agreeing.
 */
function tokenForm(repositoryIds: string): Record<string, unknown> {
  return {
    name: 'release job, GitHub Actions',
    selection: 'selected',
    scope_actions: 'write',
    scope_actions_logs: 'read',
    scope_checks: 'read',
    scope_contents: 'none',
    repository_ids: repositoryIds,
    expires_at: '2027-01-01',
  }
}

describe('issuing a token accepts what the settings form posts', () => {
  test('one repository, which is the shape that was refused', async () => {
    const action: any = (await import('../../app/Actions/Tokens/CreateTokenAction')).default

    expect(await check(action.validations, tokenForm('5'))).toEqual([])
  })

  test('several repositories, refused for the same reason', async () => {
    const action: any = (await import('../../app/Actions/Tokens/CreateTokenAction')).default

    expect(await check(action.validations, tokenForm('5,7,11'))).toEqual([])
  })

  test('none chosen, which the handler refuses with a sentence of its own', async () => {
    const action: any = (await import('../../app/Actions/Tokens/CreateTokenAction')).default

    // The hidden field is always posted, empty when nothing is selected. It has
    // to pass validation so that `Choose at least one repository you can reach`
    // is what the reader gets, rather than `Must be an array`.
    expect(await check(action.validations, tokenForm(''))).toEqual([])
  })

  test('and a JSON client still sends an array', async () => {
    const action: any = (await import('../../app/Actions/Tokens/CreateTokenAction')).default

    expect(await check(action.validations, {
      name: 'from a script',
      selection: 'selected',
      permissions: [{ scope: 'contents', level: 'read' }],
      repository_ids: [5, 7],
    })).toEqual([])
  })

  test('a token still needs a name, so the rules are really being read', async () => {
    const action: any = (await import('../../app/Actions/Tokens/CreateTokenAction')).default

    const body = tokenForm('5')
    delete body.name

    // Guards the three tests above: a `validations` block that had stopped
    // being enforced would pass all of them and mean nothing.
    expect(await check(action.validations, body)).not.toEqual([])
  })
})

describe('opening an issue accepts what the new-issue form posts', () => {
  /** What `resources/views/[owner]/[repository]/issues/new.stx` posts. */
  function issueForm(labels: unknown): Record<string, unknown> {
    return { owner: 'stacks', repository: 'reviewos', title: 'The form posts this', body: 'and this', labels }
  }

  test('one label ticked, which arrives as a bare string', async () => {
    const action: any = (await import('../../app/Actions/Issue/CreateIssueAction')).default

    expect(await check(action.validations, issueForm('bug'))).toEqual([])
  })

  test('two ticked, which the router surfaces as an array', async () => {
    const action: any = (await import('../../app/Actions/Issue/CreateIssueAction')).default

    expect(await check(action.validations, issueForm(['bug', 'documentation']))).toEqual([])
  })

  test('none ticked, which sends the field at all', async () => {
    const action: any = (await import('../../app/Actions/Issue/CreateIssueAction')).default

    const body = issueForm(undefined)
    delete body.labels

    expect(await check(action.validations, body)).toEqual([])
  })
})
