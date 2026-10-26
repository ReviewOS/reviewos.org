# Projects and boards

The **Projects** tab organizes a repository's issues and pull requests into native boards. A card
references the existing issue row. Its title, open or closed state, and conversation remain the same
wherever it is read. Removing a card never deletes its issue.

## Plan work

Create a project with a title and description. Its board starts with **Backlog**, **In progress** and
**Done**. Contributors with write permission can add, rename, reorder and remove columns. A board
supports up to 30 columns and keeps at least one. Move cards out of a column before deleting it.

Add an existing issue or pull request by its repository number. A board holds a given issue once;
the same issue can appear in multiple projects. Cards from another repository cannot be attached.
Use separate projects to keep large backlogs focused.

Use **Move or remove** on a card to move it to another column, move it to the top or end of a column,
or remove it from the project. These controls work with a keyboard and ordinary browser forms.
Board columns stack vertically on phones. **List view** shows the same work in a compact grid.
Search filters card titles or numbers; the state filter uses the issue's live open or closed state.

Moving a card to Done does not close the issue. A project column is a planning decision; closing an
issue is a separate action on its conversation. A closed issue can stay on a board when it is still
useful for tracking a release.

## Access and concurrency

Readers can view projects. Triage collaborators can add, move and remove cards. Write collaborators
can manage projects and columns. Private projects inherit repository access, and fine-grained tokens
also need `projects:read` or `projects:write`. The repository token selection still applies.

Project settings can close a project. A closed project remains readable and freezes its board;
reopening it allows changes again. Archiving the repository freezes every project.

Board mutations take the project lock so moving cards and deleting columns cannot race. Moves and
removals carry a card revision; stale tabs receive `409`. Settings updates carry a project revision.
Card ordering uses indexed range updates rather than one database round trip per card.
Boards show 200 cards per page with Previous and Next navigation. Search and state filters run
before pagination, so cards remain findable across a large backlog. Project lists show 100 per page.

## API

All paths below start with `/api/repos/{owner}/{repository}`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/projects` | List projects |
| POST | `/projects` | Create with `title` and `description` |
| GET | `/projects/{project}` | Read columns and live issue cards; accepts `q`, `state`, `offset` |
| POST | `/projects/{project}` | Save settings with expected `revision` |
| POST | `/projects/{project}/columns` | Create, rename, move left or right, or delete a column |
| POST | `/projects/{project}/items` | Add `number` to `column_id` |
| POST | `/projects/{project}/items/{item}/move` | Move to `column_id` with expected card `revision` |
| POST | `/projects/{project}/items/{item}/remove` | Remove with expected card `revision` |

Column operations use `operation` (`create`, `rename`, `left`, `right`, `delete`), and existing
columns use `column_id`. Card moves append by default. Send `placement: first` to prepend, or
`before_item_id` to insert immediately before another card in the destination column.

Projects, columns and cards are included in database backups. Deleting an issue removes its cards;
deleting the repository removes its projects and columns through their declared relationships.

List responses expose `next_offset` when another page exists. Pass it as `offset` on the next request.
