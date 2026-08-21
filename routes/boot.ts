import { route } from '@stacksjs/router'
import { warmHighlighter } from '../app/Actions/Browse/highlight'

/**
 * Not a route: work this instance does once, before the first reader arrives.
 *
 * `route.booting()` runs inside `serve()`, after the routes are loaded and
 * before the first request. It exists because there was nowhere else to put
 * this: `app/Routes.ts` is a config object, a route file runs at import time -
 * which is before the router knows what it is serving - and an exported
 * `warmHighlighter()` that nothing calls is dead code pretending to be a fix.
 *
 * This file loads with the other route files, which both boot paths import
 * before serving, so the hook is registered wherever serving happens. Same
 * arrangement as `views.ts`, and for the same reason.
 *
 * ## What is warmed, and what it buys
 *
 * Measured on the 5,722 file compare: the first compare in a process took
 * 2,058ms with a worst hold of 1,080ms; the second took 920ms with a worst hold
 * of 124ms. The difference is grammar parsing and JIT, paid once per process -
 * and paid by whichever reader arrived first, who has no idea why their page
 * was a second slower than everybody else's. Warming it costs about 30ms at
 * boot, when nobody is waiting.
 *
 * Anything added here must be optional. A failing boot hook is logged and the
 * boot continues, deliberately, so a hook whose failure should stop the process
 * belongs in the start path rather than here.
 */
/*
 * Registered only if the framework has the hook.
 *
 * Not defensiveness about a version this application declares - `package.json`
 * asks for a router that has it. It is consistency with what the hook *is*: the
 * framework logs a failing hook and boots anyway, deliberately, because
 * refusing to start a server over a warm-up is the worse failure. A route file
 * that threw here would do exactly that, and worse: a route file that fails to
 * load takes the whole route registry with it, so an instance running an older
 * router would answer nothing at all rather than answer slightly slower.
 *
 * Registration is as forgiving as execution, or the two disagree about how
 * important this is.
 */
if (typeof route.booting === 'function')
  route.booting('warm-highlighter', warmHighlighter)
