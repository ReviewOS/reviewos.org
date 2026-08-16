// Reusable workflows: what a caller may pass, and what it gets back.
//
// The parsing half, which is where the shapes are decided. The calling half -
// copying a called workflow's jobs into the run - is exercised end to end
// against real rows, because it is about what a run contains rather than about
// what a file says.

import { describe, expect, test } from 'bun:test'
import { parseWorkflow } from '../../app/Actions/Workflow/parse'
import { secretsPolicy } from '../../app/Actions/Workflow/reusable'

const called = `name: Build
on:
  workflow_call:
    inputs:
      environment:
        description: Where to build for
        required: true
        type: choice
        options: [staging, production]
      dry-run:
        type: boolean
        default: true
    outputs:
      artifact:
        description: What was built
        value: \${{ jobs.build.outputs.name }}
    secrets:
      REGISTRY_TOKEN:
        required: true
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: make
`

describe('a workflow that offers itself', () => {
  test('declares inputs, outputs and secrets', () => {
    const result = parseWorkflow(called, '.github/workflows/build.yml')

    expect(result.ok).toBe(true)

    const triggers = result.workflow!.triggers

    expect(triggers.reusable).toBe(true)
    expect(triggers.callInputs.map(input => input.name)).toEqual(['environment', 'dry-run'])
    expect(triggers.callInputs[0]).toMatchObject({ type: 'choice', required: true, options: ['staging', 'production'] })
    expect(triggers.callSecrets).toEqual([{ name: 'REGISTRY_TOKEN', description: '', required: true }])
  })

  test('and an output keeps its expression as written', () => {
    // It reads the called workflow's jobs, so it can only be evaluated once
    // they have run.
    const result = parseWorkflow(called, '.github/workflows/build.yml')

    expect(result.workflow!.triggers.callOutputs[0]).toMatchObject({
      name: 'artifact',
      value: '${{ jobs.build.outputs.name }}',
    })
  })

  /*
   * The inputs reuse `workflow_dispatch`'s shape deliberately: they are the
   * same idea with the same four types, and a second shape would mean two
   * validators that have to agree forever.
   */
  test('the input shape is the dispatch shape', () => {
    const result = parseWorkflow(called, '.github/workflows/build.yml')
    const input = result.workflow!.triggers.callInputs[1]!

    expect(input).toMatchObject({ name: 'dry-run', type: 'boolean', default: 'true' })
  })
})

describe('a workflow that calls one', () => {
  const caller = `name: Deploy
on: push
jobs:
  build:
    uses: ./.github/workflows/build.yml
    with:
      environment: production
    secrets: inherit
  after:
    needs: build
    runs-on: ubuntu-latest
    steps:
      - run: ./ship
`

  test('reads the call, its inputs, and its secrets policy', () => {
    const result = parseWorkflow(caller, '.github/workflows/deploy.yml')

    expect(result.ok).toBe(true)

    const job = result.workflow!.jobs[0]!

    expect(job.uses).toBe('./.github/workflows/build.yml')
    expect(job.withInputs).toEqual({ environment: 'production' })
    expect(job.secrets).toBe('inherit')
  })

  test('a calling job needs no steps and no runs-on', () => {
    // Its steps are the called workflow's jobs. Requiring either would refuse
    // every reusable-workflow caller ever written.
    const result = parseWorkflow(caller, '.github/workflows/deploy.yml')

    expect(result.errors).toEqual([])
    expect(result.workflow!.jobs[0]!.steps).toEqual([])
  })
})

describe('the secrets policy', () => {
  /*
   * Recorded rather than resolved. `inherit` means "everything the caller had"
   * and a mapping means "these, renamed" - both answers the execution plane
   * needs after the fork check, because a fork's pull request gets no secrets
   * whatever any line says.
   */
  test('inherit is a word, not an expansion', () => {
    expect(secretsPolicy('"inherit"')).toEqual({ inherit: true, named: [] })
    expect(secretsPolicy('inherit')).toEqual({ inherit: true, named: [] })
  })

  test('a mapping names what it passes', () => {
    expect(secretsPolicy('{"REGISTRY_TOKEN":"${{ secrets.TOKEN }}"}')).toEqual({
      inherit: false,
      named: ['REGISTRY_TOKEN'],
    })
  })

  test('and nothing at all grants nothing', () => {
    expect(secretsPolicy(null)).toEqual({ inherit: false, named: [] })
    expect(secretsPolicy('')).toEqual({ inherit: false, named: [] })
  })
})
