// An endpoint accepts what its handler reads, not one spelling of it.
//
// An action's `validations` block is **enforced**: the framework checks every
// declared rule before the handler runs and answers 422 with its own message.
// So `schema.string()` on a field the handler passes through `Number(...)` is a
// contract that refuses the obvious JSON call - `{"organization_id": 41}` came
// back `Organization id Must be a string` - while the browser form, which sends
// every field as a string, worked perfectly.
//
// Forty fields across thirty actions were declared that way: organization ids,
// comment ids, team ids, review ids, approval counts, and every merge-settings
// flag. The interface never noticed, because the interface posts forms. The
// end-to-end suite noticed, and had been red on twenty-two tests across six
// unrelated features - invitations, machine accounts, protected branches, the
// people page, organization deletion, the audit log - for this one reason.
//
// The rule to write for a coerced field is `coerced` from `app/Actions/inputs.ts`.
// What the value has to *be* is then checked where it is used, which is where
// the error is worth reading.
//
// `schema.array()` is the same mistake in the other direction, and it shipped a
// worse bug: a browser cannot post an array. A repeated field name reaches the
// server as a string for one occurrence and an array for two, and a form that
// joins the list itself sends `3,7`. "Issue a token" declared an array for
// `repository_ids`, which the settings form posts comma-joined - so the page
// could not issue a scoped token at all, one repository or six, and answered
// `{"repository_ids":["Must be an array"]}` onto a blank page of JSON. Ticking
// exactly one label on the new-issue form failed the same way.
//
// The rule for a field the handler reads as a list is `list`, from the same
// file. That half is not scanned here: which helper reads which field is not
// something a regex over the file can tell, and the scan that tried read
// `readRepositoryIds`'s `split(',')` as evidence about `permissions`.
// `tests/unit/action-form-inputs.test.ts` checks it the other way instead, by
// validating the body each form actually posts against the rules the action
// declares.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ACTIONS = join(import.meta.dir, '../../app/Actions')

/** Every action file, recursively. */
function actionFiles(dir = ACTIONS, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)

    if (statSync(path).isDirectory())
      actionFiles(path, found)
    else if (entry.endsWith('.ts'))
      found.push(path)
  }

  return found
}

/**
 * The fields an action declares as a string while its handler coerces them.
 *
 * Read out of the source rather than by importing: an action pulls in the
 * database, the router and half the application, and this question is about
 * what the file says.
 */
function overTypedFields(source: string): string[] {
  const block = /validations:\s*\{([\s\S]*?)\n\s{2}\},/.exec(source)

  if (!block)
    return []

  const wrong: string[] = []

  for (const [, field] of block[1].matchAll(/^\s*(\w+):\s*\{\s*rule:\s*schema\.string\(\)/gm)) {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

    // `Number(request.get('x'))` and `Number(patch.x)` - the two shapes this
    // codebase writes - and the truthiness helpers a flag goes through.
    const numeric = new RegExp(`Number\\(\\s*(?:await\\s+)?request\\.get\\(['"\`]${escaped}['"\`]`).test(source)
      || new RegExp(`Number\\(\\s*\\w+\\.${escaped}\\b`).test(source)

    const flagged = new RegExp(`(?:readFlag|truthy|isTruthy|boolish)\\(\\s*(?:await\\s+)?request\\.get\\(['"\`]${escaped}['"\`]`).test(source)

    if (numeric || flagged)
      wrong.push(field)
  }

  return wrong
}

describe('an action accepts what its handler reads', () => {
  test('declares no coerced field as a string', () => {
    const wrong: string[] = []

    for (const file of actionFiles()) {
      const fields = overTypedFields(readFileSync(file, 'utf8'))

      if (fields.length > 0)
        wrong.push(`${file.slice(file.indexOf('app/Actions'))}: ${fields.sort().join(', ')}`)
    }

    // Named rather than counted, because the fix is per field and the name is
    // the whole instruction: use `coerced` from `app/Actions/inputs.ts`.
    expect(wrong.sort()).toEqual([])
  })

  test('and there are actions to check, so a pass means something', () => {
    // This whole file is a scan, and a scan over nothing passes loudly.
    const withValidations = actionFiles()
      .filter(file => /validations:\s*\{/.test(readFileSync(file, 'utf8')))

    expect(withValidations.length).toBeGreaterThan(50)
  })
})
