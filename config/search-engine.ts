import type { SearchEngineConfig } from '@stacksjs/types'
import { env } from '@stacksjs/env'

/**
 * **Search Engine Options**
 *
 * Typesense, installed by pantry and declared in `config/deps.ts`.
 *
 * Search is the one subsystem where a forge either owns its data or hands it to
 * somebody else. An instance that has to reach a hosted service to find its own
 * issues is not self-hostable, and the index carries private repository names
 * and issue titles, so it is not a thing to post to a third party by default.
 *
 * Typesense rather than the `opensearch` this named before: one binary and no
 * JVM under it, which is what lets search be on by default on somebody's own
 * box. Stacks ships the driver, and the `useSearch` trait indexes through it,
 * so nothing here is written twice.
 *
 * Every value falls back to the local development server except the API key.
 * That one has no default worth shipping: a search node reachable with a
 * guessable key answers anybody's query about private repositories.
 */
export default {
  driver: 'typesense',

  typesense: {
    host: env.TYPESENSE_HOST || '127.0.0.1',
    port: Number(env.TYPESENSE_PORT || 8108),
    protocol: env.TYPESENSE_PROTOCOL || 'http',
    apiKey: env.TYPESENSE_API_KEY || '',
  },
} satisfies SearchEngineConfig
