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
- [x] Page the `updated` and `comments` sorts. Both tie constantly - a thousand issues with no
      comments all sort equal - so their cursor is the pair `(value, id)`, and the usual way to
      compare it is `col < v OR (col = v AND id < i)`. The `OR` is exactly what the query builder
      cannot be given: it rejects the expression-callback form of `where` and renders a raw fragment
      to text, dropping the bound values. So the `OR` is not written. `keysetPlan` in `listing.ts`
      splits the boundary along it into an ordered list of segments, each an `AND` of single-column
      comparisons, and the action runs them until the page is full - one query when the page falls
      inside a segment, two when it straddles a boundary, the same rows in the same order either
      way. It is the shape the relation filters already use here: resolve it in another query rather
      than reach for SQL the builder will quietly mangle. Nulls are the part that is easy to get
      wrong, because Postgres sorts them first on `DESC` and last on `ASC` and `updated_at` is null
      on every issue nobody has touched since opening it, so the plan walks that block explicitly.
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
- [x] A safe subset of raw HTML: `<details>`, `<summary>`, `<br>`, `<kbd>`, `<div align>`. Common in
      READMEs and previously shown as text. `app/Actions/Markdown/html.ts` is a real tokenizer
      following the spec's tag-open state, not a regex pass over the output: a regex has to be right
      about every way a browser can be made to see a tag and only has to be wrong once. The tag it
      emits is *built* from an allowlist rather than filtered, so an attribute nobody declared has no
      code path to the output and `onclick`, `style` and `id` need no rule of their own. The list
      grew past the five named here to what READMEs actually contain - the inline set, tables, lists,
      `<a>` and `<img>` through the same `safeUrl` a markdown link uses - and excludes headings on
      purpose, because their ids are namespaced and a raw `<h2 id>` would be the way around that.
      Balance is deliberately asymmetric: a close tag the document never opened is shown as text,
      which is what stops rendered markdown ending the container it sits in, and an element left
      open is closed at the end of the document, because by then it has already been emitted.
- [x] Autolink references: `#123` to an issue or pull request, `@handle` to a user, `owner/repo#123`
      across repositories, and bare commit SHAs
- [x] Closing keywords (`fixes #12`, `closes #12`, `resolves #12`) acted on when a pull request
      merges. Only issues in the same repository: whoever merges has permission here, and following
      a reference into another repository would let a merge quietly close an issue there. Only
      issues, and never the pull request's own number, because the numbering is shared and
      `fixes #7` inside pull request 7 would otherwise close it as though it were a report.
- [x] The same, on push. `ProcessPushJob` in [phase 2](./02-git-hosting.md) reads the messages of
      the commits a push introduced and acts on them on the same terms a merge does: this
      repository only, issues only. No actor is recorded, because a commit's author is free text
      that anybody can set and attributing a close to a local account on the strength of one would
      put words in somebody's mouth.
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
- [x] Emoji shortcodes, and `:+1:` style reactions. One table in
      `app/Actions/Markdown/emoji.ts` serves both, deliberately: if somebody can write `:rocket:` in
      a comment and press a `:rocket:` button underneath it, the two had better be the same rocket.
      The table is the set that turns up in commit messages and changelogs rather than the full
      eighteen hundred names, and a shortcode it does not know renders as the text somebody wrote,
      which is the right answer for `:shipit:`. Reactions are a fixed eight in a fixed order - a row
      that reorders itself as counts change is unreadable - stored one row per person per reaction
      with the unique index doing the work: pressing a button twice is somebody checking whether it
      worked, not somebody reacting twice. Anybody who can comment can react, because the feature
      exists to stop people writing "+1", and a locked conversation refuses both. Counted with a
      `GROUP BY` rather than a counter column, in one query for the whole page.
- [x] Mermaid diagrams. A fence tagged `mermaid` leaves the code path and becomes the escaped
      definition inside the element the drawing script looks for. The library is a static asset,
      vendored by `scripts/vendor-mermaid.ts` rather than loaded from a CDN: a self-hosted forge is
      often on a network with no route out, and on the ones that have one a CDN tag announces every
      reader of every issue to a third party. It is fetched only by a page that already contains a
      diagram, and every failure leaves the definition on screen, which is what a fence showed
      before this existed. The loader in the layout is the first script in the product, and it is
      the one thing that genuinely cannot be done on the server: mermaid is a layout engine.
- [x] Image and attachment upload, stored through the filesystem driver. A file picked next to the
      comment box is stored when the comment is submitted and its markdown appended to what was
      written - the page runs no client-side JavaScript, so there is no editor to insert a link into
      and this is the whole flow. `/api/repos/attachments` exists for the API and the CLI, which
      want the reference before they write the body that uses it. Two rules hold it up, and both are
      about the browser rather than the file: the content type is decided by reading the bytes
      rather than believing the upload, because an HTML document uploaded as `image/png` and later
      served as `image/png` is stored cross-site scripting; and only raster images are served
      inline, with `nosniff` on everything, because an SVG is a document that can carry script.
      Reading goes through an action rather than the static handler, because an attachment on a
      private repository's issue is exactly as private as the issue and an unguessable key is a name
      rather than a permission.
- [x] Tests aimed at escaping: raw HTML, `javascript:` URLs, nested markdown, and enormous inputs

## Timeline

- [x] `app/Models/TimelineEntry.ts` recording state changes, label changes, assignments, milestone
      changes and renames, merged with the comments into one sequence ordered by time. A comment and
      the label somebody added while writing it belong next to each other; two lists side by side
      make a reader reconstruct the order themselves. Entries stay out of the comments table: a
      comment is authored content that can be edited, an entry is a fact that happened and never
      changes, and merging them would mean one of the two lying about itself. Recording never fails
      the thing it describes - a lost entry costs a line of history, a thrown error would tell the
      caller their close did not happen when it did.
- [x] Cross references from another issue: writing `#12` in a body or a comment records an entry on
      both ends. Two kinds rather than one, because a single kind cannot say which direction a
      reader is looking along the link: `referenced` is the incoming half ("referenced this in #7"),
      which is the one that matters - somebody on issue 12 has no other way to discover that a pull
      request three weeks later exists because of it - and `mentioned` is the outgoing half, which
      earns its place when a reference is edited into a body long after it was written. Same
      repository only, for the same reason the closing keywords are: whoever wrote it has permission
      *here*, and a forge where anybody can append a line to any issue's history by opening an issue
      on a repository they control has a spam problem. Recorded once, so an edited body does not say
      it twice, which is what lets every write path call it without knowing whether the text is new.
- [x] The same from a commit message. Only the incoming half: a commit is not a subject with a
      timeline of its own, so there is nowhere for the outgoing entry to live and inventing one
      would mean a second history nobody opens. The short sha travels in `subject_text` rather than
      in `reference_number`, which only ever holds a number - `entrySentence` reads whichever is
      present, so a commit reference and an issue reference render as the same kind of line without
      the column having to hold two kinds of thing.

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
- [x] Components: `IssueThread`, `IssueListItem`, `LabelPill`, `TimelineEntry`, plus `ReactionBar`
      and `MarkdownEditor` - the editor's write and preview tabs, lifted out of the new-issue form
      once the comment box needed them. `IssueThread` is the one that will earn its keep: a pull
      request conversation *is* an issue conversation, and the second screen that needs it should
      get the same one rather than a copy that drifts. Everything arrives ready, because a component
      imports nothing: markdown is rendered by the view, reactions are summarised by the view, and
      what an event says comes from `app/Actions/Issue/timeline`. Rendered markdown stays a
      `.markdown` block styled once in the layout rather than a component, for the same reason - one
      stylesheet stops a README looking like two different things.
- [x] Keyboard shortcuts on the list: `j` and `k` move, `Enter` opens, `x` selects, `c` opens the
      new-issue form, `Esc` leaves a field. Progressive enhancement rather than a feature: the list
      works completely without it - every row is a link, Tab already walks them, the checkboxes are
      ordinary checkboxes - and moving focus is a DOM operation that stx reactivity has no way to
      express, so this and the diagram loader are the only two scripts in the product. Typing is
      checked on every key, because a shortcut that fires while somebody is filling in the bulk
      label box is not a shortcut.

## Templates

- [x] Issue templates from `.github/ISSUE_TEMPLATE/` in the repository, read at the default branch,
      so a template is versioned with the code and edited by a pull request like anything else -
      which is the whole appeal, and why they are not a table somebody has to keep in sync. Parsing
      is deliberately not a YAML parser: these files carry five scalar keys and a list of labels,
      and a parser brings opinions about anchors, tags and type coercion that have no business in a
      value that ends up in a form field. Nothing about a malformed template fails: the frontmatter
      is unreadable and the body still opens an issue, the name falls back to the filename, and the
      single-file `.github/ISSUE_TEMPLATE.md` form still works for projects that never made a
      directory. Labels a template asks for arrive ticked, because a maintainer writing
      `labels: bug` is saying where the report belongs and making the reporter tick it again is
      asking them to guess.
- [x] A chooser when more than one template exists, and only then: one template is *the* template,
      so the form opens with it filled in rather than asking a question with one answer. A blank
      issue is always offered and always last - a repository that ships three templates has still
      not thought of everything, and a reporter with nowhere to put what they found writes nothing.
      Both of these were written before and had never run: the form read `query.template`, and there
      is no bare `query` in a server script, so stx caught the throw and fell back to static
      extraction and the page rendered its not-found branch with nothing in the log. Now through
      `useRoute()`. `milestones.stx` and both list views had the same bug - the state filter on
      `/issues` and `/pulls` had never worked - and are fixed with it.
