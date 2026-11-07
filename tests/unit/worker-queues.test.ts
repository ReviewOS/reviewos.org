import { expect, test } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'

test('every application queue has exactly one managed worker group', () => {
  const cloud = readFileSync('config/cloud.ts', 'utf8')
  const groups = [...cloud.matchAll(/command: `[^`]*--queue=([A-Za-z0-9_,\-]+)/g)].map(match => match[1]!.split(','))
  const queues = new Set<string>()
  for (const name of readdirSync('app/Jobs').filter(name => name.endsWith('.ts'))) {
    const source = readFileSync('app/Jobs/' + name, 'utf8')
    const queue = source.match(/queue: '([^']+)'/)?.[1]
    if (queue) queues.add(queue)
  }
  expect(queues.size).toBeGreaterThan(0)
  for (const queue of queues) expect(groups.filter(group => group.includes(queue)).length, queue).toBe(1)
  const interactive = groups.find(group => group.includes('default'))!
  for (const queue of ['storage', 'repository-snapshots', 'mirrors-code']) expect(interactive).not.toContain(queue)
})
