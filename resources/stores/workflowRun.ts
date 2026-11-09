import { defineStore, state } from '@stacksjs/stx'

/** Browser-only, memory-only state. A new page scope clears the previous run. */
export const workflowRun = defineStore('workflow-run', () => {
  const scope = state('')
  const snapshot = state<any>(null)
  const connection = state('connecting')
  const updatedAt = state(0)

  function initialize(key: string, initial: any) {
    scope.set(key)
    snapshot.set(initial)
    connection.set('connecting')
    updatedAt.set(0)
  }
  function accept(key: string, next: any) {
    if (scope() !== key) return
    snapshot.set(next)
    updatedAt.set(Date.now())
  }
  function job(key: string, id: number) {
    return scope() === key ? snapshot()?.jobs?.find((one: any) => Number(one.id) === Number(id)) : null
  }
  function step(key: string, jobId: number, stepId: number) {
    return job(key, jobId)?.steps?.find((one: any) => Number(one.id) === Number(stepId))
  }
  return { scope, snapshot, connection, updatedAt, initialize, accept, job, step }
})
