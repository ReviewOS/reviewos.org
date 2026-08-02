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
      `edited_by_id`, `external_author`. The author is optional and pairs with the upstream name,
      the rule `Issue`, `PullRequest` and `ReviewComment` already followed: a mirrored comment is
      written by somebody who usually has no account here, and requiring a local author made
      importing a conversation impossible. `PullRequestReview.reviewer_id` had the same defect and
      got the same treatment. A test reads the model files so a new model cannot get it wrong.
- [x] `app/Models/Label.ts`: `repository_id`, `name`, `color`, `description`, unique per repository
- [x] `app/Models/IssueLabel.ts` and `app/Models/IssueAssignee.ts` join models
- [x] `app/Models/Milestone.ts`: `repository_id`, `title`, `description`, `due_on`, `state`. The
      progress counters were dropped: the model never declared them and no migration ever added
      them, so the code maintaining them had been writing to columns that do not exist. The
      milestone list counts its issues in one grouped query for the whole page instead, and a
      counter is only worth denormalizing when the query it saves is expensive.
- [x] Default label set created with each repository
- [x] All of it seeded with realistic factories

## Actions

- [x] `app/Actions/Issue/ListIssuesAction.ts` - filter by state, label, assignee, author, milestone;
      sort by created, updated, comments; keyset pagination rather than offset
- [ ] Page the `updated` and `comments` sorts. Both can tie, so their cursor needs `(value, id)`
      compared as a tuple, which is an `OR`. The query builder ignores its expression-callback form
      of `where` outright and drops the bound values from a raw fragment on Postgres, so rather than
      hand out a cursor that repeats rows, those two sorts answer one page and return no cursor.
      The fail-open half is fixed upstream (`where` now throws instead of ignoring); the raw
      fragment still needs doing.
- [x] `CreateIssueAction.ts`, `UpdateIssueAction.ts`, close and reopen (one `UpdateIssueStateAction`,
      because they are the same transition with a different argument and the rules live together)
- [x] `CommentOnIssueAction.ts`, `UpdateCommentAction.ts`, `DeleteCommentAction.ts`
- [x] `AssignIssueAction.ts`, `LabelIssueAction.ts`, `MilestoneIssueAction.ts`, `LockIssueAction.ts`
- [x] Bulk operations from the list view: close, reopen, add and remove a label, set a milestone.
      One form wraps the rows, so the checkboxes and the toolbar are the same submission with no
      client script holding them together. Each operation asks for the ability its single-issue
      version asks for, mapped in one place rather than per branch: a permission check written per
      branch is one that eventually gets missed on a branch. A selection with an unparseable entry
      is refused whole rather than narrowed, because acting on fewer issues than somebody chose is
      worse than telling them to try again. Assigning in bulk is still open - it needs a person
      picker, which the list has nowhere to put yet.
- [x] Permission checks: triage can label, assign, milestone, lock and close; write can edit others'
      issues; anyone with read can comment on a public repository. Every one of them is a named
      ability in `app/Permissions.ts` with a token scope beside it in `app/TokenScopes.ts`, which a
      test enforces, so a capability cannot ship without a way to grant it.

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
- [x] Closing keywords (`fixes #12`, `closes #12`, `resolves #12`) acted on when a pull request
      merges. Only issues in the same repository: whoever merges has permission here, and following
      a reference into another repository would let a merge quietly close an issue there. Only
      issues, and never the pull request's own number, because the numbering is shared and
      `fixes #7` inside pull request 7 would otherwise close it as though it were a report.
- [ ] The same, on push. Needs post-receive processing first: the receive-pack route streams git
      straight through and nothing walks the new commits, so there is nowhere yet to read a commit
      message from. That is the `ProcessPushJob` in [phase 2](./02-git-hosting.md).
- [x] Task lists that can be ticked directly from the rendered issue, on the body and on comments.
      The edit lands in the markdown source character for character - the rendered checkbox is a
      view of the document, not the document - so nothing else in somebody's writing moves. Each
      item is its own one-button form, because the page runs no client-side JavaScript and stx
      directives cannot reach inside already-rendered HTML. Anybody who can comment can tick a box:
      a checklist on a shared issue is a coordination device, and gating it behind write access
      turns it into a status report from the maintainers. Each tick carries the state its reader
      was looking at, so two people on one issue cannot silently undo each other.
- [x] Syntax-highlighted code fences, sharing the highlighter with the blob view. Literally the
      same one, so a snippet quoted in an issue and the file it came from are coloured alike: two
      highlighters disagreeing about what a keyword looks like is the sort of thing nobody reports
      and everybody notices.
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
- [x] `.../issue/[number].stx` - one issue, its body and its conversation. Singular, matching
      `/pull/12`: the plural path is the list. The timeline is a separate item below, and until it
      exists the page shows the body and comments rather than pretending to be a history.
- [x] `.../issues/new.stx` - title, body, labels and a milestone, with write and preview tabs.
      Preview is a round trip through the real renderer rather than a client-side approximation of
      it: what is previewed is exactly what gets published, which an approximation cannot promise.
      Assignees are deliberately absent - people assign after triage, and every field on this form
      is a field between somebody and reporting the bug.
- [x] `.../labels.stx`, `.../milestones.stx` - the label and milestone sets, each list doubling as
      its own editor. A separate edit page for a name and a colour is a page load spent on nothing.
      `ManageLabelAction` and `ManageMilestoneAction` carry create, update and delete together
      because the rule that matters is shared: a repository may not end up with two names that
      collide, and collide is more than equal.
- [ ] Components: `IssueThread`, `IssueListItem`, `LabelPill`, `TimelineEntry`. The markdown
      editor's write and preview tabs exist on the new-issue form and want lifting out once a
      second screen needs them. Rendered markdown is a `.markdown` block styled once in the layout
      rather than a component: a component cannot import the renderer, so the HTML is built in the
      view either way, and one stylesheet stops a README looking like two different things.
- [ ] Keyboard shortcuts on the list. People who live in issues navigate by keyboard.

## Templates

- [ ] Issue templates from `.github/ISSUE_TEMPLATE/` in the repository, both markdown and forms
- [ ] A chooser when more than one template exists
