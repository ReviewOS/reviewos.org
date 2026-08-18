// The shape of a run, and where its time went.
//
// A list of jobs cannot answer the two questions people have about a slow or
// stuck pipeline - what is this waiting for, and why did it take forty minutes.
// Both are properties of the graph, so both are pure functions with tests
// rather than arithmetic inside a template.

import { describe, expect, test } from 'bun:test'
import { criticalPath, layersOf, waitingOn } from '../../app/Actions/Workflow/graph'

let next = 1

function node(jobKey: string, over: Partial<{ state: string, needs: string[], waitMs: number, runMs: number }> = {}) {
  return {
    id: next++,
    jobKey,
    name: jobKey,
    state: 'succeeded',
    needs: [],
    waitMs: 0,
    runMs: 0,
    ...over,
  }
}

describe('dependency order', () => {
  test('puts a job one layer below the deepest thing it needs', () => {
    const nodes = [
      node('deploy', { needs: ['test', 'package'] }),
      node('build'),
      node('test', { needs: ['build'] }),
      node('package', { needs: ['build'] }),
    ]

    expect(layersOf(nodes).map(layer => layer.nodes.map(one => one.jobKey).sort())).toEqual([
      ['build'],
      ['package', 'test'],
      ['deploy'],
    ])
  })

  test('a matrix is several rows on one layer, under one name', () => {
    // `needs: build` means every combination of `build`, so the rows share a
    // depth and everything downstream sits below all of them.
    const nodes = [
      node('build'),
      node('build'),
      node('deploy', { needs: ['build'] }),
    ]

    const layers = layersOf(nodes)

    expect(layers[0]!.nodes.length).toBe(2)
    expect(layers[1]!.nodes.map(one => one.jobKey)).toEqual(['deploy'])
  })

  test('and a cycle in the rows does not hang', () => {
    /*
     * The parser refuses a `needs:` cycle, so this is a graph read out of a
     * database that says something impossible - and a recursive walk over it
     * would be a stack overflow rather than a wrong answer somebody can see.
     */
    const nodes = [node('a', { needs: ['b'] }), node('b', { needs: ['a'] })]

    expect(layersOf(nodes).length).toBeGreaterThan(0)
  })
})

describe('the critical path', () => {
  test('is the chain that decided the length of the run, not the slowest job', () => {
    /*
     * The question adding runners cannot answer. `slow-lint` is the longest
     * single job and it is on nobody's path; the run is as long as
     * build → test → deploy.
     */
    const nodes = [
      node('build', { runMs: 60_000 }),
      node('slow-lint', { runMs: 300_000 }),
      node('test', { needs: ['build'], runMs: 120_000 }),
      node('deploy', { needs: ['test'], runMs: 180_000 }),
    ]

    const path = criticalPath(nodes)

    expect(path.nodes.map(one => one.jobKey)).toEqual(['build', 'test', 'deploy'])
    expect(path.totalMs).toBe(360_000)
  })

  test('counts waiting as part of the cost', () => {
    /*
     * An hour spent queueing is an hour of the run either way. A critical path
     * that ignored the wait would point at the wrong job on a busy fleet - and
     * pointing at the wrong job is worse than not pointing at all.
     */
    const nodes = [
      node('quick', { runMs: 10_000, waitMs: 600_000 }),
      node('slow', { runMs: 300_000, waitMs: 0 }),
    ]

    const path = criticalPath(nodes)

    expect(path.nodes.map(one => one.jobKey)).toEqual(['quick'])
    expect(path.waitMs).toBe(600_000)
  })

  test('and says how much of itself was waiting', () => {
    // The number that decides what to do about it: a path that is mostly wait
    // is a fleet problem, and one that is mostly work is a pipeline problem.
    const nodes = [
      node('build', { runMs: 60_000, waitMs: 30_000 }),
      node('test', { needs: ['build'], runMs: 60_000, waitMs: 90_000 }),
    ]

    const path = criticalPath(nodes)

    expect(path.totalMs).toBe(240_000)
    expect(path.waitMs).toBe(120_000)
  })

  test('an empty run has an empty path rather than a crash', () => {
    expect(criticalPath([])).toEqual({ nodes: [], totalMs: 0, waitMs: 0 })
  })
})

describe('what a blocked job is waiting for', () => {
  test('names only what has not finished', () => {
    // A job waiting on four things where three are done is waiting on one.
    // Listing all four sends somebody to look at jobs that are already green.
    const nodes = [
      node('build', { state: 'succeeded' }),
      node('lint', { state: 'running' }),
      node('deploy', { state: 'blocked', needs: ['build', 'lint'] }),
    ]

    expect(waitingOn(nodes[2]!, nodes)).toEqual(['lint'])
  })

  test('and a dependency that is not in the run at all still counts', () => {
    // A job needing something that does not exist is stuck forever, and a
    // screen that says it is waiting for nothing is a screen nobody can act on.
    const nodes = [node('deploy', { state: 'blocked', needs: ['ghost'] })]

    expect(waitingOn(nodes[0]!, nodes)).toEqual(['ghost'])
  })
})
