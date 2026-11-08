import { expect, test } from 'bun:test'
import { processDirectives } from '@stacksjs/stx/process'
import { renderBlobRows } from '../../app/Actions/Browse/blobRows'
import { parseDiff } from '../../app/Actions/Pull/diff'
import { renderDiffRows } from '../../app/Actions/Pull/rows'
import { renderMarkdown, renderMarkdownHighlighted } from '../../app/Actions/Markdown/render'

const example = 'before @if(false)KEEP@endif @component() @component(path) {{ pageSecret }} {!! pageSecret !!} after'

// CodeView and MarkdownContent are rendered into RepoBrowser and its layout.
// Exercise the installed renderer again over that composed HTML: checking only
// an HTML builder misses directives consumed by the parent template pass.
async function compose(html: string) {
  const component = await processDirectives('<article>{!! html !!}</article>', { html, pageSecret: 'PRIVATE_PAGE_VALUE' }, '/tmp/reviewos-literal-source.stx', {}, new Set())
  return processDirectives(component, { pageSecret: 'PRIVATE_PAGE_VALUE' }, '/tmp/reviewos-literal-layout.stx', {}, new Set())
}

for (const kind of ['blob', 'diff', 'markdown', 'highlighted-markdown'] as const) {
  test(`${kind} preserves template examples when composed into a page`, async () => {
    const html = kind === 'blob'
      ? renderBlobRows([[{ type: 'comment', content: example }]])
      : kind === 'diff'
        ? renderDiffRows(parseDiff(`diff --git a/example.txt b/example.txt\n--- a/example.txt\n+++ b/example.txt\n@@ -0,0 +1 @@\n+${example}\n`)[0]!)
        : kind === 'markdown'
          ? renderMarkdown(`\`\`\`text\n${example}\n\`\`\``)
          : await renderMarkdownHighlighted(`\`\`\`text\n${example}\n\`\`\``)
    const rendered = await compose(html)
    expect(rendered).toContain('KEEP')
    expect(rendered).toContain('before ')
    expect(rendered).toContain(' after')
    expect(rendered).toContain('&#64;if(false)')
    expect(rendered).not.toContain('PRIVATE_PAGE_VALUE')
    expect(rendered).not.toContain('Template Error')
  })
}
