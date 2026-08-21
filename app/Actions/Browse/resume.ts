/**
 * Highlighting a fragment as though the file above it were there.
 *
 * A hunk starts at line four hundred. Tokenizing it from a cold state gets
 * string and comment nesting wrong, and the failure is silent and ugly: a
 * licence header's `/*` is four hundred lines above the fragment, so every line
 * of a hunk inside it renders as code, and a hunk inside a template literal
 * renders as a program instead of a string. Nothing throws and nothing looks
 * broken - it looks like the highlighter having an opinion.
 *
 * The library calls the cold answer **fragment mode**, documents it, and is
 * allowed to be wrong about multi-line constructs. This is the other half: when
 * the lines before the fragment are available, walk them, keep the scope stack,
 * and start the fragment from it.
 *
 * ## What this costs, and why it is bounded
 *
 * Reaching line four hundred means tokenizing four hundred lines to throw them
 * away. That is the price of a correct answer and it is linear in the *prelude*
 * rather than in the fragment, so a small window late in a very large file is
 * where it hurts. `MAX_PRELUDE_LINES` is the ceiling: past it the fragment is
 * highlighted cold, which is what happened everywhere before this existed.
 *
 * ## Why the stateful tokenizer, when everything else here uses the fast one
 *
 * `FastTokenizer` classifies bytes and carries no scope stack, which is exactly
 * what makes it fast and exactly why it cannot answer this. It has no state to
 * resume from. The two name tokens differently, which `normalize` in
 * `highlight.ts` reconciles - see `CLASS_ALIASES` there.
 */

import type { TokenizerState } from 'ts-syntax-highlighter'
import type { HighlightedToken } from './highlight'
import { getLanguage, Tokenizer } from 'ts-syntax-highlighter'
import { languageFor, languageForShebang } from './highlight'

/**
 * The most lines walked to reach a fragment.
 *
 * Twenty thousand is about half a second of tokenizing in the worst language
 * measured, and it covers essentially every hand-written source file. Past it
 * the file is generated, vendored, or a data dump, and being right about a
 * block comment in it is not worth making the reader wait.
 */
export const MAX_PRELUDE_LINES = 20_000

/** A fragment's opening state, or the absence of one. */
export type ResumeState = TokenizerState | null

const tokenizers = new Map<string, Tokenizer>()

/**
 * One tokenizer per language, reused.
 *
 * A `Tokenizer` compiles every pattern in its grammar at construction and the
 * dispatch table is cached per grammar, so constructing one per file was
 * measured at 23% of a run in the library's own benchmark. It carries a scope
 * stack, which is mutable - so this is safe only because every use below runs
 * to completion synchronously before the next one starts.
 */
function tokenizerFor(language: string): Tokenizer | null {
  const held = tokenizers.get(language)
  if (held)
    return held

  const found = getLanguage(language)
  if (!found)
    return null

  const built = new Tokenizer(found.grammar)
  tokenizers.set(language, built)

  return built
}

/** The language a path resolves to, with the same precedence the diff uses. */
export function resumeLanguage(path: string, firstLine = '', declared?: string | null): string | null {
  return declared ?? languageFor(path) ?? languageForShebang(firstLine)
}

/**
 * Walk the lines before a fragment and keep only where they finished.
 *
 * The tokens are discarded deliberately: the caller wants the fragment, and
 * holding four hundred lines of tokens to answer a question about the four
 * hundred and first is how a memory-bounded reader stops being one.
 *
 * Returns null when there is nothing to resume from - no grammar, an empty
 * prelude, or a prelude past the ceiling - and null is a complete answer that
 * every caller already handles, because it is what they all did before.
 */
export function scopeStateAfter(prelude: readonly string[], language: string | null): ResumeState {
  if (!language || prelude.length === 0 || prelude.length > MAX_PRELUDE_LINES)
    return null

  const tokenizer = tokenizerFor(language)
  if (!tokenizer)
    return null

  try {
    return tokenizer.tokenizeLinesFrom(prelude).endState
  }
  catch {
    // A grammar that throws on some line of the prelude is a grammar bug, and
    // the fragment is still worth showing. Cold is the old behaviour.
    return null
  }
}

/**
 * A running walk, for a caller that is streaming the prelude past anyway.
 *
 * `readBlobWindow` reads a file to find a window in the middle of it and drops
 * every line before that window as it goes. Those are exactly the lines a
 * resume needs, and they are already being read - so this consumes them one at
 * a time and holds a scope stack instead of a file.
 */
export class ScopeWalk {
  private readonly tokenizer: Tokenizer | null
  private state: ResumeState = null
  private seen = 0
  private failed = false

  constructor(language: string | null) {
    this.tokenizer = language ? tokenizerFor(language) : null
  }

  /** True when there is any point feeding it lines. */
  get active(): boolean {
    return this.tokenizer !== null && !this.failed && this.seen <= MAX_PRELUDE_LINES
  }

  push(line: string): void {
    if (!this.active)
      return

    this.seen += 1

    if (this.seen > MAX_PRELUDE_LINES) {
      this.failed = true
      this.state = null
      return
    }

    try {
      this.state = this.tokenizer!.tokenizeLinesFrom([line], this.state ?? undefined, this.seen).endState
    }
    catch {
      this.failed = true
      this.state = null
    }
  }

  /**
   * The state at the line after everything pushed, or null.
   *
   * Null once the prelude has gone past the ceiling, because a partial walk is
   * worse than no walk: it would resume the fragment from whatever state line
   * twenty thousand happened to leave, which is a confident wrong answer where
   * cold is an honest one.
   */
  finish(): ResumeState {
    return this.failed ? null : this.state
  }
}

/**
 * Highlight a fragment, resuming from a state.
 *
 * Returns null when it cannot - no grammar, or a tokenizer that came back with
 * a different number of lines than it was given, which would shift every line
 * number the page anchors on. Both mean "highlight it the ordinary way".
 */
export function highlightResumed(
  lines: readonly string[],
  language: string | null,
  state: ResumeState,
  normalizeToken: (type: string) => HighlightedToken['type'],
): HighlightedToken[][] | null {
  if (!language || lines.length === 0)
    return null

  const tokenizer = tokenizerFor(language)
  if (!tokenizer)
    return null

  try {
    const { lines: tokenized } = tokenizer.tokenizeLinesFrom(lines, state ?? undefined)

    if (tokenized.length !== lines.length)
      return null

    return tokenized.map((line, index) => {
      const tokens = line.tokens.map(token => ({ type: normalizeToken(token.type), content: token.content }))

      // The one property everything downstream depends on: the tokens are the
      // line. Checked here rather than trusted, because a resumed run has been
      // through more machinery than a cold one, not less.
      return tokens.map(token => token.content).join('') === lines[index]
        ? tokens
        : [{ type: 'text' as const, content: lines[index] ?? '' }]
    })
  }
  catch {
    return null
  }
}
