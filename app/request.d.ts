/**
 * What this instance adds to a request.
 *
 * The middleware chain resolves this project's own fine-grained token once, at
 * the edge, and stashes it on the request so every action downstream reads the
 * answer rather than re-parsing the header and re-hashing the secret. That is a
 * property the framework has never heard of, so it is declared here - once -
 * instead of at each call site with `(request as any)`.
 *
 * A module augmentation rather than a wrapper type: the handlers take
 * `RequestInstance`, and a second name for the same object would be a second
 * thing to remember to use.
 */
import type { AuthenticatedToken } from './Actions/Tokens/authenticate'

declare module '@stacksjs/types' {
  interface RequestInstance {
    /**
     * The token this request carried, once the middleware has looked.
     *
     * `undefined` means nobody has looked yet; `null` means there was none;
     * `'rejected'` means there was one and it is not usable - a distinction the
     * authorization path needs, because a bad credential must not fall through
     * to the session as though it had never been presented.
     */
    __fineGrainedToken?: AuthenticatedToken | 'rejected' | null
  }
}
