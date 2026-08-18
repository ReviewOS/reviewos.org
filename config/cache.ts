import type { CacheConfig } from '@stacksjs/types'
import { env } from '@stacksjs/env'

/**
 * **Cache Configuration**
 *
 * This configuration defines all of your cache options. Stacks cache is
 * powered by ts-cache, providing high-performance caching with support
 * for memory and Redis drivers.
 *
 * `memory` is the zero-dependency default and is correct for one process.
 * It is *only* correct for one process: pull request presence
 * (`LiveStateAction`) rides this cache, and an in-process map means each
 * process has its own idea of who is looking at what. An instance running
 * more than one app process sets `CACHE_DRIVER=redis` and points the
 * connection at the pantry-managed valkey (`config/deps.ts` declares it,
 * `docs/self-hosting.md` has the section). Presence already degrades
 * gracefully when the cache is gone, so the switch needs no code change.
 *
 * Values are coerced through `String`/`Number` because the typed env proxy
 * widens undeclared variables; text in `.env` read as text.
 */
export default {
  /**
   * The cache driver to use ('memory' or 'redis')
   */
  driver: (String(env.CACHE_DRIVER ?? '') || 'memory') as 'memory' | 'redis',

  /**
   * Key prefix for cache namespacing
   */
  prefix: 'stacks',

  /**
   * Default TTL in seconds (0 = no expiration)
   */
  ttl: 3600,

  /**
   * Maximum number of keys (-1 = unlimited)
   */
  maxKeys: -1,

  /**
   * Clone values on get/set (disable for better performance with immutable data)
   */
  useClones: true,

  drivers: {
    /**
     * Memory driver configuration
     */
    memory: {
      maxKeys: -1,
      checkPeriod: 600,
      deleteOnExpire: true,
    },

    /**
     * Redis driver configuration.
     *
     * The same `REDIS_*` variables the queue's redis driver reads, so an
     * operator configures the connection once. The server is valkey when
     * pantry manages it; the protocol is the same.
     */
    redis: {
      host: String(env.REDIS_HOST ?? '') || '127.0.0.1',
      port: Number(env.REDIS_PORT ?? 0) || 6379,
      username: String(env.REDIS_USERNAME ?? ''),
      password: String(env.REDIS_PASSWORD ?? ''),
      database: Number(env.REDIS_DB ?? 0) || 0,
      tls: String(env.REDIS_TLS ?? '') === 'true',
    },

    /**
     * SingleStore driver configuration
     *
     * Persists cache entries in a SingleStore rowstore table (MySQL wire
     * protocol, port 3306). Set `ssl: true` for managed SingleStore (Helios).
     */
    singlestore: {
      host: '127.0.0.1',
      port: 3306,
      username: 'root',
      password: '',
      database: 'stacks',
      table: 'stacks_cache',
      ssl: false,
    },
  },
} satisfies CacheConfig
