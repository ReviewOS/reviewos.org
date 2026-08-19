/**
 * The panel beside the file list: what this repository is, and the files that
 * say so.
 *
 * Everything here already existed and none of it was on a page. Topics have had
 * their own table since phase 6 and are imported from every GitHub mirror;
 * languages are measured by `MeasureLanguagesJob` and read only by the explore
 * screen; releases have a table, a page and a "latest" rule; a repository's
 * licence, code of conduct, contributing guide and security policy are sitting
 * in its tree, which the browse screen has already listed by the time it draws
 * anything. So the panel is almost entirely a matter of putting what is known
 * where somebody is looking.
 *
 * Pure, apart from `aboutFor`, and the split is the usual one: what a panel
 * *says* is a rule, and a rule in a template is a rule no test can reach.
 */

import type { TreeEntry } from '../Browse/parse'
/*
 * Statically, not `await import('./releases')` inside the function.
 *
 * This module is reached from a component's server script, and a dynamic
 * import inside that bundle does not resolve - which throws inside the script's
 * IIFE and takes every variable in the component with it. The symptom is the
 * one stx always gives: no error anywhere, and the page renders its layout's
 * source instead of the repository.
 */
import { latestRelease } from './releases'

/** One line in the panel's link list. */
export interface AboutLink {
  label: string
  href: string
  icon: string
}

/** One topic, with the query that finds its neighbours. */
export interface AboutTopic {
  name: string
  href: string
}

/** One bar in the language breakdown. */
export interface AboutLanguage {
  name: string
  /** `61.2%`, ready to draw. */
  percent: string
  /** The bar's width as a CSS percentage. */
  width: string
  /**
   * Which of the five swatches this one gets.
   *
   * Decided here rather than from a loop counter in the template, so the bar
   * and the list beneath it cannot disagree about which colour a language is.
   */
  swatch: string
}

export interface AboutRelease {
  tag: string
  name: string
  href: string
  /** "3 days ago", already formatted, or empty when the row carries no date. */
  when: string
}

export interface AboutCount {
  label: string
  value: string
  icon: string
}

export interface AboutPanel {
  description: string
  topics: AboutTopic[]
  links: AboutLink[]
  counts: AboutCount[]
  languages: AboutLanguage[]
  release: AboutRelease | null
  releaseCount: number
  releasesHref: string
}

/**
 * The health files a repository is asked to carry, and how each is spelled in
 * the wild.
 *
 * Ordered the way a reader scans them - what it is, then what it costs, then
 * how to take part - rather than alphabetically. `.github/` is checked as well
 * as the root because that is where most projects put everything except the
 * README and the licence.
 */
const HEALTH_FILES = [
  { label: 'Readme', icon: 'i-hugeicons-book-open-01', match: /^readme(\.(md|markdown|txt|rst))?$/i },
  { label: 'License', icon: 'i-hugeicons-scales-01', match: /^(licen[sc]e|copying)(\.(md|markdown|txt))?$/i },
  { label: 'Code of conduct', icon: 'i-hugeicons-user-group', match: /^code[_-]of[_-]conduct(\.(md|markdown|txt))?$/i },
  { label: 'Contributing', icon: 'i-hugeicons-git-pull-request', match: /^contributing(\.(md|markdown|txt))?$/i },
  { label: 'Security policy', icon: 'i-hugeicons-shield-01', match: /^security(\.(md|markdown|txt))?$/i },
  { label: 'Changelog', icon: 'i-hugeicons-clock-01', match: /^changelog(\.(md|markdown|txt))?$/i },
] as const

/** A file in a repository, as far as this module cares. */
export interface AboutFile {
  name: string
  /** `''` at the root, `.github` for the conventional second home. */
  directory: string
}

/** Blob names out of a tree listing, which is what the browse screen already has. */
export function filesIn(entries: readonly TreeEntry[], directory = ''): AboutFile[] {
  return entries.filter(entry => entry.type === 'blob').map(entry => ({ name: entry.name, directory }))
}

/**
 * The health files this repository actually has, as links.
 *
 * Root wins over `.github/`, because a project that has both means the root one
 * - the second is usually left over from a template. A file that is not there
 * produces no line at all: a greyed-out "Security policy" is a page telling
 * somebody about a document that does not exist.
 *
 * `licenseName` replaces the word "License" when the licence could be
 * identified, so the line reads "MIT license" the way somebody deciding whether
 * they can use this needs it to.
 */
export function healthLinks(
  files: readonly AboutFile[],
  base: string,
  ref: string,
  licenseName?: string | null,
): AboutLink[] {
  const links: AboutLink[] = []

  for (const kind of HEALTH_FILES) {
    // Root before `.github`, which is the order `files` is expected in and is
    // asserted by the caller passing the root listing first.
    const found = files.find(file => kind.match.test(file.name))
    if (!found)
      continue

    const path = found.directory ? `${found.directory}/${found.name}` : found.name

    links.push({
      label: kind.label === 'License' && licenseName ? licenseName : kind.label,
      href: `${base}/tree/${ref}/${path}`,
      icon: kind.icon,
    })
  }

  return links
}

/**
 * Which licence a `LICENSE` file is, from its opening.
 *
 * Matched on the distinctive line each one leads with rather than on the whole
 * text, because every licence in the wild has been reflowed, had a copyright
 * year edited into it, or been pasted with smart quotes. Only the head is
 * looked at for the same reason plus one: a licence is up to thirty kilobytes
 * and the answer is always in the first few hundred bytes.
 *
 * Null when nothing matches, and the line then just says "License". Guessing
 * wrong here is worse than not guessing: somebody deciding whether they can
 * ship this reads that word and believes it.
 */
const LICENSE_SIGNATURES: Array<[RegExp, string]> = [
  [/gnu affero general public license\s*\n?\s*version 3/i, 'AGPL-3.0 license'],
  [/gnu lesser general public license\s*\n?\s*version 3/i, 'LGPL-3.0 license'],
  [/gnu lesser general public license\s*\n?\s*version 2\.1/i, 'LGPL-2.1 license'],
  [/gnu general public license\s*\n?\s*version 3/i, 'GPL-3.0 license'],
  [/gnu general public license\s*\n?\s*version 2/i, 'GPL-2.0 license'],
  [/apache license\s*\n?\s*version 2\.0/i, 'Apache-2.0 license'],
  [/mozilla public license\s*(version\s*)?2\.0/i, 'MPL-2.0 license'],
  [/this is free and unencumbered software released into the public domain/i, 'The Unlicense'],
  [/permission to use, copy, modify, and\/?or distribute this software/i, 'ISC license'],
  [/permission is hereby granted, free of charge/i, 'MIT license'],
  [/redistribution and use in source and binary forms.*3\. neither the name/is, 'BSD-3-Clause license'],
  [/redistribution and use in source and binary forms/i, 'BSD-2-Clause license'],
]

export function identifyLicense(text: string | null | undefined): string | null {
  const head = String(text ?? '').slice(0, 2000)
  if (!head.trim())
    return null

  for (const [signature, name] of LICENSE_SIGNATURES) {
    if (signature.test(head))
      return name
  }

  return null
}

/**
 * The language breakdown, as bars.
 *
 * Capped at five with no "other" bar. The point of the breakdown is "what am I
 * about to read", which the top few answer completely; a row of slivers for
 * every vendored dependency answers a question nobody asked and makes the ones
 * that matter unreadable.
 *
 * The percentages are the stored ones rather than recomputed from the visible
 * rows, so the numbers still say what the repository is rather than what the
 * top five are.
 */
export function languageBars(rows: readonly { language: unknown, percent: unknown }[], limit = 5): AboutLanguage[] {
  return rows
    .map(row => ({ name: String(row.language ?? ''), value: Number(row.percent ?? 0) }))
    .filter(row => row.name && Number.isFinite(row.value) && row.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, limit)
    .map((row, index) => ({
      name: row.name,
      percent: `${row.value >= 10 ? Math.round(row.value) : row.value.toFixed(1)}%`,
      // Floored at a hair so a language that rounds to zero still draws a mark
      // rather than an invisible bar with a label beside it.
      width: `${Math.max(0.5, row.value)}%`,
      swatch: `lang-${index}`,
    }))
}

/**
 * Topics, each linking to the repositories that share it.
 *
 * That query is the entire reason topics are a table rather than a string on
 * the repository - and until now nothing anywhere linked to it, so the one
 * thing topics are for was unreachable from the one page that showed them.
 */
export function topicLinks(topics: readonly string[]): AboutTopic[] {
  return topics
    .map(topic => String(topic ?? '').trim())
    .filter(Boolean)
    .map(name => ({ name, href: `/explore?topic=${encodeURIComponent(name)}` }))
}

/** What the reader half needs, so the page passes it rather than re-deriving it. */
export interface AboutInput {
  repositoryId: number
  base: string
  ref: string
  description: string
  /** Blob names at the root, then in `.github`. Root first: root wins. */
  files: readonly AboutFile[]
  /** The `LICENSE` file's opening, when there is one to read. */
  licenseText?: string | null
  stars: string
  watchers: string
  forks: string
  /**
   * How a date is said out loud, passed in rather than imported.
   *
   * The same shape `treeRows` and `commitRows` take, and for the same reason:
   * it keeps this module free of the browse layer while letting one repository
   * page phrase every time the same way.
   */
  relativeTime?: (when: string) => string
}

/**
 * The panel, assembled.
 *
 * Two queries, both over an index, and both wrapped: a repository whose
 * languages have never been measured and one whose release table is empty are
 * ordinary states, not failures, and a panel that throws takes the whole page
 * down with it - see the notes in `resources/components/RepoBrowser.stx` about
 * what a thrown server script renders as.
 */
export async function aboutFor(input: AboutInput): Promise<AboutPanel> {
  const [topics, languages, releases] = await Promise.all([
    readTopics(input.repositoryId),
    readLanguages(input.repositoryId),
    readReleases(input.repositoryId),
  ])

  const published = releases.filter(release => String(release.status ?? '') === 'published')
  const latest = latestRelease(published as any)

  return {
    description: String(input.description ?? ''),
    topics: topicLinks(topics),
    links: healthLinks(input.files, input.base, input.ref, identifyLicense(input.licenseText)),
    /*
     * Stated rather than linked. GitHub's equivalents go to a list of people,
     * and this forge has no such screen - a count that looks like a link and
     * answers 404 is worse than one that plainly does not.
     */
    counts: [
      { label: 'stars', value: input.stars, icon: 'i-hugeicons-star' },
      { label: 'watching', value: input.watchers, icon: 'i-hugeicons-eye' },
      { label: 'forks', value: input.forks, icon: 'i-hugeicons-git-fork' },
    ],
    languages: languageBars(languages),
    release: latest
      ? {
          tag: String((latest as any).tag_name ?? ''),
          name: String((latest as any).name || (latest as any).tag_name || ''),
          href: `${input.base}/releases`,
          when: publishedAt(latest, input.relativeTime),
        }
      : null,
    releaseCount: published.length,
    releasesHref: `${input.base}/releases`,
  }
}

async function readTopics(repositoryId: number): Promise<string[]> {
  try {
    const rows = await db
      .selectFrom('repo_topics')
      .select(['topic'])
      .where('repository_id', '=', repositoryId)
      .orderBy('topic', 'asc')
      .execute()

    return rows.map(row => String(row.topic ?? ''))
  }
  catch {
    return []
  }
}

async function readLanguages(repositoryId: number): Promise<Array<{ language: unknown, percent: unknown }>> {
  try {
    return await db
      .selectFrom('repository_languages')
      .select(['language', 'percent'])
      .where('repository_id', '=', repositoryId)
      .orderBy('bytes', 'desc')
      .execute()
  }
  catch {
    // Never measured, or the table is not there on a fresh instance.
    return []
  }
}

async function readReleases(repositoryId: number): Promise<any[]> {
  try {
    return await db
      .selectFrom('releases')
      .select(['tag_name', 'name', 'status', 'published_at', 'is_prerelease'])
      .where('repository_id', '=', repositoryId)
      .execute()
  }
  catch {
    return []
  }
}

/** The published date as a person says it, or nothing when there is none. */
function publishedAt(release: any, relativeTime?: (when: string) => string): string {
  const when = String(release?.published_at ?? '')

  if (!when)
    return ''

  return relativeTime ? relativeTime(when) : when
}
