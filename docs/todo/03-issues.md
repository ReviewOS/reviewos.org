# 03 - Issues

Issues, and the comment and markdown machinery that pull request conversations reuse in phase 4.
Build it here with that reuse in mind: a comment should not know whether it is attached to an issue
or a pull request.

## Models

- [x] `app/Models/Issue.ts`: `repository_id`, `number`, `title`, `body`, `author_id`, `state`
      (open, closed), `state_reason` (completed, not_planned, duplicate), `closed_at`, `closed_by_id`,
      `milestone_id`, `locked`, `comments_count`
- [x] `number` is per repository and gaps are not acceptable, so allocate it in the same transaction
      as the insert, from a counter on the repository row. Issues and pull requests share the
      sequence, the way every forge does it, so `#12` is unambiguous.
- [x] `app/Models/IssueComment.ts`: polymorphic `commentable`, `author_id`, `body`, `edited_at`,
      `edited_by_id`
- [x] `app/Models/Label.ts`: `repository_id`, `name`, `color`, `description`, unique per repository
- [x] `app/Models/IssueLabel.ts` and `app/Models/IssueAssignee.ts` join models
- [x] `app/Models/Milestone.ts`: `repository_id`, `title`, `description`, `due_on`, `state`,
      `open_issues_count`, `closed_issues_count`
- [x] Default label set created with each repository
- [x] All of it seeded with realistic factories

## Actions

- [ ] `app/Actions/Issue/ListIssuesAction.ts` - filter by state, label, assignee, author, milestone;
      sort by created, updated, comments; keyset pagination rather than offset
- [ ] `CreateIssueAction.ts`, `UpdateIssueAction.ts`, `CloseIssueAction.ts`, `ReopenIssueAction.ts`
- [ ] `CommentAction.ts`, `UpdateCommentAction.ts`, `DeleteCommentAction.ts`
- [ ] `AssignAction.ts`, `LabelAction.ts`, `MilestoneAction.ts`, `LockAction.ts`
- [ ] Bulk operations from the list view: close, label, assign, milestone
- [ ] Permission checks: triage can label, assign, and close; write can edit others' issues; anyone
      with read can comment on a public repository

## Markdown

One pipeline, used by issues, pull requests, reviews, releases, and repository files.

- [x] Server-side rendering, and a strict sanitizer. User markdown is hostile input; this is the
      most likely place for a stored XSS in the entire product.
      `app/Actions/Markdown/render.ts` does not sanitize a string: it builds the HTML from the parse
      tree out of a closed set of tags, escaping text as it places it. Raw HTML is disabled at the
      parser, so a `<script>` in a README arrives as text. Finding this closed a live hole - the
      README was being emitted unrendered and unescaped, and stx then undid the escaping of any
      component that had escaped anything (fixed upstream in stx, with tests both places).
- [ ] A safe subset of raw HTML: `<details>`, `<summary>`, `<br>`, `<kbd>`, `<div align>`. Common in
      READMEs and currently shown as text. Needs a real HTML tokenizer with an allowlist, not a
      regex pass over the output, which is why it is its own item rather than a flag.
- [x] Autolink references: `#123` to an issue or pull request, `@handle` to a user, `owner/repo#123`
      across repositories, and bare commit SHAs
- [ ] Closing keywords (`fixes #12`, `closes #12`, `resolves #12`) parsed on push and on merge
- [ ] Task lists that can be ticked directly from the rendered issue
- [ ] Syntax-highlighted code fences, sharing the highlighter with the blob view
- [ ] Emoji shortcodes, and `:+1:` style reactions
- [ ] Mermaid diagrams
- [ ] Image and attachment upload, stored through the filesystem driver
- [x] Tests aimed at escaping: raw HTML, `javascript:` URLs, nested markdown, and enormous inputs

## Timeline

- [ ] A timeline model recording state changes, label changes, assignments, milestone changes,
      references, and renames, so an issue reads as a history rather than a body plus comments
- [ ] Cross references: linking from a commit message or another issue records an entry on both

## Views

- [x] `resources/views/[owner]/[repository]/issues/index.stx` - list with filters
- [ ] `.../issues/[number].stx` - one issue with its timeline
- [ ] `.../issues/new.stx`
- [ ] `.../labels.stx`, `.../milestones.stx`
- [ ] Components: `IssueThread`, `IssueListItem`, `LabelPill`, `MarkdownEditor` (write and preview
      tabs), `TimelineEntry`. Rendered markdown is a `.markdown` block styled once in the layout
      rather than a component: a component cannot import the renderer, so the HTML is built in the
      view either way, and one stylesheet stops a README looking like two different things.
- [ ] Keyboard shortcuts on the list. People who live in issues navigate by keyboard.

## Templates

- [ ] Issue templates from `.github/ISSUE_TEMPLATE/` in the repository, both markdown and forms
- [ ] A chooser when more than one template exists
