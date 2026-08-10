/**
 * Is there a search node to talk to?
 *
 * The rest of the e2e suite skips itself loudly when the thing it needs is not
 * there - no database, no git, no gpg - and search was the exception: with
 * nothing listening, five tests failed with a stack trace out of the driver,
 * which reads like the product is broken rather than like the machine is
 * missing a service.
 *
 * The engine is Typesense, installed by pantry and configured in
 * `config/search-engine.ts`. `./buddy setup` starts it; a checkout that has
 * never run setup has no node, and that is a fine state for a machine running
 * unit tests to be in.
 *
 * **Probed over HTTP rather than through the driver, because the driver lies.**
 * `useSearchEngine().listAllIndices()` against a node that is not running
 * returns `{ results: [] }` - a connection refusal rendered as an empty index,
 * which is the one answer a search test must never mistake for the truth.
 * `getIndex` does throw, but it throws for a collection that has not been
 * created yet too, so it cannot tell "no node" from "no data".
 *
 * A node that is up but refuses the key is deliberately **not** skipped. That
 * is a misconfiguration rather than a missing service, and it should fail where
 * somebody can see it.
 */
export async function searchEngineReachable(): Promise<boolean> {
  try {
    const { searchEngine } = await import('@stacksjs/config')
    const node = (searchEngine as any)?.[(searchEngine as any)?.driver ?? '']

    // An engine this helper does not know how to probe is assumed present, so a
    // driver change never silently stops running these tests.
    if (!node?.host || !node?.port)
      return true

    const url = `${node.protocol ?? 'http'}://${node.host}:${node.port}/health`
    const answer = await fetch(url, { signal: AbortSignal.timeout(2000) })

    return answer.ok
  }
  catch {
    return false
  }
}
