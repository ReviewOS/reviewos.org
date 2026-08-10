// Turning a user-agent string into something a person recognises.
//
// This is the part of the session list that decides whether it works. The list
// exists so somebody can answer "is anybody else signed in as me", and they
// answer it by *reading the rows* - so a row that says
// `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML,
// like Gecko) Chrome/120.0.0.0 Safari/537.36` answers nothing, and one that
// says "Chrome on macOS" answers it at a glance.
//
// Every browser lies about being every other browser, which is why the order of
// these checks is load-bearing rather than stylistic.

import { describe, expect, test } from 'bun:test'
import { describeAgent } from '../../app/Actions/Auth/sessions'

describe('describing a device', () => {
  test('Chrome on macOS', () => {
    expect(describeAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    )).toBe('Chrome on macOS')
  })

  test('Safari on macOS is not reported as Chrome', () => {
    // Safari's string has no `Chrome/`, but Chrome's has `Safari/` - so a check
    // in the wrong order calls every Chrome a Safari, or worse, calls Safari
    // whatever it matched first.
    expect(describeAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
    )).toBe('Safari on macOS')
  })

  test('Edge is not reported as Chrome', () => {
    // Edge's string ends `Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0`, so it
    // matches both of the others. It has to be checked first.
    expect(describeAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
    )).toBe('Edge on Windows')
  })

  test('Opera is not reported as Chrome either', () => {
    expect(describeAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 OPR/105.0.0.0',
    )).toBe('Opera on Windows')
  })

  test('Firefox on Linux', () => {
    expect(describeAgent('Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0'))
      .toBe('Firefox on Linux')
  })

  test('an iPhone is an iPhone, not macOS', () => {
    // iOS strings contain `like Mac OS X`, so a naive platform check reports
    // every phone as a laptop - and "Safari on macOS" when you are looking for
    // your phone is exactly the wrong answer.
    expect(describeAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
    )).toBe('Safari on iPhone')
  })

  test('an Android phone', () => {
    expect(describeAgent(
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    )).toBe('Chrome on Android')
  })

  test('a command-line client is named rather than called unknown', () => {
    // A session held by `curl` or `git` is exactly the row somebody is scanning
    // for, and "Unknown device" is the label that hides it.
    expect(describeAgent('curl/8.4.0')).toBe('curl')
    expect(describeAgent('git/2.43.0')).toBe('git')
  })

  test('nothing at all is said plainly', () => {
    expect(describeAgent(null)).toBe('Unknown device')
    expect(describeAgent('')).toBe('Unknown device')
  })

  test('something unrecognised is still a row, not a crash', () => {
    // A list that throws on one odd string is a list nobody can open, and the
    // odd string is the one worth looking at.
    expect(describeAgent('SomeInternalTool/1.0')).toBe('A browser')
  })
})
