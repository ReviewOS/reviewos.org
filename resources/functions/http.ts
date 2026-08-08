/*
 * Declared here because this is a plain module, not a `.stx` file.
 *
 * stx injects ambient declarations for its server context into the virtual
 * TypeScript it checks templates against, and that only covers templates. A
 * helper the templates import is checked as ordinary TypeScript, where these
 * names do not exist - which is the same reason the guard below is needed at
 * runtime, one layer up.
 */
declare const setResponseStatus: ((_status: number) => void) | undefined
declare const setResponseHeader: ((_name: string, _value: string) => void) | undefined

/**
 * Asking for a response status from a page, without betting the page on it.
 *
 * **`setResponseStatus` is not always there.** stx declares it for the type
 * checker and the dev frontend provides it, so a page written against it checks
 * clean and works under `buddy dev`. Everything that boots through
 * `route.serve()` - the API server, the e2e suite, a production boot - renders
 * through the router's own view path, which does not, and calling it throws a
 * ReferenceError *inside the server script's IIFE*. That takes every other
 * binding in the file down with it.
 *
 * The result is the worst failure this codebase keeps meeting: the page renders
 * its not-found branch, because `repository` and every other variable are now
 * undefined, and reads as exactly the answer it meant to give. Nineteen pages
 * were in that state - every repository sub-page, the review queue, the inbox,
 * three settings screens - and each was correct only for the reader who never
 * hit the branch that calls it.
 *
 * This is the same guard the codebase already uses for `__stxServeContext`, for
 * the same reason: an *undeclared* identifier is a ReferenceError, and optional
 * chaining does not help because `x?.()` evaluates `x` first. `typeof` is the
 * only spelling that asks without touching.
 *
 * Fixed upstream in stx 0.2.157 for callers of `renderTemplate`, which is the
 * dev frontend and any host that renders directly. The router's own view path
 * is a separate entry and still needs it, which is why this exists rather than
 * a version bump.
 */
export function setStatus(status: number): void {
  if (typeof setResponseStatus === 'function')
    setResponseStatus(status)
}

/**
 * A response header, on the same terms.
 *
 * Same binding, same absence, same consequence. A page that wants
 * `X-Robots-Tag: noindex` on a private view should not lose its whole render to
 * asking for it.
 */
export function setHeader(name: string, value: string): void {
  if (typeof setResponseHeader === 'function')
    setResponseHeader(name, value)
}
