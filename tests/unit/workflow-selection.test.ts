import { describe, expect, test } from 'bun:test'
import { selectWorkflow } from '../../app/Actions/Workflow/select-workflow'

const old = { id: 1, name: 'CI', path: '.github/workflows/ci.yml', state: 'removed' }
const current = { id: 2, name: 'CI', path: '.reviewos/workflows/ci.yml', state: 'active' }

describe('workflow aliases after a provider migration', () => {
  test('file and display names choose the current workflow regardless of historical row order', () => {
    for (const rows of [[old, current], [current, old]])
      for (const name of ['ci.yml', 'CI']) expect(selectWorkflow(rows, name)).toEqual({ workflow: current })
  })
  test('an explicit historical path still addresses its removed workflow', () => {
    expect(selectWorkflow([old, current], old.path)).toEqual({ workflow: old })
  })
  test('two active aliases are refused rather than dispatching arbitrary code', () => {
    const another = { ...current, id: 3, path: '.reviewos/workflows/nested/ci.yml' }
    for (const name of ['ci.yml', 'CI']) {
      expect(selectWorkflow([old, current, another], name).error).toContain('full workflow path')
      expect(selectWorkflow([old, current, another], name).workflow).toBeUndefined()
    }
    expect(selectWorkflow([current, another], another.path)).toEqual({ workflow: another })
  })
  test('a disabled current workflow stays disabled and is not replaced by a removed one', () => {
    const disabled = { ...current, state: 'disabled' }
    expect(selectWorkflow([old, disabled], 'ci.yml')).toEqual({ workflow: disabled })
    expect(selectWorkflow([old], 'ci.yml')).toEqual({ workflow: old })
    expect(selectWorkflow([current], 'missing.yml').workflow).toBeUndefined()
  })
})
