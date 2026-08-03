/**
 * Issue templates, read from the repository they belong to.
 *
 * A project's templates live in `.github/ISSUE_TEMPLATE/`, which means they are
 * versioned with the code and edited by a pull request like anything else. That
 * is the whole appeal, and it is why these are read from git rather than stored
 * in a table somebody has to keep in sync.
 *
 * Parsing only. Reading the files is the caller's job, so the rules here can be
 * tested against the ways a template is malformed - and they are malformed
 * often, because they are hand-written YAML-ish frontmatter that nobody runs.
 */

export interface IssueTemplate {
  /** The file it came from, used as the identifier in a URL. */
  slug: string
  /** What the chooser calls it. Falls back to the filename. */
  name: string
  /** One line under the name in the chooser. */
  about: string | null
  /** Prefilled into the title field. */
  title: string
  /** Prefilled into the body. */
  body: string
  /** Labels applied on open, if the repository has them. */
  labels: string[]
}

/**
 * Split frontmatter from the body.
 *
 * The delimiter has to be a line of exactly three dashes. A body that opens
 * with a horizontal rule is ordinary markdown, and treating it as frontmatter
 * silently eats the first section of somebody's template.
 */
export function splitFrontmatter(source: string): { frontmatter: string, body: string } {
  const normalized = source.replace(/\r\n/g, '\n')

  if (!/^---[ \t]*\n/.test(normalized))
    return { frontmatter: '', body: normalized }

  const end = /\n---[ \t]*(?:\n|$)/.exec(normalized.slice(3))
  if (!end)
    return { frontmatter: '', body: normalized }

  const frontmatter = normalized.slice(4, 3 + end.index)
  const body = normalized.slice(3 + end.index + end[0].length)

  return { frontmatter, body }
}

/**
 * The handful of frontmatter keys a template uses.
 *
 * Deliberately not a YAML parser. These files carry five scalar keys and a list
 * of labels; pulling in a parser to read that means inheriting its opinions
 * about anchors, tags and type coercion, none of which belong in a value that
 * ends up in a form field.
 */
export function parseFrontmatter(frontmatter: string): Record<string, string | string[]> {
  const values: Record<string, string | string[]> = {}

  for (const line of frontmatter.split('\n')) {
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!match)
      continue

    const key = match[1]!.toLowerCase()
    const raw = match[2]!.trim()

    // `labels: [bug, triage]` and `labels: bug, triage` both appear in the
    // wild, and so does a quoted single value.
    if (key === 'labels' || key === 'assignees') {
      const inner = /^\[(.*)\]$/.exec(raw)?.[1] ?? raw
      values[key] = inner
        .split(',')
        .map(part => unquote(part.trim()))
        .filter(Boolean)
      continue
    }

    values[key] = unquote(raw)
  }

  return values
}

function unquote(value: string): string {
  const match = /^(['"])([\s\S]*)\1$/.exec(value)

  return match ? match[2]! : value
}

/**
 * One template, from a file.
 *
 * Never fails: a template whose frontmatter is unreadable still opens an issue
 * with its body, which is more useful than refusing to show it. The name falls
 * back to the filename so the chooser always has something to click.
 */
export function parseTemplate(filename: string, source: string): IssueTemplate {
  const slug = filename.replace(/\.(?:md|markdown|yml|yaml)$/i, '')
  const { frontmatter, body } = splitFrontmatter(source)
  const values = parseFrontmatter(frontmatter)

  const name = typeof values.name === 'string' && values.name ? values.name : slug
  const about = typeof values.about === 'string' && values.about
    ? values.about
    : (typeof values.description === 'string' && values.description ? values.description : null)

  return {
    slug,
    name,
    about,
    title: typeof values.title === 'string' ? values.title : '',
    body: body.trim(),
    labels: Array.isArray(values.labels) ? values.labels : [],
  }
}

/** Whether a file in the template directory is one. */
export function isTemplateFile(filename: string): boolean {
  // `config.yml` configures the chooser rather than being a template, and the
  // leading dot excludes the editor droppings that end up in every directory.
  if (filename.startsWith('.') || /^config\.ya?ml$/i.test(filename))
    return false

  return /\.(?:md|markdown)$/i.test(filename)
}

/** Where templates live, in the order they are looked for. */
export const TEMPLATE_DIRECTORY = '.github/ISSUE_TEMPLATE'

/**
 * The single-template fallback, for projects that never made a directory.
 *
 * One file, no chooser: it is the template, so the new-issue form opens with it
 * already filled in.
 */
export const SINGLE_TEMPLATE_PATHS = [
  '.github/ISSUE_TEMPLATE.md',
  '.github/issue_template.md',
  'ISSUE_TEMPLATE.md',
] as const

/**
 * Every template a repository offers, in chooser order.
 *
 * Reads the directory first, then falls back to the single-file form. Nothing
 * here throws: a repository with no templates, an unreadable ref, or a bare
 * repository with no commits at all all mean the same thing to the caller -
 * there are no templates, open a blank issue.
 */
export async function loadTemplates(
  repositoryPath: string,
  ref: string,
  read: {
    listTree: (path: string, at: string, sub: string) => Promise<{ ok: boolean, entries: Array<{ name: string, type: string }> }>
    readBlob: (path: string, at: string, file: string) => Promise<{ ok: boolean, text: string | null }>
  },
): Promise<IssueTemplate[]> {
  const listing = await read.listTree(repositoryPath, ref, TEMPLATE_DIRECTORY).catch(() => null)

  if (listing?.ok && listing.entries.length > 0) {
    const files = listing.entries
      .filter(entry => entry.type === 'blob' && isTemplateFile(entry.name))
      // Sorted by name, because `ls-tree` order is git's and a chooser whose
      // order changes between reads is unsettling.
      .sort((a, b) => a.name.localeCompare(b.name))

    const templates: IssueTemplate[] = []
    for (const file of files) {
      const blob = await read.readBlob(repositoryPath, ref, `${TEMPLATE_DIRECTORY}/${file.name}`).catch(() => null)
      if (blob?.ok && blob.text !== null)
        templates.push(parseTemplate(file.name, blob.text))
    }

    if (templates.length > 0)
      return templates
  }

  for (const path of SINGLE_TEMPLATE_PATHS) {
    const blob = await read.readBlob(repositoryPath, ref, path).catch(() => null)
    if (blob?.ok && blob.text !== null)
      return [parseTemplate(path.split('/').pop()!, blob.text)]
  }

  return []
}
