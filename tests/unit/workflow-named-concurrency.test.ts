// A named limit shared across runs and workflows.
//
// The deploy lock, and the one staging environment three pipelines share.
// Actions' `concurrency:` groups whole runs; this limits jobs by name, which is
// the only shape that serialises a deploy when two different workflows deploy.

import { describe, expect, test } from 'bun:test'
import { parseWorkflow } from '../../app/Actions/Workflow/parse'

function jobs(source: string): any[] {
  const result = parseWorkflow(`name: X\non: push\n${source}`, '.github/workflows/x.yml')

  if (result.errors.length > 0)
    throw new Error(result.errors.map(error => error.message).join('; '))

  return result.workflow!.jobs
}

function errorsIn(source: string): string[] {
  return parseWorkflow(`name: X\non: push\n${source}`, '.github/workflows/x.yml')
    .errors.map(error => error.message)
}

describe('the group and its limit', () => {
  test('a group with no number is a lock of one', () => {
    // Which is what somebody writing `concurrency-group: production` means, and
    // the safe reading either way.
    const [deploy] = jobs(`jobs:
  deploy:
    runs-on: ubuntu-latest
    reviewos:
      concurrency-group: production
    steps:
      - run: ./deploy
`)

    expect(deploy!.concurrencyLimit).toEqual({ group: 'production', limit: 1, method: 'ordered' })
  })

  test('ordered is the default, because a deploy queue is a sequence', () => {
    /*
     * A queue that hands out whichever job was polled first lands an older
     * commit after a newer one, and the state of production then depends on
     * runner timing.
     */
    const [licence] = jobs(`jobs:
  test:
    runs-on: ubuntu-latest
    reviewos:
      concurrency-group: licence-server
      concurrency: 4
      concurrency-method: eager
    steps:
      - run: ./test
`)

    expect(licence!.concurrencyLimit).toEqual({ group: 'licence-server', limit: 4, method: 'eager' })
  })

  test('a job that names none has none', () => {
    const [plain] = jobs(`jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: make
`)

    expect(plain!.concurrencyLimit).toBeNull()
  })
})

describe('what is refused', () => {
  test('a limit with no group to limit', () => {
    /*
     * Defaulting the group to the job's own name would invent a lock nobody
     * else can join, which is the opposite of what a shared lock is for.
     */
    expect(errorsIn(`jobs:
  deploy:
    runs-on: ubuntu-latest
    reviewos:
      concurrency: 1
    steps:
      - run: ./deploy
`).join(' ')).toContain('has no `concurrency-group:`')
  })

  test('a limit that is not a whole number, or is absurd', () => {
    for (const value of ['0', 'lots', '9999']) {
      expect(errorsIn(`jobs:
  deploy:
    runs-on: ubuntu-latest
    reviewos:
      concurrency-group: production
      concurrency: ${value}
    steps:
      - run: ./deploy
`).join(' ')).toContain('not a whole number between 1 and 500')
    }
  })

  test('and a method nobody implements', () => {
    expect(errorsIn(`jobs:
  deploy:
    runs-on: ubuntu-latest
    reviewos:
      concurrency-group: production
      concurrency-method: whenever
    steps:
      - run: ./deploy
`).join(' ')).toContain('neither `ordered` nor `eager`')
  })
})
