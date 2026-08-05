import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

const todoDirectory = resolve(import.meta.dir, '../../docs/todo')

function checkboxCounts(markdown: string): { completed: number, total: number } {
  return {
    completed: markdown.match(/^\s*- \[x\]/gm)?.length ?? 0,
    total: markdown.match(/^\s*- \[[ x]\]/gm)?.length ?? 0,
  }
}

describe('roadmap index', () => {
  test('reports the current checkbox count and phase state', async () => {
    const index = await Bun.file(resolve(todoDirectory, 'index.md')).text()
    const phaseFiles = [...new Bun.Glob('[0-9][0-9]-*.md').scanSync({ cwd: todoDirectory })].sort()
    const problems: string[] = []

    for (const filename of phaseFiles) {
      const line = index.split('\n').find(candidate => candidate.includes(`](./${filename})`))

      if (!line) {
        problems.push(`${filename}: missing from roadmap index`)
        continue
      }

      const markdown = await Bun.file(resolve(todoDirectory, filename)).text()
      const actual = checkboxCounts(markdown)
      const reported = line.match(/\((\d+)\/(\d+)\)/)

      if (!reported) {
        problems.push(`${filename}: index has no completed/total count`)
        continue
      }

      const completed = Number(reported[1])
      const total = Number(reported[2])

      if (completed !== actual.completed || total !== actual.total)
        problems.push(`${filename}: index says ${completed}/${total}, file is ${actual.completed}/${actual.total}`)

      const state = line.split('|').at(-2)?.trim() ?? ''

      if (actual.completed > 0 && state.startsWith('Not started'))
        problems.push(`${filename}: has completed work but is marked Not started`)
    }

    expect(problems).toEqual([])
  })
})
