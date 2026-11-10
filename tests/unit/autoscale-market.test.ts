// Which market an autoscaled runner group launches into when Spot runs dry.
//
// The decision itself is ts-cloud's `planMarket`; this checks what ReviewOS
// asks it - the group's own fallback window, measured back from now - and that
// a group on its declared market never asks AWS at all.

import { describe, expect, test } from 'bun:test'
import { marketFor } from '../../app/Actions/Runner/Autoscale/tick'
import { autoscalingGroups } from '../../cloud/autoscaling'

const group = autoscalingGroups['hq-aws']!
const now = new Date('2026-11-10T20:00:00Z')

function api(trouble: { refused?: Date[], interrupted?: Array<[string, Date]> }) {
  const asked: Date[] = []
  return {
    asked,
    spotTrouble: async (_name: string, since: Date) => {
      asked.push(since)
      return { refused: trouble.refused ?? [], interrupted: new Map(trouble.interrupted ?? []) }
    },
  }
}

describe('a spot runner group when Spot runs dry', () => {
  test('falls back to on-demand after its machines are reclaimed', async () => {
    const aws = api({ interrupted: [['i-0436c7f7ed8719425', new Date('2026-11-10T19:49:07Z')]] })
    const market = await marketFor(aws as any, group, 0, now)
    expect(market.percent).toBe(100)
    expect(market.reason).toContain('reclaimed')
    // It asks about exactly its own window.
    expect(aws.asked[0]!.toISOString()).toBe(new Date(now.getTime() - (group.spotFallbackSeconds ?? 0) * 1000).toISOString())
  })

  test('returns to spot once the window has been quiet', async () => {
    expect((await marketFor(api({}) as any, group, 100, now)).percent).toBe(0)
  })

  test('leaves a group that is where it should be alone', async () => {
    expect((await marketFor(api({}) as any, group, 0, now)).percent).toBeNull()
  })

  test('never asks AWS for a group with no market to move', async () => {
    const aws = api({ refused: [now] })
    expect((await marketFor(aws as any, { ...group, market: { ...group.market, spot: false } }, 100, now)).percent).toBeNull()
    expect((await marketFor(aws as any, group, null, now)).percent).toBeNull()
    expect(aws.asked).toHaveLength(0)
  })

  test('HQ\'s group declares its window', () => {
    expect(group.spotFallbackSeconds).toBe(1800)
  })
})
