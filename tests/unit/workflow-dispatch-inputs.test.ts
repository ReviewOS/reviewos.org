// `workflow_dispatch` inputs: what a workflow declares, and what somebody sent.
//
// This is the one place a person hands values straight to a pipeline, so it is
// the boundary where "the workflow says choice, and you sent `producton`" has
// to become a message rather than a run that fails twelve minutes later on a
// typo.

import { describe, expect, test } from 'bun:test'
import { checkInputs } from '../../app/Actions/Workflow/inputs'
import { dispatchInputsFrom, parseWorkflow } from '../../app/Actions/Workflow/parse'

describe('reading the inputs a workflow declares', () => {
  test('every type Actions supports, with its shape intact', () => {
    const inputs = dispatchInputsFrom({
      'environment': {
        description: 'Where to deploy',
        required: true,
        type: 'choice',
        options: ['staging', 'production'],
      },
      'dry-run': { type: 'boolean', default: true },
      'tag': { type: 'string', default: 'latest' },
      'target': { type: 'environment' },
    })

    expect(inputs.map(input => input.name)).toEqual(['environment', 'dry-run', 'tag', 'target'])
    expect(inputs[0]).toMatchObject({
      type: 'choice',
      required: true,
      options: ['staging', 'production'],
      description: 'Where to deploy',
    })
    // A boolean's default is kept as written; coercion belongs where the value
    // is used.
    expect(inputs[1]).toMatchObject({ type: 'boolean', default: 'true' })
    expect(inputs[3]?.type).toBe('environment')
  })

  test('the order written is the order kept, because a form follows it', () => {
    // A workflow author who put `environment` first meant it to be the first
    // question somebody is asked.
    const inputs = dispatchInputsFrom({ second: {}, first: {}, third: {} })

    expect(inputs.map(input => input.name)).toEqual(['second', 'first', 'third'])
  })

  test('an unrecognised type reads as a string rather than refusing the file', () => {
    const inputs = dispatchInputsFrom({ thing: { type: 'colour' } })

    expect(inputs[0]?.type).toBe('string')
  })

  test('and a workflow reaches them through the parser', () => {
    const result = parseWorkflow(`name: Deploy
on:
  workflow_dispatch:
    inputs:
      environment:
        type: choice
        options: [staging, production]
        required: true
jobs:
  ship:
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy
`, '.github/workflows/deploy.yml')

    expect(result.ok).toBe(true)
    expect(result.workflow?.triggers.dispatch).toBe(true)
    expect(result.workflow?.triggers.dispatchInputs).toHaveLength(1)
    expect(result.workflow?.triggers.dispatchInputs[0]?.options).toEqual(['staging', 'production'])
  })

  test('a bare `workflow_dispatch:` with no inputs still dispatches', () => {
    const result = parseWorkflow(`on: workflow_dispatch
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`, '.github/workflows/a.yml')

    expect(result.workflow?.triggers.dispatch).toBe(true)
    expect(result.workflow?.triggers.dispatchInputs).toEqual([])
  })
})

describe('checking what somebody sent', () => {
  const declared = dispatchInputsFrom({
    'environment': { type: 'choice', options: ['staging', 'production'], required: true },
    'dry-run': { type: 'boolean', default: 'false' },
    'tag': { type: 'string', default: 'latest' },
    'note': { type: 'string' },
  })

  test('fills defaults in, so the run records what it ran with', () => {
    const checked = checkInputs(declared, { environment: 'staging' })

    expect(checked.ok).toBe(true)
    expect(checked.values).toEqual({ 'environment': 'staging', 'dry-run': 'false', 'tag': 'latest' })
  })

  test('an input with no value and no default is absent rather than empty', () => {
    // A step testing `if: inputs.note != ''` should see nothing at all.
    const checked = checkInputs(declared, { environment: 'staging' })

    expect(Object.hasOwn(checked.values, 'note')).toBe(false)
  })

  test('a required input with nothing to fall back on is refused', () => {
    const checked = checkInputs(declared, {})

    expect(checked.ok).toBe(false)
    expect(checked.errors).toEqual(['"environment" is required'])
  })

  /*
   * Actions works this way, and it reads as wrong until you see the file it
   * comes from: `required: true` with a default means "this always has a
   * value", not "the caller must always type one".
   */
  test('a default satisfies required', () => {
    const withDefault = dispatchInputsFrom({ where: { required: true, default: 'staging' } })

    expect(checkInputs(withDefault, {}).ok).toBe(true)
    expect(checkInputs(withDefault, {}).values).toEqual({ where: 'staging' })
  })

  test('a choice outside its options is refused, with the options in the message', () => {
    const checked = checkInputs(declared, { environment: 'producton' })

    expect(checked.ok).toBe(false)
    expect(checked.errors[0]).toContain('staging, production')
  })

  test('a boolean takes the spellings people write, and nothing else', () => {
    for (const [given, expected] of [['true', 'true'], ['yes', 'true'], ['1', 'true'], ['false', 'false'], ['no', 'false'], ['OFF', 'false']] as const) {
      const checked = checkInputs(declared, { 'environment': 'staging', 'dry-run': given })

      expect(checked.ok).toBe(true)
      expect(checked.values['dry-run']).toBe(expected)
    }

    expect(checkInputs(declared, { 'environment': 'staging', 'dry-run': 'perhaps' }).ok).toBe(false)
  })

  /*
   * Refused rather than dropped. Silently discarding an input is how somebody
   * spends an afternoon wondering why `enviroment: production` did nothing, and
   * it is nearly always a typo for a real input rather than something the
   * sender meant.
   */
  test('an input the workflow never declared is refused, not ignored', () => {
    const checked = checkInputs(declared, { environment: 'staging', enviroment: 'production' })

    expect(checked.ok).toBe(false)
    expect(checked.errors[0]).toContain('enviroment')
  })

  test('every problem is reported, not just the first', () => {
    // A form with three wrong fields should be fixable in one pass rather than
    // three round trips.
    const checked = checkInputs(declared, { 'environment': 'nowhere', 'dry-run': 'perhaps', 'nonsense': '1' })

    expect(checked.errors).toHaveLength(3)
  })

  test('a choice with no options accepts anything, because that is the workflow\'s mistake', () => {
    // Refusing every value would make the workflow undispatchable over a line
    // its author probably meant to fill in.
    const empty = dispatchInputsFrom({ where: { type: 'choice' } })

    expect(checkInputs(empty, { where: 'anywhere' }).ok).toBe(true)
  })

  test('and a workflow declaring nothing accepts nothing', () => {
    expect(checkInputs([], {}).ok).toBe(true)
    expect(checkInputs([], { anything: '1' }).ok).toBe(false)
  })
})
