# Repository wiki

Each repository has a **Wiki** tab. Pages are Markdown documents with a stable page name, a title,
and an append-only revision history. A private repository has a private wiki. Repository readers can
read pages and history; contributors with write permission can create, edit, delete and restore pages.
An archived repository keeps its wiki readable and refuses edits.

## Write and link pages

Choose **New page** on the Wiki tab. Enter a title and Markdown. The optional page name becomes the
URL and the exported filename; `Getting started` becomes `getting-started`. Names use letters,
numbers and hyphens, with a maximum of 120 characters. Titles can contain up to 160 characters and
a page can hold 60 KB of UTF-8 Markdown.

Use ordinary Markdown links: `[Installation](installation.md)`. Page names are case insensitive.
Heading links such as `[Configuration](installation.md#configuration)` point into that page.
Use **Preview Markdown** to check a draft before saving. Use **Download Markdown** to save the source without the forge interface.

BunPress renders wiki Markdown through its safe user-document API. Tables, task lists, headings,
links and fenced code work. Raw HTML and stx templates display as text. The renderer does not read
server files, execute scripts, load a page config, or resolve Markdown includes.

## History and restore

Every save records the complete Markdown, title, editor, UTC timestamp and optional edit summary.
**History** lists the latest 100 revisions. Each revision remains addressable through the API even
when it has left that listing. Choose a revision to read it, then **Restore this revision** to open
its text in the editor. Saving creates another revision, preserving the intervening history.

Deletion removes a page from normal reading and retains its history. The Wiki index keeps a link to
deleted pages so a contributor can restore them. Restoring a page uses the same revision check as
editing one.

Two editors cannot silently replace each other's work. A save carries the revision the editor
opened. If another save has landed, the server returns `409` and asks the editor to reload. Keep the
draft and compare it with the current revision before resubmitting.

## API

All paths below start with `/api/repos/{owner}/{repository}`. Fine-grained tokens require `wiki:read`
or `wiki:write` and access to that repository. The browser uses its normal session and CSRF token.

| Method | Path | Purpose |
|---|---|---|
| GET | `/wiki` | List pages, with `offset` and `next_offset` pagination |
| POST | `/wiki` | Create with `title`, optional `slug`, `body`, `summary` |
| POST | `/wiki-preview` | Render an unsaved `body` through the safe BunPress renderer |
| GET | `/wiki/{slug}` | Current source, safe HTML and history |
| GET | `/wiki/{slug}?revision=3&history=1` | Read an earlier or deleted revision |
| GET | `/wiki/{slug}?format=raw&revision=3` | Export a Markdown revision |
| POST | `/wiki/{slug}` | Save `title`, `body`, `summary`, expected `revision` |
| POST | `/wiki/{slug}/delete` | Delete with expected `revision` |

Wiki pages and revisions are relational forge data, included in the metadata database backup.
Deleting the repository cascades to both tables.
