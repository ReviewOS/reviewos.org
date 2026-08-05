# 14 - The diff engine

Phase 4 is the reason this project exists, and the diff surface is the reason phase 4 exists. This
phase is about the surface itself: how a patch gets from a bare repository into a reader's eye
without a spinner, a hung tab, or a scroll that stutters.

It is written against a specific competitor, because there is one and pretending otherwise would
cost us the benchmark. [Pierre](https://pierre.computer) publishes `@pierre/diffs`, `@pierre/trees`,
`@pierre/theming` and `@pierre/theme` (all Apache 2.0, all on npm) and ships them in
[DiffsHub](https://diffshub.com), a viewer that renders any public GitHub diff by swapping the
hostname:

```
- github.com/org/repo/pull/1234
+ diffshub.com/org/repo/pull/1234
```

Their own landing page invites you to open `torvalds/linux/compare/v6.0...v7.0`, notes that it
sometimes crashes mobile browsers, and observes that GitHub itself serves diffs over 100k lines
unreliably with a delayed first byte. That is the bar, stated by the people who set it.

## Where we actually stand

Worth writing down plainly, because the gap is the plan.

Today ReviewOS renders a diff as a server-rendered HTML table, one `<tr>` per line, highlighted by
`ts-syntax-highlighter` in `app/Actions/Browse/highlight.ts`, assembled in `DiffView.stx`, sent
whole. That decision is defended on the marketing site
(`resources/views/features/fast-diffs.stx`) and it is genuinely right for the common case: a
fifteen-file pull request arrives ready to read with no JavaScript involved and no diff library
downloaded.

It has exactly one failure mode, and it is total. There is no threshold above which the page
degrades gracefully. A 100k line diff is 100k table rows in one document, so the browser lays out
all of it, paints all of it, and holds all of it. `torvalds/linux/compare/v6.0...v7.0` would not
render at all. DiffsHub renders it.

So this phase is not "make the table faster". It is: keep the server-rendered first screen, and put
a virtualized, streamed, worker-highlighted engine underneath it for everything past the fold.

## The standard to hold

Numbers, so the work can be checked rather than argued about:

- [ ] `v6.0...v7.0` of Linux (millions of lines) opens, scrolls smoothly to the end, and does not
      exhaust memory on a laptop
- [ ] First diff line painted before the patch has finished downloading, on every diff, at every size
- [ ] Scroll at 60fps through a 30k line diff with syntax highlighting on, measured with the
      harness below rather than by feel
- [ ] Memory after scrolling a 500k line diff end to end settles back near where it started, because
      rows are recycled and the raw patch text is not retained
- [ ] Mobile Safari renders the bun and node pull requests DiffsHub uses as demos without blanking
- [ ] No regression for the small case: a fifteen-file pull request must still be readable with
      JavaScript disabled

## The decision that comes first

- [x] **Decide: adopt `@pierre/diffs` or build the engine in-house.** Everything below is written for
      the in-house path, and every item is still useful as a review checklist for the adopt path.
      This is a product decision, not a technical one, and it should be made deliberately rather
      than by drifting.

  The honest case for adopting: it is Apache 2.0, on npm at `@pierre/diffs@1.3.x`, has a vanilla
  class API (`new CodeView(options, workerPool)` / `viewer.setup(root)`) that needs no React, ships
  an SSR entry (`preloadFileDiff`, `preloadDiffHTML`) that fits our server-rendered-first-screen
  rule exactly, and represents roughly 53k lines of solved problems including several browser bugs
  we have not hit yet. `@pierre/trees` even registers as a web component, which drops into stx
  cleanly.

  The honest case against: the review surface is the entire product, and this hands its release
  cadence to a competitor. It also brings Shiki and a WASM or JS grammar engine into the browser,
  which reverses the "the client does not download a highlighter" property that phase 2 already
  landed and that the marketing site sells.

  Recommendation: **build in-house, and use `@pierre/diffs` as the reference implementation and the
  perf baseline.** Stand DiffsHub up locally, run the benchmark harness against it, and hold our own
  numbers against theirs. Reading Apache 2.0 source to learn a technique is fine; copying it wholesale
  is a licence obligation and a different decision.

- [ ] If adopting instead: record the decision here, delete the sections that no longer apply, and
      keep the benchmark harness regardless. The harness is valuable either way.

**Decided: build in-house, no dependencies.** Recorded 2026-08-05. The rest of this file is the
build.

## The decision that follows from it: the server parses, not the browser

Worth stating before any code, because it is where we deliberately diverge from Pierre and the
divergence is the whole point.

DiffsHub ships the raw patch to the browser and parses it there. It has to: it is a static site with
no backend, so the browser is the only machine it has. That choice is why their own landing page says
the Linux `v6.0...v7.0` compare "sometimes crashes mobile browsers". A gigabyte of patch text plus
parsed metadata plus rendered DOM will not fit on a phone, and no amount of virtualization fixes
holding the input.

We have a server, and phase 2 already established that the client does not download a highlighter.
So:

- [x] **The server parses the patch once** and streams a *manifest*: one small JSON object per file
      with path, status, counts, hunk ranges, row counts and estimated heights. Roughly 200 bytes a
      file, so a 40,000 file compare is single-digit megabytes and the browser can lay out the whole
      list immediately.
- [x] **The browser never sees the raw patch.** It holds the manifest and the rows currently mounted.
      Memory is a function of the viewport, not of the diff.
- [x] **Rows arrive as rendered, highlighted HTML**, in one of two modes chosen by a size threshold:
  - [x] *inline*, for anything under the threshold (which is very nearly every pull request): the
        rows stream down with the manifest and the browser mounts from an in-memory map with no
        further requests
  - [x] *on demand*, above it: the virtualizer requests row batches ahead of the scroll position,
        served from a parsed diff cached by (repository, base sha, head sha)
- [x] The threshold is measured, not guessed, and the mode is visible in the response so the
      benchmark harness can pin it

The cost is honest and worth naming: in on-demand mode, throwing the scrollbar to the far end shows
placeholders for one round trip where DiffsHub would show content. In exchange the phone renders the
Linux compare at all, and nothing about the page gets slower as the diff gets bigger.

---

## What it measures, so far

Against the real `stacksjs/stacks` bare repository in `storage/repos/`, on this laptop. Not the
benchmark harness below - that is still to build, and these come from a script rather than from
Chrome traces - but they are numbers rather than feelings, and they are the baseline the harness
inherits.

`v0.70.230...v0.70.231`, 100 files, 1,662 changed lines:

| | manifest only | with rows inline |
|---|---|---|
| first record on the wire | 72ms | 26ms |
| complete | 77ms | 65ms |
| sent to the browser | 21KB | 1.3MB |
| per file | 207 bytes | 12.8KB |

`v0.70.0...v0.70.231`, 5,722 files, 810,481 changed lines:

| | today's path (buffer, then parse) | the manifest |
|---|---|---|
| first useful output | 606ms | 85ms |
| complete | 606ms | 610ms |
| server heap | 134MB | 81MB |
| the browser receives | 34MB of patch, as 810k table rows | 9MB, of which 8MB is the first 89 files' rows |

The row budget stopped at file 89 and said so, and the remaining 5,633 file records kept flowing at
full speed, which is the behaviour the two-mode design exists for: the scrollbar is correct for all
5,722 files half a second in, whatever is or is not rendered yet.

The 207 bytes a file is the number the whole architecture rests on and it came out where the plan
guessed it would. A 40,000 file compare is therefore about 8MB of manifest, which a phone can hold.

Two things these numbers do not yet show, both deliberately:

- [ ] The same measurements from the browser rather than from a script: paint, scroll, and memory
      after a full scroll, which is what the harness below is for
- [ ] A corpus larger than this repository can provide. `stacks` at 5,722 files is a tenth of the
      Linux compare DiffsHub uses as its demo.

### The last mile, as it actually went

Wiring the view took three silent failures and one loud one, all found by loading the page rather
than by reasoning about it. Recorded because each is the kind that leaves no trace:

- **A relative import in a `<script client>` block resolves against the layout, not the page.** The
  block is composed into `resources/views/layouts/app.stx` before it is bundled, so
  `../../../../../functions/diffviewer` pointed outside the project. The bundler said so only with
  `STX_DEBUG=1`; without it the block was emitted as a classic script and the browser said
  "Cannot use import statement outside a module", which names nothing. Use `@/resources/functions/…`,
  which does not depend on where the block ends up.
- **The wire calls a file's position `i` and the client type called it `index`**, so every lookup
  keyed on it missed and every file rendered its placeholder forever. The header and the counts came
  through, because those field names happen to match, which is what made it look like a rendering
  problem rather than a naming one.
- **A file is mounted before its rows arrive.** The record comes first and is laid out immediately;
  the markup follows. Without a way to re-render a mounted file, the placeholder is permanent.
- **The status line is outside the scroll region**, so looking for it inside the viewer's own element
  found nothing.

## Transport: move the patch before it is complete

The single largest perceived-speed win, and it comes before any rendering work. DiffsHub streams the
patch from GitHub and appends files to the viewer as they arrive; the reader is scrolling the first
file while the last one is still on the wire.

- [x] `git diff` output is streamed out of the child process rather than buffered. `app/Actions/Git/`
      already spawns plumbing; the diff path must not call `.text()` on the whole thing.
- [x] A route that streams to the browser while git is still writing, with the request abortable.
      Cancelling a navigation kills the upstream `git` process rather than orphaning it.
      (`DiffManifestAction`. Streams the manifest rather than the patch, per the decision above.)
- [x] Deliberately **not** cached in the browser. A cached 100MB response replays badly and delays
      the first useful byte more than refetching does. `Cache-Control: no-store` on diff bodies, and
      cache the parsed artefacts server-side instead if caching is wanted.
- [x] A stream parser that splits on `\ndiff --git ` and hands out one complete file at a time,
      buffering only the current file. The boundary scan keeps an overlap of `len - 1` characters so a
      marker split across two chunks is still found.
- [ ] `From <sha>` commit-metadata boundaries inside a mailbox-format patch are respected, so a
      multi-commit patch splits per file rather than swallowing the next commit's header
- [x] A fallback for input that never produced a `diff --git` boundary: parse the whole buffer once at
      the end rather than showing nothing
- [x] Tests: a boundary split across chunk edges, a patch with no boundary at all, a file whose
      content contains the literal string `diff --git`, and an aborted stream mid-file

## Publishing: batch against a clock and a work budget

Appending each file as it parses is as bad as waiting for all of them: the main thread never yields
and the page is unresponsive for the whole download. DiffsHub's numbers, worth starting from and then
measuring:

- [ ] First batch sized to the viewport (`ceil(viewportHeight / rowHeight)`, clamped to 25..96) so the
      first paint fills the screen exactly once, then 25 files per batch after that
- [ ] Publish when the batch is full **or** 100ms has passed (500ms for the very first batch, which
      buys a fuller first screen)
- [ ] An 8ms work budget: if parsing has held the thread that long, yield before continuing, even
      mid-batch
- [ ] Yield via `requestAnimationFrame` with a `setTimeout` race behind it, so a backgrounded tab
      still makes progress
- [ ] The file tree publishes on its own slower schedule (every 1,000 files or 1,000ms) because a
      tree rebuild is expensive and nobody is reading it during the stream
- [x] Every published batch is guarded by a request id, so a navigation mid-stream cannot append
      files from the previous diff into the new viewer

## Parsing: let go of the text

- [x] Parse a unified diff into per-file metadata: hunks, old and new ranges, line origins, change
      type (changed, added, deleted, renamed), rename similarity, mode changes, binary markers
- [x] **Detach retained strings from the raw patch.** A substring in V8 keeps its parent alive, so
      100k line strings sliced out of a 200MB patch retain the whole 200MB. Force a fresh backing
      string per retained line (encode/decode through a reused `Uint8Array` scratch buffer, with a
      JSON round trip for the lone-surrogate case that `TextEncoder` would corrupt), and release the
      scratch buffer after a parsing run so one pathological line does not pin its peak allocation.
- [ ] Line-ending detection per file, and a `\ No newline at end of file` marker rendered as itself
- [ ] Partial diff metadata: a file can exist in the list, with correct estimated height, before its
      contents have been loaded. A loader fills them in on demand.
- [ ] Tests against the shapes that break parsers: a rename with no content change, a mode-only
      change, mixed CRLF and LF in one file, a file with no trailing newline, a filename containing a
      quote or a newline, a 5,000 line single-file diff

## Virtualization: the list is the product

This is the core of it. One scroll region contains every file; only what is near the viewport exists
in the DOM.

- [ ] A viewer that owns a list of items (a file diff or a plain file), each with a stable id and a
      `version` that increments when anything about it changes. Item identity plus version is what
      decides whether a mounted item needs re-rendering.
- [x] Estimated heights computed from hunk metadata alone, without rendering: header height, line
      height, hunk separator height, collapsed-context threshold, and whether the item is collapsed.
      A list of 40,000 files needs a total height before any of them has been measured.
- [x] Real heights replace estimates as items mount, and the layout reconciles without moving the
      content under the reader's cursor
- [x] Scroll anchoring: pin to the visible file (and the line within it) across a layout change, a
      collapse, a hunk expansion, or a theme switch. Nothing the reader did not ask for may move.
- [x] Overscan around the viewport (start at 1,000px; Pierre's comment says 800 is the minimum that
      stops Safari blanking) plus an `IntersectionObserver` with a much larger margin to decide
      visibility ahead of time
- [x] Element pooling: rows and their child nodes are recycled rather than created and destroyed.
      A cleanup path that can recycle instead of discarding is the difference between steady memory
      and a sawtooth.
- [ ] Sparse layout checkpoints inside a very long single file, so seeking to line 400,000 does not
      walk 400,000 line heights
- [x] Batched read/write render passes: all measurement, then all mutation, never interleaved. Every
      synchronous layout read outside that pass is a bug and should be findable by name.
- [x] `contain: strict` on the scroll container and `contain: layout paint style` on each file, so
      one file's layout cannot invalidate the list
- [x] `overflow-anchor: none`, because the browser's own scroll anchoring fights ours
- [x] Snap computed scroll targets to the device pixel grid (`round(v * dpr) / dpr`), read fresh each
      time so switching monitors or zooming is picked up. Fractional-DPR displays otherwise leave
      scroll deltas hovering on residuals that never settle.
- [ ] Measure the scrollbar gutter once per page with a hidden probe carrying the same selector as a
      real code pane, so custom scrollbar CSS is reflected and the split columns do not disagree
      about their width
- [ ] Sticky file headers, with the "stuck" shadow driven by `container-type: scroll-state` rather
      than a scroll listener
- [ ] Scroll targets by position, item, line, and line range, each with start/center/end alignment
      and instant/smooth behaviour, honouring `prefers-reduced-motion`
- [ ] A WebKit guard for the bulk-subtree-rewrite bug,
      [webkit 308027](https://bugs.webkit.org/show_bug.cgi?id=308027):
      rewriting the subtree of a `container-type: inline-size` element in bulk makes Safari clamp the
      ancestor scroller to 0. Pin `min-height` across the rebuild, force one layout read while pinned,
      then unpin. Gate it to Safari only, because it costs two synchronous layouts.
- [ ] Tests: strict-mode double mount, a reconcile queue that receives updates mid-render, item
      removal while off-screen, an item id changing (a rename arriving late in a stream), and a
      collapse of an item above the current scroll position

## Highlighting: off the main thread

- [ ] A worker pool that tokenizes files and diffs and posts back a syntax tree, with the pool size
      derived from `navigator.hardwareConcurrency` and a sane cap
- [ ] Per-instance task cancellation: scrolling past a file that has not been highlighted yet must
      drop its queued work, not let it complete
- [ ] An LRU cache of highlighted results keyed by file cache key **and theme**, so scrolling back up
      and switching themes are both free
- [ ] Plain-text fallback: over a tokenization ceiling (start at 100,000 characters) a file renders
      unhighlighted rather than blocking. The reader gets the diff; the colours are the optional part.
- [ ] Lazy language resolution and lazy theme resolution, cached, with the set attached to the shared
      highlighter only once
- [ ] Priming: highlight the first screen before it is scrolled to, so the first paint is not plain
      text that recolours a moment later
- [ ] A worker stats subscription (pool state, queued, active, cache sizes) so the benchmark harness
      and a debug panel can tell "still working" from "idle"
- [ ] **The server-side path stays.** The first screen is highlighted server-side and arrives as HTML;
      the worker pool takes over from the second screen down. One token palette shared between them,
      as phase 2 already requires, so the handover is invisible.

The highlighter itself is `ts-syntax-highlighter`, which is ours. It gets its own section, because
"keep ours" is only the right answer if the gaps below close.

## Fix the highlighter, do not work around it

`ts-syntax-highlighter` lives at `~/Code/Libraries/ts-syntax-highlighter` (MIT, zero runtime
dependencies, 49 grammars, `Tokenizer` + `FastTokenizer` + `Renderer` + `dual-theme` + `profiler` +
a `benchmarks` package). Every fix below belongs **there**, released, and picked up here. A patch in
`app/Actions/Browse/highlight.ts` that papers over a tokenizer bug hides it from every other project
that has it, and this one is published.

The strategic point: if these close, we ship a zero-dependency highlighter that works identically on
the Bun server and in a browser worker, and we never have to put Shiki in the client. That is a real
advantage over Pierre, who carry Shiki plus a grammar engine into every page. If they do not close,
the honest answer is Shiki and we should say so rather than shipping something slower and worse.

### What landed, and what it turned up

Recorded because two of these were bugs nobody had noticed, and both would have made a diff
viewer built on this library visibly wrong.

- Lazy grammar catalog (`src/lazy.ts`, generated `src/grammars/catalog.ts`), so resolving a
  language or loading one grammar no longer pulls all forty eight.
- A serializable `TokenizerState`, `tokenizeLinesFrom`, and `checkpoints`, which is what lets a hunk
  starting at line four hundred know it is inside a block comment.
- `streaming.ts` finished. It was returning the source text unchanged.
- **The main `Tokenizer` dropped whitespace.** `const a = 1` came back as `consta=1`, and since the
  renderer joins token contents with no separator, `highlight()` produced code with every space and
  every indent removed. The `FastTokenizer` had been fixed for this already (`3aab122`); the main
  one was missed, and had no test asserting the property. It has one now, across all forty eight
  grammars.
- **Multi-line block comments were not handled at all.** `/*` with no closing `*/` on the same line
  fell through a fast path that claimed it would "fall through to patterns for proper multiline
  handling" and never reached them, so `/*` tokenized as two operators and the body of every licence
  header highlighted as though it were a program.

Released as `ts-syntax-highlighter@0.2.7`. This app's `^0.2.6` range picks it up once CI publishes.

### The blocker: grammars are not lazily loadable

- [x] `grammars/index.ts` statically imports all 49 grammars, so importing the package pulls every
      one of them. In a browser worker that is the whole bundle to highlight one TypeScript file.
      Add a lazy registry: a map of language id to `() => import('./grammars/rust')`, resolved and
      cached on demand, with the eager barrel kept as a separate entry for server use.
- [ ] Measure the gzipped worker bundle with one language loaded, and with ten. That number decides
      whether the browser path is viable at all.

### The blocker: a diff hunk is not a whole file

A hunk starts at line 400 of a file we may not have. Tokenizing it from a cold state gets string and
comment nesting wrong, and the failure is silent and ugly: half a file rendered as one string.

- [x] `tokenizeLine(line, n, prevStack)` and `getScopeStack()` already exist and are the right shape.
      Make the scope stack a documented, serializable public value, so it can be saved per line,
      posted to a worker, and resumed.
- [ ] Tokenize a diff by resuming from the scope stack at the hunk's first line when the full file is
      available (blob expansion gives us this)
- [x] When it is not available, degrade explicitly: a documented "fragment mode" that resets state at
      the hunk boundary and is allowed to be wrong about multi-line constructs, rather than being
      quietly wrong
- [x] Checkpoint scope stacks every N lines within a file, so seeking into the middle of a large file
      does not re-tokenize from line 1
- [x] Tests: a hunk that begins inside a block comment, inside a template literal, and inside a JSX
      expression

### The blocker: `streaming.ts` does not highlight

- [x] `highlightStream` currently ignores the theme (`const _theme = ...`) and yields
      `tokens.map(t => t.content).join('')`, which is the source text unchanged. It is a stub with a
      published API. Either finish it against the renderer or remove it; shipping it as-is means
      anyone who reaches for the obvious function for large files gets no highlighting and no error.
- [x] `BatchHighlighter` shares the same tokenizer instance and threads `prevStack` correctly, which
      is the right shape. Make it the basis of the finished streaming path.

### Worker and output shape

- [ ] A worker entry in the package, so consumers do not each write their own. Initialize with a
      language set and a theme; receive lines or a file; post back tokens.
- [ ] Token output that survives structured clone cheaply. An object per token
      (`{ type, content }`) allocates hard on a 100k line file. Offer a flat representation: one
      string per line plus parallel typed arrays of offsets and token-class ids, with the current
      object API kept as a convenience wrapper.
- [ ] Cancellation: a queued tokenize request must be droppable when the reader scrolls past it

### Themes

- [ ] Three themes ship today (`github-dark`, `github-light`, `nord`). Pierre ship ten first-party
      plus everything Shiki bundles, and their theme picker is a visible product feature.
- [ ] **Import VS Code / TextMate / Shiki theme JSON.** `export-textmate.ts` already goes one way;
      the inverse is the higher-value direction, because it makes every theme anyone has ever
      published work with zero grammar work on our side. This is the single change that closes the
      theme gap in one move.
- [ ] Colour-vision-deficiency variants (red-green and blue-yellow) as first-party themes, and a
      high-contrast pair
- [ ] A theme normalizer that also yields UI chrome colours (background, foreground, border, muted,
      selection) so the app around the code can be coloured from the same file, which is what makes
      a themed page look like one surface

### Correctness and grammars

- [x] **A property test, across all 49 grammars and a real corpus: the concatenated token contents
      must equal the input line exactly.** `app/Actions/Browse/highlight.ts` already states this as
      the one property everything depends on, and in a diff a dropped space can be the entire change.
      That property deserves a test in the library, not a comment in the consumer.
- [ ] Work through the 17 `.todo()` edge cases in the library's `TODO.md`. The variable-highlighting
      set (bash, php, powershell, scss, dockerfile) is the highest value: those five languages are
      thick with `$VAR`, and they are common in real pull requests.
- [ ] Languages a forge sees constantly and should be checked for coverage: `.stx`, `.blade.php`,
      `Dockerfile` variants, `.tf`, `.proto`, `.prisma`, `.zig`, `.sql`, `.toml`, `.ini`, `.env`,
      lockfile formats, and `.patch` itself
- [ ] Filename-first language detection (extension, then full filename, then shebang, then content),
      with a per-repository override, because guessing wrong is more distracting than not colouring

### Performance work in the library

- [ ] Throughput benchmarks in MB/s per language in the `benchmarks` package, tracked over time and
      run in CI, so a grammar change that halves throughput is visible
- [ ] A tokenize ceiling with an explicit plain-text result inside the library, so every consumer
      gets the same fallback rather than each inventing one
- [ ] Profile `Tokenizer` against `FastTokenizer` on the corpus and decide when each is used
      automatically, rather than making the caller choose
- [ ] Reuse the `Uint8Array` character-class table approach from `FastTokenizer` in the main
      tokenizer where scope tracking allows it
- [ ] Line results are cached by (line text, language, incoming scope stack). A diff repeats context
      lines between hunks and between the two sides of a split view constantly.

## The diff surface

Everything a reader can turn on. DiffsHub exposes all of these; several we already have.

- [ ] Split and unified layouts. `DiffView.stx` renders unified only today, despite phase 4 listing
      both, so this is not a refinement of something that exists.
- [ ] Split columns scroll-synced horizontally
- [ ] Word-level and character-level highlighting inside changed lines, as a setting, not only word
- [ ] Diff indicators as a choice: classic `+`/`-` glyphs, a colour bar, or none
- [ ] Line numbers toggleable, and both sides' numbers always present in split
- [ ] Change backgrounds toggleable, for readers who find the wash of colour harder to read
- [ ] Word wrap toggleable, per reader, remembered. Long lines scroll within their own file when wrap
      is off, which we already do.
- [ ] Collapse and expand a single file, and collapse or expand all files, without losing scroll
      position
- [ ] Hunk separators that say what was skipped and how much
- [ ] Deleted files collapsed by default
- [ ] Every one of these settings persists per reader and survives a reload

## Hunk expansion and partial diffs

- [ ] Expand hidden context above or below a hunk, in both directions, by a fixed count or all the way
- [ ] Expansion fetches the surrounding lines on demand from the blob rather than shipping full file
      contents with the diff
- [ ] `revealLine(n)`: expand whatever context is needed to bring a line into view, used by deep links
      and by jumping to a review thread anchored on a context line
- [ ] Estimated height accounts for expansions already applied, so expanding does not shift everything
      below by a wrong amount and then correct itself
- [x] Files loaded on demand: a diff item can be listed and sized before its content exists

## Review threads in the diff

Pierre's annotation framework injects arbitrary rows into the grid; ours has to carry real review
threads, which is where our version has to be better rather than equal.

- [x] Annotation rows injected at a (file, side, line), measured like any other row so the
      virtualizer's height math includes them
- [ ] A gutter affordance on hover that starts a comment on that line, and a drag across the gutter
      that starts one on a range
- [ ] A draft comment is a row in the diff, not a modal. Only one draft open at a time across the
      whole list.
- [ ] Threads render collapsed to one line once resolved, expandable in place
- [x] Outdated threads render on the line they were written against, marked, rather than being
      dropped (phase 4 already anchors them; this is the rendering half)
- [ ] Draft reviews survive reload and machine change (phase 4 owns the persistence; this owns
      restoring them into the right rows)
- [ ] Annotation rows are part of the pooling story: they must recycle too, or a heavily-commented
      diff leaks

## One renderer, and what converging onto it found

`DiffView.stx` and `ReviewThread.stx` are gone. Both screens render through `app/Actions/Pull/rows.ts`
and `threads.ts`, and their styles live in the layout, because a stylesheet inside a component only
reaches the pages that use the component.

Converging them turned up a bug that had nothing to do with rendering. Both pull request views
resolved a repository **by name alone**, so two owners with a repository of the same name got
whichever row was created first. The demo data has exactly that, and the review screen had been
reporting "no changes against main": it found the other owner's pull request and diffed its shas
against a repository those commits are not in. Reporting nothing is the mild version - the same
lookup renders one owner's pull request under another owner's URL, and nothing says the row it lands
on has to be public. `findRepositoryByPath` already did it correctly and the issue and commits views
already used it.

- [x] Audit every other direct `repositories` query for the same shape. Six places resolved a
      repository by hand and **none of them checked visibility**, so a private repository's pull
      requests, issues, commits and code rendered to anyone with the URL, with the word `private`
      printed beside the name. `authorizeRepository` could not be used because it needs a `request`
      and an stx server script has none; `app/Actions/Repo/forView.ts` is the same decision reading
      the viewer from cookies instead, and every view and component now goes through it.
- [x] While pinning that rule down: `canOnRepository` **granted** an ability it did not recognise.
      `repositoryRank` returns -1 for an unknown level and every real permission outranks -1, so a
      misspelled ability read as allowed to anybody holding anything. Found by writing
      `repository:write` in a test, where the real ability is `repository:push`, in a directory the
      typechecker does not cover. Both ladders now refuse what they cannot interpret.

## Selection and deep links

- [ ] Click a line number to select it, shift-click or drag to select a range, across sides in split
- [ ] The selection writes to the URL hash and the hash restores the selection on load, including
      expanding a collapsed file and revealing collapsed context to reach it
- [ ] Restoring from a hash mid-stream: the target file may not have arrived yet, so the attempt
      repeats as batches land and stops once it succeeds
- [ ] `hashchange` is honoured, so an in-page link between two threads works
- [ ] A selection action surface (copy permalink, comment on selection, copy lines) anchored to the
      selection

## The file tree

- [ ] A virtualized tree beside the diff, driven by a path store that keeps numeric ids internal and
      canonical slash-delimited paths at its boundary
- [ ] Slice-first reads: `getVisibleCount()` and `getVisibleSlice(start, end)` are the fast path, and
      the full list is never materialized to render a screenful
- [ ] Prepared input for presorted paths, so a 40,000 path tree is built once rather than sorted on
      every rebuild during a stream
- [ ] Empty directories flattened in the projection only, never in the canonical topology
- [ ] Sticky ancestor folders while scrolling, so the reader always knows where they are
- [ ] Per-file change decoration (added, modified, deleted, renamed) with counts
- [ ] Search over the tree, opt-in so it takes no vertical space until asked for
- [ ] Selecting a file scrolls the viewer to it, expanding it if collapsed
- [ ] The tree is a separate state tree from the diff items, so a comment landing does not rebuild it
- [ ] Viewed state per file, checkable from the tree, persisted across visits (this is the phase 4
      item; the tree is where it belongs in the interface)
- [ ] A mobile presentation: an overlay rather than a column

## Theming

- [ ] Light and dark theme pair, chosen independently, plus a system mode
- [ ] Theme selection persists and is applied before first paint, with no flash of the default palette
      and no tokenizing the first batch against the wrong colours
- [ ] Switching theme re-colours from cache rather than re-tokenizing
- [ ] The chrome around the diff (sidebar, header, dropdowns) derives its colours from the same theme,
      so the page is one surface rather than a code pane pasted into an app
- [ ] Colour-vision-deficiency variants: a red-green (protanopia/deuteranopia) and a blue-yellow
      (tritanopia) pair, where the add/remove distinction does not rest on hue alone. Pierre ships
      four such themes; a diff viewer that only distinguishes changes by red and green is failing
      roughly one in twelve male readers.
- [ ] Diff add/remove colours are legible against every shipped theme, checked rather than assumed

## Merge conflicts

Adjacent, and it falls out of the same renderer.

- [ ] Parse conflict markers (`<<<<<<<`, `|||||||`, `=======`, `>>>>>>>`) into regions
- [ ] Render a conflicted file with each region marked and its sides distinguished
- [ ] Accept current, accept incoming, or accept both, per region
- [ ] Tests: nested markers, a marker appearing inside a string literal, a diff3-style conflict with
      a base section

## A public diff viewer as a front door

DiffsHub exists because a URL swap is a lower-friction pitch than a migration. Phase 13 makes the same
argument for mirroring. The same argument makes this worth doing.

- [ ] A route that renders any public GitHub pull request, commit, compare, `.diff` or `.patch` URL,
      reachable by swapping the hostname
- [ ] Path canonicalization: `/pull/123/files` and `/pull/123.diff` both resolve to the same viewer
      URL, with a redirect so links are stable
- [ ] An optional fine-grained personal access token, stored in `localStorage` only, never sent to our
      server except as a `Bearer` header on the proxy request, used for private diffs and for
      expanding collapsed context
- [ ] The proxy tries the public URL first, then the authenticated web URL, then the API, and reports
      **why** access failed: token expired, SSO not authorized, repository not selected on the
      fine-grained token, pull request not readable. A bare 404 sends someone to guess.
- [ ] Rate limiting and an allowlist of upstream hosts, because this is a fetcher pointed at the
      internet
- [ ] Decide whether this ships on the marketing domain or the app, and whether it advertises
      ReviewOS or is quiet about it

## The benchmark harness

Without this, every claim in this file is a feeling. Pierre wrote a runbook for exactly this
(`packages/diffs/benchmarks/CSS_PERFORMANCE_BENCHMARK.md`); ours should be equivalent and live in the
repository.

- [ ] Two git worktrees at two shas, both built in production mode, both served, so a change is
      measured against its own baseline rather than against a memory
- [ ] A deterministic scroll driver: a fixed `scrollTop` sequence over a fixed duration, applied to
      the real scroll element, asserting the position after each step and returning a checksum. Never
      dispatch synthetic `scroll` events; they do not move browser scroll state.
- [ ] A stable-page precondition checked before recording: the scroller exists, streaming has
      finished, and the worker pool is idle
- [ ] Chrome traces via CDP with the renderer-main categories, one unrecorded warmup per sha, then at
      least three kept runs, alternating base and test so machine drift does not land on one side
- [ ] An analysis script summarizing `UpdateLayoutTree`, `Layout`, and the paint/composite group per
      run, with average, median, min and max
- [ ] Two modes: highlighting stubbed out (for CSS and layout work, where token spans are noise) and
      full production (for anything else). Never mix modes or browser headedness within a comparison.
- [ ] A fixed corpus of test diffs committed or hosted: a 15 file pull request, a 5k line diff, a 30k
      line diff, and the Linux `v6.0...v7.0` compare. Host the large ones ourselves rather than
      hammering GitHub, which is what Pierre does for their demo links.
- [ ] Results recorded per change with the sha, route, viewport, mode, and run count, so "this got
      slower" is answerable
- [ ] A memory profile alongside the scroll trace: heap after load, after a full scroll, and after a
      forced GC

## Tests

Beyond the per-section tests above, the shapes that catch virtualizer bugs specifically:

- [ ] Partial hydration: server HTML for the first screen, hydrated into the viewer without a reflow
      or a re-render of what is already correct
- [ ] Element pooling actually reuses nodes, asserted by identity rather than by count
- [ ] Scroll anchoring across collapse, expand, theme change, and wrap toggle
- [ ] Estimated heights within a tolerance of measured heights across the corpus, so the scrollbar
      does not lie
- [ ] Range scroll to a line inside a collapsed hunk in a collapsed file
- [ ] A stream that is aborted, retried, and completes, leaving no items from the first attempt
- [ ] Worker pool: a task cancelled mid-flight, a worker that dies, and a theme change with tasks
      queued
- [ ] The no-JavaScript path still renders the first screen and its threads

## Deliberately not doing yet

- **An in-diff text editor.** `@pierre/diffs/edit` ships a piece-table editor, undo stack, bracket
  matching, search panel, markers and IndexedDB state persistence inside the diff. It is impressive
  and it is a second product. Suggested changes (phase 4) cover the review case with a textarea.
- **Token-by-token progressive rendering.** Recolouring a file as its bytes arrive, the way a
  terminal pager does. The worker pool plus the plain-text fallback covers the case at less cost.
  This is not the same as finishing `streaming.ts`, which is chunked whole-line tokenization and is
  required.
- **Our own theme format.** Import VS Code / TextMate theme JSON, which every editor already
  exports. Do not invent a third format.
