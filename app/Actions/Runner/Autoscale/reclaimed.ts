import { db } from '@stacksjs/database'
import { awsWorkerGroupApi } from '@stacksjs/ts-cloud/drivers'
import { autoscalingGroups } from '../../../../cloud/autoscaling'

/**
 * Of these runners (by id), the ones whose machine the cloud took back.
 *
 * An autoscaled runner is named after its EC2 instance, and EC2 keeps the
 * reason an instance ended for about an hour after it did - long past the
 * lease grace the sweep waits out. A spot instance reclaimed mid-job reads
 * `Server.SpotInstanceTermination` there, which is AWS saying the machine was
 * wanted elsewhere: nothing the job did. The lease sweep asks this before it
 * counts a lost runner against the job.
 *
 * A runner on a box of our own, or one AWS cannot answer for, is simply not in
 * the result, so the sweep counts it the way it always has. Asking fails soft
 * for the same reason: a throttled API must not keep a job that really is
 * killing its machines in the queue forever.
 */
export async function reclaimedByCloud(runnerIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(runnerIds.map(Number).filter(id => Number.isInteger(id) && id > 0))]
  if (ids.length === 0)
    return new Set()

  const runners = await db.selectFrom('runners').select(['id', 'name']).where('id', 'in', ids).execute()
  const byName = new Map(runners.map((runner: any) => [String(runner.name), String(runner.id)]))
  const names = [...byName.keys()].filter(name => /^i-[0-9a-f]{8,}$/.test(name))
  if (names.length === 0)
    return new Set()

  const reclaimed = new Set<string>()
  for (const region of new Set(Object.values(autoscalingGroups).map(group => group.region))) {
    const api = awsWorkerGroupApi(region)
    if (!api)
      continue
    try {
      for (const name of await api.interrupted(names)) {
        const id = byName.get(name)
        if (id)
          reclaimed.add(id)
      }
    }
    catch (error) {
      console.warn(`[reclaim] could not ask ${region} which runners were reclaimed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return reclaimed
}
