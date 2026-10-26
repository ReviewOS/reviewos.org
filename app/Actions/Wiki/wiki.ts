import { db } from '@stacksjs/database'
import { renderUntrustedMarkdown } from '@stacksjs/bunpress'
import { transaction } from '@stacksjs/orm'
import { dbTimestamp } from '../Support/sql'
import { ForgeError, titleField } from '../Support/forge'

export function wikiSlug(value: unknown): string {
  const slug = String(value ?? '').trim().replace(/\.md$/i, '').toLowerCase().replace(/\s+/g, '-')
  if (!/^[a-z0-9][a-z0-9-]{0,119}$/.test(slug))
    throw new ForgeError('Page names use letters, numbers and hyphens, up to 120 characters')
  return slug
}

export function wikiHtml(body: string, base: string): string {
  return renderUntrustedMarkdown(body, {
    resolveLink: (href) => {
      if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('/'))
        return href
      if (href.startsWith('#'))
        return `#wiki-${href.slice(1)}`
      const [path, fragment] = href.split('#')
      try {
        return `${base}/${wikiSlug(path)}${fragment ? `#wiki-${fragment}` : ''}`
      }
      catch {
        return href
      }
    },
  })
}

export async function wikiPages(repositoryId: number, offset = 0): Promise<any[]> {
  return db.selectFrom('wiki_pages').select(['id', 'slug', 'title', 'revision', 'updated_at', 'is_deleted'])
    .where('repository_id', '=', repositoryId).orderBy('title', 'asc').orderBy('id', 'asc').offset(offset).limit(101).execute()
}

export async function wikiPage(repositoryId: number, slug: string): Promise<any> {
  return db.selectFrom('wiki_pages').selectAll().where('repository_id', '=', repositoryId).where('slug', '=', slug).executeTakeFirst()
}

export async function wikiHistory(pageId: number): Promise<any[]> {
  return db.selectFrom('wiki_revisions').leftJoin('users', 'users.id', '=', 'wiki_revisions.author_id')
    .select(['wiki_revisions.revision', 'wiki_revisions.summary', 'wiki_revisions.created_at', 'wiki_revisions.is_deleted', 'users.handle as author'])
    .where('wiki_page_id', '=', pageId).orderBy('wiki_revisions.revision', 'desc').limit(100).execute()
}

/** A repository lock also serializes the first save, before a page row exists. */
export async function saveWikiPage(repositoryId: number, authorId: number, slug: string, input: { title: unknown, body: unknown, revision: unknown, summary: unknown, remove?: boolean }): Promise<any> {
  const expected = Number(input.revision)
  if (!Number.isSafeInteger(expected) || expected < 0)
    throw new ForgeError('Send the revision you edited, or 0 for a new page')
  const title = titleField(input.title)
  const body = String(input.body ?? '')
  const summary = String(input.summary ?? '').trim()
  if (Buffer.byteLength(body) > 60_000 || summary.length > 255)
    throw new ForgeError('Pages allow 60 KB of Markdown and a 255 character edit summary')

  return transaction(async (tx) => {
    await tx.selectFrom('repositories').select(['id']).where('id', '=', repositoryId).lockForUpdate().executeTakeFirst()
    const previous = await tx.selectFrom('wiki_pages').selectAll().where('repository_id', '=', repositoryId).where('slug', '=', slug).executeTakeFirst()
    if (Number(previous?.revision ?? 0) !== expected)
      throw new ForgeError('This page changed while you were editing. Reload its current revision before saving your draft.', 409)
    if (input.remove && (!previous || previous.is_deleted))
      throw new ForgeError('No such wiki page', 404)
    const revision = expected + 1
    const now = dbTimestamp()
    const values = { title, body, revision, is_deleted: Boolean(input.remove), updated_at: now }
    let pageId = Number(previous?.id)
    if (previous)
      await tx.updateTable('wiki_pages').set(values).where('id', '=', pageId).execute()
    else {
      const created = await tx.insertInto('wiki_pages').values({ repository_id: repositoryId, slug, ...values, created_at: now }).returning(['id']).executeTakeFirst()
      pageId = Number(created?.id)
    }
    await tx.insertInto('wiki_revisions').values({ repository_id: repositoryId, wiki_page_id: pageId, author_id: authorId, ...values, summary, created_at: now }).execute()
    return { id: pageId, slug, ...values }
  })
}
