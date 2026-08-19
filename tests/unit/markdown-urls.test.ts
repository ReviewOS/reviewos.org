import { describe, expect, it } from 'bun:test'
import {
  isAbsoluteReference,
  repositoryBlobUrl,
  repositoryMediaUrl,
  resolveRelativePath,
  resolveRepositoryReference,
  splitReference,
} from '../../app/Actions/Markdown/urls'

/**
 * Where a README's own links and images point once this forge has resolved
 * them - the arithmetic that was missing, which is why every relative image in
 * every mirrored README rendered as a broken icon.
 */

const CONTEXT = { owner: 'stacks', repository: 'stacks', ref: 'main', directory: '' }

describe('isAbsoluteReference', () => {
  it.each([
    'https://example.com/x.png',
    'http://example.com',
    'mailto:someone@example.com',
    'javascript:alert(1)',
    '//example.com/x.png',
    '/stacks/stacks/issues',
    '#installation',
    '',
  ])('leaves %s alone', (raw) => {
    expect(isAbsoluteReference(raw)).toBe(true)
  })

  it.each(['./docs/arch.png', 'docs/setup.md', '../shared/logo.svg', 'README.md'])('resolves %s', (raw) => {
    expect(isAbsoluteReference(raw)).toBe(false)
  })

  it('does not mistake a path with a colon in a later segment for a scheme', () => {
    // A scheme cannot contain a slash, so `docs/a:b.md` is a path.
    expect(isAbsoluteReference('docs/a:b.md')).toBe(false)
  })
})

describe('splitReference', () => {
  it('keeps a fragment aside so a deep link survives', () => {
    expect(splitReference('docs/setup.md#install')).toEqual({ path: 'docs/setup.md', suffix: '#install' })
  })

  it('keeps a query aside too', () => {
    expect(splitReference('docs/setup.md?plain=1')).toEqual({ path: 'docs/setup.md', suffix: '?plain=1' })
  })

  it('leaves a reference with neither untouched', () => {
    expect(splitReference('docs/setup.md')).toEqual({ path: 'docs/setup.md', suffix: '' })
  })
})

describe('resolveRelativePath', () => {
  it('resolves against the directory the document is in', () => {
    expect(resolveRelativePath('./arch.png', 'docs')).toBe('docs/arch.png')
  })

  it('drops `.` and empty segments the way a browser does', () => {
    expect(resolveRelativePath('.//images//logo.png', '')).toBe('images/logo.png')
  })

  it('walks up with `..`', () => {
    expect(resolveRelativePath('../public/social.png', 'docs')).toBe('public/social.png')
  })

  it('refuses to walk out of the repository', () => {
    // Clamping at the root would point at a file that merely shares the name,
    // which is a wrong answer dressed as a right one.
    expect(resolveRelativePath('../../etc/passwd', 'docs')).toBeNull()
    expect(resolveRelativePath('../x.png', '')).toBeNull()
  })

  it('has no answer for a reference that resolves to nothing', () => {
    expect(resolveRelativePath('.', 'docs')).toBe('docs')
    expect(resolveRelativePath('', '')).toBeNull()
  })
})

describe('repositoryMediaUrl', () => {
  it('addresses the media endpoint, which is the only one that serves an image as an image', () => {
    const url = repositoryMediaUrl(CONTEXT, 'public/images/social.png')

    expect(url.startsWith('/api/repos/media?')).toBe(true)
    expect(url).toContain('owner=stacks')
    expect(url).toContain('repo=stacks')
    expect(url).toContain('ref=main')
    expect(url).toContain(`path=${encodeURIComponent('public/images/social.png')}`)
  })

  it('encodes a ref with a slash in it rather than splitting on it', () => {
    expect(repositoryMediaUrl({ ...CONTEXT, ref: 'fix/rounding' }, 'a.png')).toContain('ref=fix%2Frounding')
  })
})

describe('repositoryBlobUrl', () => {
  it('points at the browse screen a reader would have clicked through to', () => {
    expect(repositoryBlobUrl(CONTEXT, 'docs/setup.md')).toBe('/stacks/stacks/tree/main/docs/setup.md')
  })

  it('keeps a slashed branch whole', () => {
    expect(repositoryBlobUrl({ ...CONTEXT, ref: 'fix/rounding' }, 'docs')).toBe('/stacks/stacks/tree/fix/rounding/docs')
  })
})

describe('resolveRepositoryReference', () => {
  it('sends a relative image to the media endpoint', () => {
    const url = resolveRepositoryReference('./public/images/social.png', 'media', CONTEXT)

    expect(url).toContain('/api/repos/media?')
    expect(url).toContain(`path=${encodeURIComponent('public/images/social.png')}`)
  })

  it('sends a relative link to the browse screen, fragment and all', () => {
    expect(resolveRepositoryReference('docs/setup.md#install', 'link', CONTEXT))
      .toBe('/stacks/stacks/tree/main/docs/setup.md#install')
  })

  it('leaves a badge on an external host exactly as written', () => {
    const badge = 'https://img.shields.io/npm/v/stacks?style=flat-square'

    expect(resolveRepositoryReference(badge, 'media', CONTEXT)).toBe(badge)
  })

  it('leaves a site-absolute link alone, because it already says where it goes', () => {
    expect(resolveRepositoryReference('/stacks/stacks/issues', 'link', CONTEXT)).toBe('/stacks/stacks/issues')
  })

  it('leaves a bare fragment alone', () => {
    expect(resolveRepositoryReference('#installation', 'link', CONTEXT)).toBe('#installation')
  })

  it('does nothing at all without a ref', () => {
    // An issue body was typed into a box, not read out of a tree, so it has no
    // directory to be relative to and nothing should be rewritten.
    const context = { owner: 'stacks', repository: 'stacks', ref: '' }

    expect(resolveRepositoryReference('./x.png', 'media', context)).toBe('./x.png')
    expect(resolveRepositoryReference('./x.png', 'media', null)).toBe('./x.png')
  })

  it('leaves a reference that walks out of the repository as written', () => {
    expect(resolveRepositoryReference('../../../etc/passwd', 'link', CONTEXT)).toBe('../../../etc/passwd')
  })

  it('never turns a dangerous scheme into a site path', () => {
    // `safeUrl` is what refuses this, and it can only refuse what it is given -
    // so resolution must not disguise it as something else first.
    expect(resolveRepositoryReference('javascript:alert(1)', 'link', CONTEXT)).toBe('javascript:alert(1)')
  })

  it('resolves a README two directories down against its own directory', () => {
    const context = { ...CONTEXT, directory: 'packages/core' }

    expect(resolveRepositoryReference('../../logo.png', 'media', context)).toContain(`path=logo.png`)
    expect(resolveRepositoryReference('./api.md', 'link', context)).toBe('/stacks/stacks/tree/main/packages/core/api.md')
  })
})
