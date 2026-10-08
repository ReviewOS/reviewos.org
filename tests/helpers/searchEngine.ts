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
 *
 * ## And in CI, a missing node is not skipped either
 *
 * Standing down quietly is right for a laptop and wrong for CI, and the three
 * callers of this make the difference stark: each test in them opens with
 * `if (!available) return`, and a test whose body returns immediately is a
 * **pass**. So with no node reachable the twenty-three tests across
 * `search-page`, `search-action` and `search-push-reindex` did not report as
 * skipped - they reported green, having asserted nothing. Three of them are
 * the check that a private repository does not surface in a stranger's search
 * results.
 *
 * CI has a node now: the `search` service in `.github/workflows/ci.yml`. If it
 * ever does not, the run fails rather than passing quietly - the one thing
 * worse than missing coverage is missing coverage that looks present.
 *
 * That used to be three copies of the same rethrow, one per caller, keyed on
 * `CI`. It is `TESTS_REQUIRE_ALL` in `tests/setup.ts` now, which covers every
 * suite that gates itself on anything rather than only these three, and covers
 * a developer who asks for it locally rather than only CI. The callers are back
 * to warning and standing down, which is all they ever needed to do.
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
