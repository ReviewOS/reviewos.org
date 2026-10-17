import { PROTOCOL_HEADER, RUNNER_PROTOCOL } from './protocol'
/** Shared bounded runner protocol transport; credentials never belong in command arguments. */
export async function runnerRequest(baseUrl: string, path: string, token: string, body: unknown): Promise<{ ok: boolean, body: any, status: number }> {
  const answer = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      // The protocol version, which the server checks before the credential.
      [PROTOCOL_HEADER]: String(RUNNER_PROTOCOL.current),
    },
    body: JSON.stringify(body ?? {}),
    // A request that never answers must not hold the runner with it: a
    // heartbeat stuck on a dead connection is a lease that lapses while the
    // runner believes it is renewing it.
    signal: AbortSignal.timeout(30_000),
  })

  const text = await answer.text()

  try {
    return { ok: answer.ok, body: text ? JSON.parse(text) : null, status: answer.status }
  }
  catch {
    return { ok: false, body: { error: text.slice(0, 200) }, status: answer.status }
  }
}

/** Bind retirement permission to the registered identity that owns this journal. */
export async function confirmRetirableWorkspaces(baseUrl: string, token: string, runnerId: number | undefined, jobIds: number[]): Promise<number[]> {
  if (typeof runnerId !== 'number' || !Number.isSafeInteger(runnerId) || runnerId <= 0)
    throw new Error('Workspace recovery requires the registered runner identity')
  const response = await runnerRequest(baseUrl.replace(/\/+$/, ''), '/api/runner/workspaces/retirable', token, { job_ids: jobIds })
  if (!response.ok || response.body?.runner_id !== runnerId || !Array.isArray(response.body?.retirable))
    throw new Error('The controller did not confirm this runner\'s ownership')
  const requested = new Set(jobIds)
  return response.body.retirable.filter((id: unknown): id is number => typeof id === 'number' && Number.isSafeInteger(id) && requested.has(id))
}
