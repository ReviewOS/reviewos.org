import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { defaultConfig, processDirectives } from '@stacksjs/stx'
import { createQueryBuilder, resetConnection, setConfig } from 'bun-query-builder'
import { conversationPageHref, conversationPageNumber, loadConversation } from '../../resources/functions/conversation'

const dialect = process.env.CONVERSATION_TEST_DIALECT === 'postgres' ? 'postgres' : 'sqlite'
test(`${dialect} discussion pages bound bodies and preserve every entry in stable order`, async () => {
    setConfig({ dialect, database: { database: process.env.DB_DATABASE!, host: process.env.DB_HOST, port: Number(process.env.DB_PORT) || undefined, username: process.env.DB_USERNAME, password: process.env.DB_PASSWORD } })
    const builder = createQueryBuilder<any>()
    ;(globalThis as any).db = builder
    try {
      const run = async (text: string) => { await builder.unsafe(text).execute() }
      await run('CREATE TABLE users (id INTEGER PRIMARY KEY, handle TEXT)')
      await run('CREATE TABLE issue_comments (id INTEGER PRIMARY KEY, commentable_type TEXT, commentable_id INTEGER, author_id INTEGER, external_author TEXT, body TEXT, created_at TIMESTAMP, edited_at TIMESTAMP)')
      await run('CREATE TABLE timeline_entries (id INTEGER PRIMARY KEY, subject_type TEXT, subject_id INTEGER, actor_id INTEGER, external_actor TEXT, kind TEXT, subject_text TEXT, previous_text TEXT, reference_number INTEGER, created_at TIMESTAMP)')
      await run('CREATE TABLE reactions (subject_type TEXT, subject_id INTEGER, content TEXT, user_id INTEGER)')
      const at = '2026-11-07 00:00:00'
      const later = '2026-11-08 00:00:00'
      await builder.insertInto('issue_comments').values(Array.from({ length: 123 }, (_, i) => ({ id: i + 1, commentable_type: 'issue', commentable_id: 7, external_author: 'writer', body: `Comment body ${i + 1}`, created_at: i < 100 ? at : later }))).execute()
      await builder.insertInto('timeline_entries').values(Array.from({ length: 77 }, (_, i) => ({ id: i + 1, subject_type: 'pull_request', subject_id: 9, external_actor: 'writer', kind: 'closed', created_at: i < 27 ? at : later }))).execute()
      await builder.insertInto('issue_comments').values({ id: 999, commentable_type: 'issue', commentable_id: 8, body: 'Foreign private body', created_at: at }).execute()
      const subject = { comments: { type: 'issue', id: 7 }, timeline: { type: 'pull_request', id: 9 }, reactions: { type: 'issue', id: 7 }, opening: { body: 'Opening', createdAt: at, authorHandle: null, externalAuthor: 'writer' }, locked: false }
      const context = { owner: 'owner', repository: 'project', number: 1, viewerId: null, picking: '', reactionAction: '/reactions', taskAction: '/tasks' }
      const keys: string[] = []
      for (let page = 1; page <= 4; page++) {
        const result = await loadConversation(subject, { ...context, page })
        expect(result.pagination).toMatchObject({ current_page: page, per_page: 50, has_more_pages: page < 4 })
        expect(result.items).toHaveLength(50)
        expect(result.commentCount).toBe(123)
        expect(JSON.stringify(result)).not.toContain('Foreign private body')
        keys.push(...result.items.map((item: any) => `${item.kind}:${item.comment?.id ?? item.event?.id}`))
      }
      expect(keys).toEqual([...Array.from({ length: 100 }, (_, i) => `comment:${i + 1}`), ...Array.from({ length: 27 }, (_, i) => `event:${i + 1}`), ...Array.from({ length: 23 }, (_, i) => `comment:${i + 101}`), ...Array.from({ length: 50 }, (_, i) => `event:${i + 28}`)])
      const focused = await loadConversation(subject, { ...context, picking: '123' })
      expect(focused.pagination.current_page).toBe(3)
      expect(focused.items.some((row: any) => row.comment?.id === 123)).toBe(true)
      expect((await loadConversation(subject, { ...context, comment: '999' })).pagination.current_page).toBe(1)
      expect((await loadConversation(subject, { ...context, page: 99 })).items).toEqual([])
      const pageServer = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
        const url = new URL(request.url)
        const result = await loadConversation(subject, { ...context, page: url.searchParams.get('conversation_page'), comment: url.searchParams.get('conversation_comment') })
        const html = await processDirectives('<IssueThread :opening="opening" :items="items" :pagination="pagination" reactionAction="/reactions" />', result,
          resolve('resources/views/discussion-test.stx'), { ...defaultConfig, componentsDir: resolve('resources/components') }, new Set())
        return new Response(html, { headers: { 'Content-Type': 'text/html' } })
      } })
      try {
        const root = `http://127.0.0.1:${pageServer.port}`
        const first = await (await fetch(root)).text()
        expect(first.match(/id="comment-\d+"/g)).toHaveLength(50)
        expect(first).toContain('href="?conversation_page=2#conversation"')
        expect(first).toContain('id="reactions-body"')
        expect(first).toContain('id="reactions-50"')
        expect(first).toContain('href="?conversation_comment=50#comment-50"')
        expect(first).not.toContain('id="comment-51"')
        const last = await (await fetch(root + '?conversation_comment=123')).text()
        expect(last).toContain('id="comment-123"')
        expect(last).toContain('Page 3')
        expect(last).toContain('href="?conversation_page=2#conversation"')
      } finally { pageServer.stop(true) }
      const none = await loadConversation({ ...subject, comments: null, timeline: null, reactions: null }, context)
      expect(none.items).toEqual([])
      expect(none.opening.bodyHtml).toContain('Opening')
      expect(none.commentCount).toBe(0)
      for (const invalid of ['0', '-1', '1e6', '1.5', '2 OR 1=1', 10000000]) expect(conversationPageNumber(invalid)).toBe(1)
      expect(conversationPageHref(3, '123')).toBe('?conversation_page=3&react=123#conversation')
    }
    finally { await resetConnection() }
}, 30000)
