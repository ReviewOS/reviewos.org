// What the API says it answers with, checked against itself.
//
// The generator derives an operation's inputs from `validations` - the same
// object the validator uses, so they cannot drift. Responses are different:
// they are prose an author wrote, and prose is exactly what goes stale. This
// file holds the two rules that can be checked without calling anything.
//
// The third rule - that a documented shape matches the real one - cannot be
// checked here, because it needs a request. It lives in
// `tests/e2e/checks-api.test.ts`, where there is one to make.

import { describe, expect, test } from 'bun:test'
import { RATE_LIMIT_HEADERS } from '../../app/Api/documented'
import CancelWorkflowRun from '../../app/Actions/Workflow/CancelWorkflowRunAction'
import ListWorkflowRuns from '../../app/Actions/Workflow/ListWorkflowRunsAction'
import ReportCheck from '../../app/Actions/Checks/ReportCheckAction'
import ShowChecks from '../../app/Actions/Checks/ShowChecksAction'
import ShowJobLog from '../../app/Actions/Workflow/ShowJobLogAction'
import ShowWorkflowRun from '../../app/Actions/Workflow/ShowWorkflowRunAction'

const DOCUMENTED = [
  { name: 'ShowChecks', action: ShowChecks as any },
  { name: 'ReportCheck', action: ReportCheck as any },
  { name: 'ListWorkflowRuns', action: ListWorkflowRuns as any },
  { name: 'ShowWorkflowRun', action: ShowWorkflowRun as any },
  { name: 'ShowJobLog', action: ShowJobLog as any },
  { name: 'CancelWorkflowRun', action: CancelWorkflowRun as any },
]

describe('the endpoints that document their answers', () => {
  test('say something for every status they list', () => {
    // A status with no sentence beside it is one the generator drops, so an
    // author who wrote a schema and forgot the description would find their
    // careful shape silently absent from the document.
    const empty: string[] = []

    for (const { name, action } of DOCUMENTED) {
      for (const [status, answer] of Object.entries(action.responses ?? {})) {
        const described = (answer as { description?: unknown }).description

        if (typeof described !== 'string' || described.trim().length < 10)
          empty.push(`${name} ${status}`)
      }
    }

    expect(empty).toEqual([])
  })

  /*
   * The failure this catches is the one a client meets first. A repository this
   * caller may not see answers 404 - never 403, which would confirm it exists -
   * and a generated client with no branch for it treats a private repository as
   * a network error.
   */
  test('and every repository endpoint documents the answer a stranger gets', () => {
    const missing: string[] = []

    for (const { name, action } of DOCUMENTED) {
      const statuses = Object.keys(action.responses ?? {})

      if (!statuses.includes('404'))
        missing.push(`${name} has no 404`)

      if (!statuses.includes('401'))
        missing.push(`${name} has no 401`)
    }

    expect(missing).toEqual([])
  })

  /*
   * Documenting a header the API does not send is worse than documenting
   * nothing: a client written against it reads `undefined` and treats it as
   * zero, which for a rate limit means backing off when it need not - or, the
   * other way round, not backing off when it must.
   */
  test('the rate-limit headers they advertise are the ones the middleware sends', async () => {
    const { headers } = await import('../../app/Api/rate-limit')

    const sent = Object.keys(headers({ max: 60, windowSeconds: 60 } as any, {
      allowed: true,
      remaining: 59,
      resetAtSeconds: 0,
      retryAfterSeconds: 0,
    } as any))

    expect(sent.sort()).toEqual(Object.keys(RATE_LIMIT_HEADERS).sort())
  })

  test('and every documented endpoint advertises them', () => {
    // They are on every response from the throttled surface, so an endpoint
    // that documents its body and not its budget has documented half of what a
    // client has to handle.
    for (const { name, action } of DOCUMENTED)
      expect({ name, headers: Object.keys(action.responseHeaders ?? {}).length }).toEqual({ name, headers: 3 })
  })
})
