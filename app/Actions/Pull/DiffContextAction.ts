import { Action } from '@stacksjs/actions'
import { highlightLines } from '../Browse/highlight'
import { diskPathFor } from '../Git/access'
import { authorizeRepository } from '../Repo/authorize'
import { contextLinesFrom, expandRange, MAX_EXPAND_LINES } from './expand'
import { escapeHtml, renderDiffRows } from './rows'

/**
 * The lines between two hunks, on request.
 *
 * A hunk carries three lines of context, which is enough to know where you are
 * and rarely enough to know whether a change is right. These are the rest,
 * read from the blob at the head commit, because the patch does not contain
 * them: not containing them is what makes them a gap.
 *
 * Rendered here rather than sent as data, for the same reason the rows are: the
 * markup has to match the rows it is being inserted between, and two renderers
 * producing nearly the same context rows would drift.
 */
export default new Action({
  name: 'DiffContext',
  description: 'Render the lines a diff left out between two hunks',
  method: 'GET',

  async handle(request: any) {
    const auth = await authorizeRepository(request, 'repository:read')
    if (!auth.ok)
      return response.json({ error: auth.error }, auth.status)

    const { repository } = auth.context
    const owner = String(request.get('owner') ?? '').trim().toLowerCase()

    const number = Number(request.get('number'))
    const path = String(request.get('path') ?? '')
    const from = Number(request.get('from'))
    const to = Number(request.get('to'))
    const offset = Number(request.get('offset') ?? 0)

    if (!Number.isInteger(number) || number <= 0 || path === '')
      return response.json({ error: 'A pull request number and a path are required' }, 422)

    if (!Number.isFinite(from) || !Number.isFinite(to))
      return response.json({ error: 'A line range is required' }, 422)

    const pullRequest = await db
      .selectFrom('pull_requests')
      .select(['head_sha'])
      .where('repository_id', '=', repository.id)
      .where('number', '=', number)
      .executeTakeFirst()

    if (!pullRequest)
      return response.json({ error: 'No such pull request' }, 404)

    const diskPath = diskPathFor(owner, repository.name)
    if (!diskPath)
      return response.json({ error: 'Repository not found' }, 404)

    const expanded = await expandRange(diskPath, {
      path,
      ref: String(pullRequest.head_sha),
      from,
      to,
    })

    if (!expanded.ok)
      return response.json({ error: expanded.error ?? 'No context available' }, 404)

    // Highlighted against the whole file's language, the same way the diff's
    // own lines are, so an expanded line does not stand out by being plainer
    // than the ones around it.
    const tokens = await highlightLines(expanded.lines, path)
    const lines = contextLinesFrom(expanded.lines, expanded.from, Number.isFinite(offset) ? offset : 0)

    const map: Record<string, Array<{ type: string, content: string }>> = {}
    lines.forEach((line, index) => { map[`+${line.newLine}`] = tokens[index] ?? [] })

    const layout = String(request.get('layout') ?? '') === 'split' ? 'split' : 'unified'

    // Rendered through the ordinary row renderer by handing it a file with one
    // hunk made of these lines. Anything else would be a second renderer.
    const html = renderDiffRows({
      path,
      previousPath: null,
      status: 'modified',
      binary: false,
      additions: 0,
      deletions: 0,
      oldMode: null,
      newMode: null,
      hunks: [{
        oldStart: lines[0]?.oldLine ?? 1,
        oldLines: lines.length,
        newStart: expanded.from,
        newLines: lines.length,
        heading: '',
        lines,
      }],
    }, { layout, tokens: map, inlineChanges: false })

    return response.json({
      from: expanded.from,
      count: lines.length,
      // Whether asking again would show more, so the control can say so rather
      // than the reader clicking into nothing.
      more: to - expanded.from + 1 > lines.length,
      max: MAX_EXPAND_LINES,
      // The hunk header row the renderer adds is not wanted here: these lines
      // are being inserted between hunks, not opening one.
      html: html.replace(/<tr class="hunk-head">.*?<\/tr>/, ''),
      path: escapeHtml(path),
    })
  },
})
