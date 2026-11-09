import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Which `@if` conditions wrap a given line of a template.
 *
 * Read off the source because the bug this guards against is structural: the
 * re-run controls asked for a finished run while sitting inside a block that
 * only rendered an unfinished one, so they could never appear. Rendering the
 * page needs a database; the nesting does not.
 */
function enclosingConditions(source: string, marker: string): string[] {
  const text = source.replace(/\{\{--[\s\S]*?--\}\}/g, '')
  const at = text.indexOf(marker)
  if (at < 0)
    throw new Error(`"${marker}" is not in the template`)
  const stack: string[] = []
  for (const match of text.slice(0, at).matchAll(/@(if|elseif|else|endif)\b(?:\s*\((.*)\))?/g)) {
    const [, directive, condition = ''] = match
    if (directive === 'if')
      stack.push(condition.trim())
    else if (directive === 'endif')
      stack.pop()
    else
      stack[stack.length - 1] = `else of ${stack.at(-1)}`
  }
  return stack
}

const view = readFileSync(resolve(import.meta.dir, '../../resources/views/[owner]/[repository]/run/[number].stx'), 'utf8')

describe('the run page', () => {
  test('offers re-running a failed run, which means nothing around it requires the run to be unfinished', () => {
    const around = enclosingConditions(view, '@if (canRerun)')
    expect(around).not.toContain('!runIsFinished(String(run.state))')
  })

  test('still shows the "nothing here executes a run" note only while the run is going', () => {
    const around = enclosingConditions(view, 'Nothing on this instance executes a run.')
    expect(around).toContain('!runIsFinished(String(run.state))')
  })
})
