/**
 * The panel beside the file list.
 *
 * Almost every fact in it already existed and none of it was on a page, so what
 * is worth testing is not "does the data load" but the three rules that decide
 * what a reader is *told*: which health files a repository is credited with,
 * which licence it is claimed to be under, and how a language breakdown is cut
 * down without lying about the proportions.
 *
 * The licence one matters most. Somebody deciding whether they can ship this
 * reads that word and believes it, so guessing wrong is worse than not
 * guessing.
 */

import { describe, expect, it } from 'bun:test'
import { filesIn, healthLinks, identifyLicense, languageBars, topicLinks } from '../../app/Actions/Repo/about'

const BASE = '/stacks/stacks'

function blob(name: string): any {
  return { mode: '100644', type: 'blob', sha: 'a'.repeat(40), size: 10, name }
}

function tree(name: string): any {
  return { mode: '040000', type: 'tree', sha: 'b'.repeat(40), size: null, name }
}

describe('filesIn', () => {
  it('takes the files and leaves the directories', () => {
    expect(filesIn([blob('README.md'), tree('src'), blob('LICENSE.md')])).toEqual([
      { name: 'README.md', directory: '' },
      { name: 'LICENSE.md', directory: '' },
    ])
  })

  it('records where they came from, so `.github` can be listed too', () => {
    expect(filesIn([blob('SECURITY.md')], '.github')).toEqual([{ name: 'SECURITY.md', directory: '.github' }])
  })
})

describe('healthLinks', () => {
  const files = [
    { name: 'README.md', directory: '' },
    { name: 'LICENSE.md', directory: '' },
    { name: 'CONTRIBUTING.md', directory: '' },
  ]

  it('links each file it found, at the ref being looked at', () => {
    const links = healthLinks(files, BASE, 'main')

    expect(links.map(link => link.label)).toEqual(['Readme', 'License', 'Contributing'])
    expect(links[0]!.href).toBe('/stacks/stacks/tree/main/README.md')
  })

  it('says nothing at all about a file the repository does not have', () => {
    // A greyed-out "Security policy" is a page telling somebody about a
    // document that does not exist.
    const links = healthLinks(files, BASE, 'main')

    expect(links.map(link => link.label)).not.toContain('Security policy')
  })

  it('finds the ones projects keep in `.github`', () => {
    const links = healthLinks(
      [...files, { name: 'CODE_OF_CONDUCT.md', directory: '.github' }],
      BASE,
      'main',
    )

    const conduct = links.find(link => link.label === 'Code of conduct')

    expect(conduct?.href).toBe('/stacks/stacks/tree/main/.github/CODE_OF_CONDUCT.md')
  })

  it('names the licence when it could be identified', () => {
    // "MIT license" is what somebody deciding whether they can use this needs
    // to read. "License" makes them open the file.
    const links = healthLinks(files, BASE, 'main', 'MIT license')

    expect(links.map(link => link.label)).toContain('MIT license')
  })

  it('accepts the spellings repositories actually use', () => {
    for (const name of ['readme', 'README.markdown', 'Readme.txt']) {
      expect(healthLinks([{ name, directory: '' }], BASE, 'main')[0]?.label).toBe('Readme')
    }

    for (const name of ['LICENCE', 'COPYING', 'license.txt']) {
      expect(healthLinks([{ name, directory: '' }], BASE, 'main')[0]?.label).toBe('License')
    }

    for (const name of ['CODE_OF_CONDUCT.md', 'code-of-conduct.md']) {
      expect(healthLinks([{ name, directory: '' }], BASE, 'main')[0]?.label).toBe('Code of conduct')
    }
  })

  it('keeps a slashed branch whole in the link', () => {
    const links = healthLinks(files, BASE, 'release/1.0')

    expect(links[0]!.href).toBe('/stacks/stacks/tree/release/1.0/README.md')
  })
})

describe('identifyLicense', () => {
  it.each([
    ['MIT license', 'MIT License\n\nCopyright (c) 2026 Chris\n\nPermission is hereby granted, free of charge, to any person'],
    ['Apache-2.0 license', '                                 Apache License\n                           Version 2.0, January 2004\n'],
    ['GPL-3.0 license', 'GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007'],
    ['AGPL-3.0 license', 'GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3, 19 November 2007'],
    ['MPL-2.0 license', 'Mozilla Public License Version 2.0\n=================================='],
    ['ISC license', 'ISC License\n\nPermission to use, copy, modify, and/or distribute this software for any purpose'],
    ['The Unlicense', 'This is free and unencumbered software released into the public domain.'],
  ])('recognises %s', (expected, text) => {
    expect(identifyLicense(text)).toBe(expected)
  })

  it('tells the two BSD licences apart by the clause that differs', () => {
    const two = 'Redistribution and use in source and binary forms, with or without modification, are permitted'
    const three = `${two}\n\n1. x\n2. y\n3. Neither the name of the copyright holder nor the names`

    expect(identifyLicense(three)).toBe('BSD-3-Clause license')
    expect(identifyLicense(two)).toBe('BSD-2-Clause license')
  })

  it('prefers the more specific GNU licence over the one it contains the name of', () => {
    // "GNU Lesser General Public License" contains "General Public License",
    // so the order of the signatures is load-bearing.
    expect(identifyLicense('GNU LESSER GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007')).toBe('LGPL-3.0 license')
  })

  it('says nothing rather than guessing', () => {
    expect(identifyLicense('All rights reserved. Ask before using any of this.')).toBeNull()
    expect(identifyLicense('')).toBeNull()
    expect(identifyLicense(null)).toBeNull()
  })
})

describe('languageBars', () => {
  const rows = [
    { language: 'TypeScript', percent: 61.24 },
    { language: 'CSS', percent: 20.5 },
    { language: 'Shell', percent: 8.3 },
    { language: 'JavaScript', percent: 5.2 },
    { language: 'Dockerfile', percent: 3.1 },
    { language: 'Makefile', percent: 1.66 },
  ]

  it('keeps the top few, in order', () => {
    const bars = languageBars(rows)

    expect(bars).toHaveLength(5)
    expect(bars[0]!.name).toBe('TypeScript')
    expect(bars.map(bar => bar.name)).not.toContain('Makefile')
  })

  it('rounds a large share and keeps a decimal on a small one', () => {
    const bars = languageBars(rows)

    expect(bars[0]!.percent).toBe('61%')
    expect(bars[2]!.percent).toBe('8.3%')
  })

  it('reports the stored share rather than a share of what is shown', () => {
    // The breakdown says what the repository is, not what the top five are.
    const total = languageBars(rows).reduce((sum, bar) => sum + Number.parseFloat(bar.width), 0)

    expect(total).toBeLessThan(100)
  })

  it('gives a language that rounds to nothing a visible mark', () => {
    const bars = languageBars([{ language: 'Nix', percent: 0.05 }])

    expect(Number.parseFloat(bars[0]!.width)).toBeGreaterThan(0)
  })

  it('pairs each bar with a fixed swatch, so the bar and the list agree', () => {
    const bars = languageBars(rows)

    expect(bars.map(bar => bar.swatch)).toEqual(['lang-0', 'lang-1', 'lang-2', 'lang-3', 'lang-4'])
  })

  it('drops a row with no name or no share rather than drawing an empty bar', () => {
    expect(languageBars([{ language: '', percent: 10 }, { language: 'Go', percent: 0 }])).toEqual([])
  })
})

describe('topicLinks', () => {
  it('sends each topic to the repositories that share it', () => {
    // The query that justifies topics being a table, which nothing linked to.
    expect(topicLinks(['typescript', 'code-review'])).toEqual([
      { name: 'typescript', href: '/explore?topic=typescript' },
      { name: 'code-review', href: '/explore?topic=code-review' },
    ])
  })

  it('encodes a topic that would otherwise change the query', () => {
    expect(topicLinks(['c++'])[0]!.href).toBe('/explore?topic=c%2B%2B')
  })

  it('drops blanks rather than linking to every repository', () => {
    expect(topicLinks(['', '  ', 'git'])).toHaveLength(1)
  })
})
