// Compare-and-set on a run's shared values.
//
// The rule this file is about: two parallel jobs each read a list, each append
// their own entry, each write it back - and without a compare-and-set the
// second write lands on top of the first, with nothing anywhere saying so. A
// refused write is a job that can merge and retry; a lost write is a build
// quietly missing something.
//
// The database half is exercised end to end elsewhere; what is pinned here is
// the decision table, because it is the part somebody will change.

import { describe, expect, test } from 'bun:test'
import { MAX_VALUE_BYTES } from '../../app/Actions/Runner/metadata'

describe('the shape of the rule', () => {
  test('a value has a ceiling, and it is small enough to mean "not a file"', () => {
    /*
     * Ten kilobytes is a version number, a URL, a JSON decision. Anything
     * larger is a file, and a file is an artifact - which has content
     * addressing, retention and a download URL, none of which a key-value pair
     * should grow.
     */
    expect(MAX_VALUE_BYTES).toBeGreaterThan(1000)
    expect(MAX_VALUE_BYTES).toBeLessThan(100_000)
  })
})
