/**
 * A tokenizer, on its own thread.
 *
 * The entry point `highlightPool.ts` spawns. It is three lines because the
 * protocol lives in the library: every consumer inventing its own is how you
 * end up with four incompatible answers to what cancellation means.
 *
 * One highlighter is built inside this worker on its first request and reused
 * for the life of the thread, so the grammars are parsed once per worker rather
 * than once per file.
 */

import { serveTokenizer } from 'ts-syntax-highlighter'

serveTokenizer(self as unknown as Parameters<typeof serveTokenizer>[0])
