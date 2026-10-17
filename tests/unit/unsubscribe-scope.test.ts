import { expect, test } from 'bun:test'
import { describeScope, parseScope, scopeString } from '../../app/Actions/Notification/unsubscribe'

test('signed unsubscribe scopes keep their subject and readable confirmation', () => {
  const scopes = [
    { type: 'repository', label: 'this repository' },
    { type: 'organization', label: 'this organization' },
    { type: 'issue', label: 'this issue' },
    { type: 'pull_request', label: 'this pull request' },
  ] as const
  for (const { type, label } of scopes) {
    const scope = { type, id: 42 }
    expect(parseScope(scopeString(scope))).toEqual(scope)
    expect(describeScope(parseScope(scopeString(scope)))).toBe(label)
  }
  expect(describeScope(null)).toBe('these notifications')
})

test('invalid or imprecise scope identifiers cannot name a notification subject', () => {
  for (const value of [null, undefined, '', 'issue', 'issue:', 'issue:0', 'issue:-1', 'issue:1.5', 'issue:Infinity', 'issue:9007199254740993', 'constructor:42', '__proto__:42', 'user:42'])
    expect(parseScope(value)).toBeNull()
})
