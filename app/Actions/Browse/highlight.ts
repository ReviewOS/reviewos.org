/**
 * Syntax highlighting for the diff and blob views.
 *
 * Built on ts-syntax-highlighter's fast tokenizer, which returns tokens a line
 * at a time. That shape is what a diff needs: each line is rendered inside its
 * own table row with its own gutters, so a whole-file HTML blob would have to
 * be cut back apart again.
 *
 * The one property everything here depends on is that the tokens reproduce the
 * line exactly. A highlighter that drops a space is showing code that is not in
 * the file, and in a diff the whitespace is often the entire change.
 */

import { createHighlighter, overTokenizeCeiling } from 'ts-syntax-highlighter'
import { cachedTokens, cacheTokens, contentKey, highlightOnWorker } from './highlightPool'

/** Token types the stylesheet knows about. Anything else renders as plain text. */
export type TokenClass =
  | 'keyword'
  | 'string'
  | 'comment'
  | 'numeric'
  | 'function'
  | 'operator'
  | 'punctuation'
  | 'type'
  | 'variable'
  | 'tag'
  | 'attribute'
  | 'text'

export interface HighlightedToken {
  type: TokenClass
  content: string
}

/**
 * File extension to language id.
 *
 * Deliberately explicit rather than clever: a wrong guess highlights code as
 * the wrong language, which is more distracting than no highlighting at all.
 */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'jsonc',
  json5: 'json5',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  vue: 'vue',
  md: 'markdown',
  markdown: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  py: 'python',
  rb: 'ruby',
  php: 'php',
  go: 'go',
  rs: 'rust',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  dart: 'dart',
  lua: 'lua',
  r: 'r',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  tex: 'latex',
}

/** Files whose whole name decides the language. */
const LANGUAGE_BY_FILENAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  '.gitignore': 'bash',
  '.env': 'bash',
}

/** The language for a path, or null when we would only be guessing. */
export function languageFor(path: string): string | null {
  const name = path.split('/').pop() ?? path
  const byName = LANGUAGE_BY_FILENAME[name.toLowerCase()]
  if (byName)
    return byName

  const dot = name.lastIndexOf('.')
  if (dot <= 0)
    return null

  return LANGUAGE_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null
}

/**
 * One highlighter, reused.
 *
 * Building it per request would re-parse every grammar for every file in a
 * diff, which on a hundred-file pull request is the difference between a page
 * and a stall.
 */
let highlighterPromise: ReturnType<typeof createHighlighter> | null = null

function highlighter(): ReturnType<typeof createHighlighter> {
  if (!highlighterPromise)
    highlighterPromise = createHighlighter({})

  return highlighterPromise
}

function normalize(type: string): TokenClass {
  const known: TokenClass[] = [
    'keyword',
    'string',
    'comment',
    'numeric',
    'function',
    'operator',
    'punctuation',
    'type',
    'variable',
    'tag',
    'attribute',
  ]

  return (known as string[]).includes(type) ? type as TokenClass : 'text'
}

/**
 * Highlight lines of code, one token list per line.
 *
 * Falls back to a single plain token per line for an unknown language, an
 * unparseable file, or anything the tokenizer refuses. Showing the code
 * unhighlighted is always better than showing nothing, so nothing here throws.
 */
export async function highlightLines(lines: readonly string[], path: string): Promise<HighlightedToken[][]> {
  const plain = (): HighlightedToken[][] => lines.map(line => [{ type: 'text' as const, content: line }])

  const language = languageFor(path)
  if (!language)
    return plain()

  // Over the ceiling the colours are given up rather than the file. A minified
  // bundle is one line of a hundred thousand characters, of no interest to
  // read, and quadratic in some grammars - and it is the shape that turns a
  // page load into a stall.
  if (overTokenizeCeiling(lines))
    return plain()

  const key = contentKey(lines, language)
  const cached = cachedTokens(key)
  if (cached !== undefined) {
    // Re-verified rather than trusted, cheaply, because a cache hit is the one
    // path where nothing else has looked at the tokens on the way past.
    return cached.map((tokens, index) => verify(
      tokens.map(token => ({ type: normalize(token.type), content: token.content })),
      lines[index] ?? '',
    ))
  }

  try {
    // A worker first, for anything big enough to be worth the hop. It answers
    // null for everything it declines - too small, no workers, a worker that
    // died - and every one of those means "do it here", which is why they are
    // one answer rather than four branches.
    const offThread = await highlightOnWorker(lines, language).tokens
    const tokenized = offThread ?? inlineTokens(await highlighter(), lines, language)

    // A tokenizer that returns a different number of lines would silently
    // shift every comment anchor on the page, so the plain rendering is safer.
    if (tokenized == null || tokenized.length !== lines.length)
      return plain()

    const result = tokenized.map((tokens, index) => verify(
      tokens.map(token => ({ type: normalize(token.type), content: token.content })),
      lines[index] ?? '',
    ))

    cacheTokens(key, result)

    return result
  }
  catch {
    return plain()
  }
}

/**
 * The contract this view relies on: the tokens are the line.
 *
 * Checked on the way out rather than trusted, because a highlighter that drops
 * a space renders code the file does not contain - and in a diff the
 * whitespace is often the entire change. A line that fails renders plain.
 */
function verify(tokens: HighlightedToken[], source: string): HighlightedToken[] {
  return tokens.map(token => token.content).join('') === source
    ? tokens
    : [{ type: 'text' as const, content: source }]
}

/** Tokenize here, on this thread. The fallback for everything the pool declines. */
function inlineTokens(
  instance: Awaited<ReturnType<typeof createHighlighter>>,
  lines: readonly string[],
  language: string,
): Array<Array<{ type: string, content: string }>> {
  return instance.highlightFast(lines.join('\n'), language)
    .map(line => line.tokens.map(token => ({ type: token.type, content: token.content })))
}

/** Highlight one line. Convenience for a blob view rendering incrementally. */
export async function highlightLine(line: string, path: string): Promise<HighlightedToken[]> {
  const [tokens] = await highlightLines([line], path)

  return tokens ?? [{ type: 'text', content: line }]
}
