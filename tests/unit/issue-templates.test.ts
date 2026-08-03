/**
 * Issue templates, as they are actually written.
 *
 * These files live in the repository, are hand-written, and nobody runs them -
 * so they are malformed far more often than code is. The rule throughout is
 * that a template never fails to open an issue: unreadable frontmatter still
 * gives you the body, and a missing name still gives the chooser something to
 * click.
 */

import { describe, expect, test } from 'bun:test'
import { isTemplateFile, parseFrontmatter, parseTemplate, splitFrontmatter } from '../../app/Actions/Issue/templates'

const BUG = [
  '---',
  'name: Bug report',
  'about: Something is not working',
  'title: "[Bug] "',
  'labels: bug, needs triage',
  '---',
  '',
  '## What happened',
  '',
  'Describe it here.',
].join('\n')

describe('splitFrontmatter', () => {
  test('separates the block from the body', () => {
    const { frontmatter, body } = splitFrontmatter(BUG)

    expect(frontmatter).toContain('name: Bug report')
    expect(body).toStartWith('\n## What happened')
  })

  /**
   * A body that opens with a horizontal rule is ordinary markdown. Treating it
   * as frontmatter silently eats the first section of somebody's template.
   */
  test('leaves a body that merely starts with a rule alone', () => {
    const source = '---\n\nJust a rule above some text.'

    expect(splitFrontmatter(source).frontmatter).toBe('')
    expect(splitFrontmatter(source).body).toBe(source)
  })

  test('leaves a file with no frontmatter alone', () => {
    expect(splitFrontmatter('# Title\n\nBody.').frontmatter).toBe('')
  })

  test('copes with carriage returns', () => {
    expect(splitFrontmatter('---\r\nname: X\r\n---\r\nBody').frontmatter).toContain('name: X')
  })

  test('copes with an empty file', () => {
    expect(splitFrontmatter('')).toEqual({ frontmatter: '', body: '' })
  })
})

describe('parseFrontmatter', () => {
  test('reads scalar keys', () => {
    const values = parseFrontmatter('name: Bug report\nabout: Something broke')

    expect(values.name).toBe('Bug report')
    expect(values.about).toBe('Something broke')
  })

  test('strips the quotes people add for a trailing space', () => {
    expect(parseFrontmatter('title: "[Bug] "').title).toBe('[Bug] ')
    expect(parseFrontmatter('title: \'x\'').title).toBe('x')
  })

  /** Both spellings appear in the wild, and so does a single unbracketed value. */
  test('reads labels as a list either way it is written', () => {
    expect(parseFrontmatter('labels: bug, triage').labels).toEqual(['bug', 'triage'])
    expect(parseFrontmatter('labels: [bug, triage]').labels).toEqual(['bug', 'triage'])
    expect(parseFrontmatter('labels: bug').labels).toEqual(['bug'])
  })

  test('drops empty entries from a trailing comma', () => {
    expect(parseFrontmatter('labels: bug, ,').labels).toEqual(['bug'])
  })

  test('ignores a line it cannot read rather than giving up on the block', () => {
    const values = parseFrontmatter('name: Bug\n  - stray\nabout: Fine')

    expect(values.name).toBe('Bug')
    expect(values.about).toBe('Fine')
  })

  test('is case insensitive about keys', () => {
    expect(parseFrontmatter('Name: Bug').name).toBe('Bug')
  })
})

describe('parseTemplate', () => {
  test('reads a whole template', () => {
    const template = parseTemplate('bug_report.md', BUG)

    expect(template).toMatchObject({
      slug: 'bug_report',
      name: 'Bug report',
      about: 'Something is not working',
      title: '[Bug] ',
      labels: ['bug', 'needs triage'],
    })
    expect(template.body).toStartWith('## What happened')
  })

  /** The chooser always needs something to click. */
  test('falls back to the filename for a name', () => {
    expect(parseTemplate('feature.md', '# No frontmatter').name).toBe('feature')
  })

  test('still gives you the body when the frontmatter is unreadable', () => {
    const template = parseTemplate('x.md', '---\n!!! nonsense\n---\nThe body survives.')

    expect(template.body).toBe('The body survives.')
  })

  test('takes description as a synonym for about', () => {
    expect(parseTemplate('x.md', '---\ndescription: Alt text\n---\n').about).toBe('Alt text')
  })

  test('leaves title and labels empty when unset, rather than undefined', () => {
    const template = parseTemplate('x.md', 'Just a body')

    expect(template.title).toBe('')
    expect(template.labels).toEqual([])
    expect(template.about).toBeNull()
  })

  test('drops the extension from the slug, whichever it is', () => {
    expect(parseTemplate('a.md', '').slug).toBe('a')
    expect(parseTemplate('b.markdown', '').slug).toBe('b')
    expect(parseTemplate('c.yml', '').slug).toBe('c')
  })
})

describe('isTemplateFile', () => {
  test('accepts markdown', () => {
    expect(isTemplateFile('bug_report.md')).toBe(true)
    expect(isTemplateFile('feature.markdown')).toBe(true)
  })

  /** `config.yml` configures the chooser rather than being a template. */
  test('rejects the chooser config', () => {
    expect(isTemplateFile('config.yml')).toBe(false)
    expect(isTemplateFile('config.yaml')).toBe(false)
  })

  test('rejects editor droppings and anything not markdown', () => {
    expect(isTemplateFile('.DS_Store')).toBe(false)
    expect(isTemplateFile('.gitkeep')).toBe(false)
    expect(isTemplateFile('README.txt')).toBe(false)
  })
})
