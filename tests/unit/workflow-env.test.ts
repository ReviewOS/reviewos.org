// `env:` and its precedence: workflow, then job, then step, narrowest wins.
//
// The merge is three lines. What is worth pinning is the part people actually
// get wrong - an empty value is a value, a name defined twice keeps the
// innermost definition, and "why did my step see staging" has to be answerable
// from the data rather than by reading the file again.

import { describe, expect, test } from 'bun:test'
import { envFrom, explainEnv, resolveEnv } from '../../app/Actions/Workflow/env'

describe('reading a stored env', () => {
  test('an object of strings, as written', () => {
    expect(envFrom('{"NODE_ENV":"test","PORT":"3000"}')).toEqual({ NODE_ENV: 'test', PORT: '3000' })
  })

  test('numbers and booleans become strings, because a process receives strings', () => {
    // `PORT: 8080` in YAML is the number 8080, and the runner is handed "8080".
    expect(envFrom({ PORT: 8080, DEBUG: true } as any)).toEqual({ PORT: '8080', DEBUG: 'true' })
  })

  test('a name with no value is empty rather than absent', () => {
    // `THING:` in YAML is null, and Actions passes it as empty: a step testing
    // `if [ -z "$THING" ]` should see an empty string, not an unset variable.
    expect(envFrom({ THING: null } as any)).toEqual({ THING: '' })
  })

  test('nothing readable is nothing, not an error', () => {
    // A version whose env cannot be read still runs, with less in its
    // environment - the failure a person can see and fix.
    expect(envFrom(null)).toEqual({})
    expect(envFrom('')).toEqual({})
    expect(envFrom('not json')).toEqual({})
    expect(envFrom('[1,2]')).toEqual({})
  })
})

describe('precedence', () => {
  const levels = {
    workflow: { NODE_ENV: 'production', SHARED: 'from-workflow' },
    job: { SHARED: 'from-job', JOB_ONLY: 'yes' },
    step: { SHARED: 'from-step' },
  }

  test('the narrowest level wins', () => {
    expect(resolveEnv(levels).SHARED).toBe('from-step')
  })

  test('and everything else is inherited rather than replaced', () => {
    // Setting `env` on a step does not clear the job's or the workflow's:
    // names merge, values do not.
    expect(resolveEnv(levels)).toEqual({
      NODE_ENV: 'production',
      SHARED: 'from-step',
      JOB_ONLY: 'yes',
    })
  })

  test('a level that defines nothing changes nothing', () => {
    expect(resolveEnv({ workflow: { A: '1' } })).toEqual({ A: '1' })
    expect(resolveEnv({ workflow: { A: '1' }, job: null, step: undefined })).toEqual({ A: '1' })
  })

  test('an empty string at a narrower level still wins', () => {
    // Unsetting by blanking is a real thing people write, and reading it as
    // "no value, so inherit" would silently keep the wider one.
    expect(resolveEnv({ workflow: { TOKEN: 'abc' }, job: { TOKEN: '' } }).TOKEN).toBe('')
  })

  test('names are compared exactly, so Path and PATH are two variables', () => {
    // Actions does not case-fold them, and neither does anything underneath
    // except Windows. Surprising once, correct forever.
    expect(resolveEnv({ workflow: { Path: 'a' }, job: { PATH: 'b' } })).toEqual({ Path: 'a', PATH: 'b' })
  })
})

describe('explaining where a value came from', () => {
  /*
   * The question this exists for: "why did my step see staging when the job
   * says production". Unanswerable from the merged map alone.
   */
  test('names the level in effect and the ones it beat', () => {
    const explained = explainEnv({
      workflow: { TARGET: 'production' },
      job: { TARGET: 'staging' },
    })

    expect(explained).toHaveLength(1)
    expect(explained[0]).toMatchObject({
      name: 'TARGET',
      value: 'staging',
      level: 'job',
      overridden: ['workflow'],
    })
  })

  test('and records both losers when all three define a name', () => {
    const explained = explainEnv({
      workflow: { TARGET: 'a' },
      job: { TARGET: 'b' },
      step: { TARGET: 'c' },
    })

    expect(explained[0]).toMatchObject({ value: 'c', level: 'step', overridden: ['workflow', 'job'] })
  })

  test('a name defined once has nothing overridden', () => {
    const explained = explainEnv({ workflow: { ONLY: 'here' } })

    expect(explained[0]).toMatchObject({ level: 'workflow', overridden: [] })
  })

  test('sorted by name, so two runs of one workflow read the same way', () => {
    const explained = explainEnv({ workflow: { ZED: '1', ALPHA: '2', MIDDLE: '3' } })

    expect(explained.map(entry => entry.name)).toEqual(['ALPHA', 'MIDDLE', 'ZED'])
  })
})
