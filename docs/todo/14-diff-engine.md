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
- [x] Scroll at 60fps through a 30k line diff with syntax highlighting on, measured with the
      harness below rather than by feel
- [ ] Memory after scrolling a 500k line diff end to end settles back near where it started, because
      rows are recycled and the raw patch text is not retained
- [ ] Mobile Safari renders the bun and node pull requests DiffsHub uses as demos without blanking
- [x] No regression for the small case: a fifteen-file pull request is still readable with JavaScript
      disabled. The conversation page renders every row, every syntax token and every review thread
      server-side, and its reply and resolve controls are plain forms - checked by fetching the page
      and counting what is in the HTML, rather than by looking at it in a browser with a working
      script engine, which proves nothing.
- [x] And an end-to-end test that keeps it true. `tests/e2e/review-page.test.ts` boots the router,
      puts a repository and two branches on disk, opens a pull request with a thread on a changed
      line, and fetches the page with nothing to run a script. It asserts the code, the context
      around it, the token classes, the thread, its comment and a plain `method="post"` form with a
      real submit control.

  Content assertions run against the page with its tags stripped, which is not fussiness: highlighted
  code is not contiguous text. `export function greet` arrives as a keyword span and two text spans,
  so asking the markup whether it contains that phrase answers no even on a page that renders it
  perfectly.

  Removing the fix below makes seven of the eight fail. The one that survives is the status check -
  the page still answers 200 while rendering its not-found branch, which is exactly why a status
  code is not evidence and why this test asserts on content instead.

### The third silent failure: an undeclared identifier is not an undefined one

Found by the end-to-end test above, on its first run, and worth writing down because the guarded
spelling *looks* like the fix and is not.

Ten views and four components read the request through `__stxServeContext?.cookies`. stx declares
that binding on the path that serves a request and on no other, so under any other render path the
identifier does not exist - and an undeclared identifier is a ReferenceError. Optional chaining does
not save it: `x?.y` throws on `x` before the chain is reached. It throws inside the server script's
IIFE, so it takes *every other variable in the file* down with it, and the page renders its
not-found branch under a 200.

So the review page reported that a pull request which plainly exists could not be found, on a page
whose repository lookup worked perfectly when called directly. Same shape as the `query` failure and
the unresolvable import above: the page answers, and the answer is no.

Fixed twice, deliberately. Here, each site now tests the binding with `typeof` before naming it and
falls back to undefined, which is the only spelling that is safe for a binding that may not be
declared. The `globalThis` mirror stx also
maintains is *not* a substitute: it is shared between concurrent requests, so reading cookies off it
could hand one reader another reader's session.

And upstream in stx, twice over: `render.ts` now declares `__stxServeContext` as undefined by
default, so the guarded spelling everyone already writes works on every path; and a ReferenceError
from a server script now warns unconditionally rather than only under `STX_DEBUG`, alongside the
unresolvable-import warning that already did. Both are the same argument - a page using only client
APIs fails on `document` or `window` and on nothing else, so anything else that is "not defined" is
a bug and should say so.

- [x] Pick up the stx fix here when it releases, and drop the local guards. They are correct and
      they are noise once the binding is always declared.

  Thirty-three by the time it came to it, not fourteen - the spelling spread to every page and
  component written since. All of them gone, on stx 0.2.162.

  **And the fix released above was not sufficient**, which is worth writing down because the reason
  it looked sufficient is the same trap twice. `render.ts` defaulted the binding for a *page* render.
  A component's server script is extracted with a context the component renderer builds, and that
  one never carried the key - so `<CsrfField />` and every badge still fell back to static
  extraction while a page naming the same binding worked. Dropping the guards on 0.2.159 took 58
  e2e tests down at once, which is the only reason it was caught: the failure mode is a component
  rendering empty, and empty is what a component with nothing to show looks like.

  It is declared in `extractVariables` now, the one seam every server script passes through whoever
  built the context.

### The fourth and fifth: a signed-in browser is not a signed-in client

Both found by opening the page in a browser with a session, which no test in this repository does,
and both had the same effect: the feature worked perfectly for anybody who could not use it, and
failed for everybody who could.

**A `fetch` carries no CSRF token.** The router checks a double-submit token on every non-safe
method: an `x-csrf-token` header, or a `_token` body field, against the `X-CSRF-Token` cookie.
`CsrfField.stx` puts it in every form, which is most of the product. A `fetch` sends neither unless
it is told to, so a write from a script is answered `403 CSRF token mismatch` before it reaches an
action - **but only for a reader who is signed in**, because a browser with no session has no cookie
to mismatch. Signed out it passes. So it passes every anonymous test, passes a click-through by
anybody not logged in, and fails for exactly the people the write is for.

This was already true of the diff viewer's comment post, which has been unable to post a comment
from the streamed view for as long as it has existed. `writeHeaders` in `resources/functions/csrf.ts`
is now the only way either of them sends a write.

**`currentUser` never looked at a cookie.** A page signs somebody in with a cookie - that is what
`viewerFromCookies` reads on every rendered page - and a `fetch` from that page sends it
automatically and sends no `Authorization` header at all. `currentUser` resolved `request.user()` and
a bearer token and nothing else, so every endpoint outside the auth middleware saw a stranger.

The review-state endpoint therefore answered `signed_in: false` to a reader whose cookie was on the
request, which would have made this whole section a no-op in a browser while every test passed: the
progress is stored, the read comes back empty, and the answer is 200 throughout. It is the same
absent-identity bug the bearer resolution was added for, one credential along, and the tests missed
it for the same reason - they reach for a token, and a token works whether or not the bug is there.

Safe on writes because the router's CSRF check is global. The exception is `routes/git.ts`, where the
wire protocol and LFS call `.skipCsrf()` - a git client has no token to double-submit - and those
authenticate through `tokenFromBasicAuth` and never reach `currentUser`. Anything added there that
wants a *user* has to keep that true, or a browser cookie becomes a push.

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

## What it measures

`scripts/benchmarks/diff-engine.ts` is the harness for the server half: git, the splitter, the
parser, the highlighter, the row renderer. It discards a warm-up run and reports the median of
several, because the first pass pays for git's caches and the JIT and reports a machine warming up.

```bash
bun scripts/benchmarks/diff-engine.ts storage/repos/stacks/stacks.git v0.70.0 v0.70.231 --rows
```

Against the real `stacksjs/stacks` repository on this laptop:

| | 100 files, 1.6k lines | 5,722 files, 810k lines |
|---|---|---|
| first record on the wire | 17ms | 23ms |
| complete | 18ms | 406ms |
| peak heap | 36MB | 107MB |
| bytes per file (manifest only) | 207 | 225 |

The path this replaces - buffer the whole patch, then parse it - took 606ms to first useful output on
the large compare and held 134MB, and would then have sent the browser 34MB of patch to render as
810k table rows.

The 207 bytes a file is the number the architecture rests on, and it came out where the plan guessed.
A 40,000 file compare is therefore about 8MB of manifest, which a phone can hold.

Those numbers are from the first measurement and are kept for the shape rather than the absolute:
re-measured on a busier machine the same runs report 36ms and 681ms. What is worth comparing is the
same harness against the same commit on the same day, which is what `compare.ts` is for.

Two things have moved the numbers since, both for the better and both worth naming:

- Inline rows carry expansion controls and per-line link anchors, so each file's markup is larger and
  the byte budget is reached sooner.
- A file that arrives folded up is sent no rows at all. On the large compare that moved the inline
  mode from **77 files to 293** within the same eight megabyte budget, because the budget is no longer
  being spent on lock files and generated snapshots that nobody opened. It also took 22% off the
  bytes on the wire for the hundred file diff.

Everything past the inline point is fetched on demand, which is what the mode is for.

### The browser half

`scripts/benchmarks/scroll-probe.js` measures whether the list keeps up once somebody is reading it.
Run against `stacks/stacks` v0.70.230...v0.70.231 - 100 files, 46,000 pixels of scroll - driven at a
fixed distance over a fixed wall time:

| | |
|---|---|
| scrolled | 45,638px in 4.05s, every step landing exactly where it was told |
| frames | 59fps, p50 16.7ms, p99 17.8ms, worst 22.1ms |
| dropped | 0, against a threshold of 25ms |
| long tasks | 0 |
| mounts | 103, of which **98 came from the pool** |
| files on screen at the end | 1 |
| heap | grew 1MB across the whole scroll |

The mount count is the one that matters. It is a function of how far the reader scrolled, not of how
large the diff is, and 98 of 103 being recycled is the claim the whole design rests on, holding.

One thing the first version of the probe got wrong, recorded because the number was alarming and
false: it counted any frame over the 16.7ms budget as dropped, and a page holding a steady sixty
reports a median of almost exactly 16.7ms. It reported 44% dropped on a run that never stuttered.
A frame is dropped when the next one missed its slot, which is half a frame late.

### The one-word CSS bug that cost the sticky header

`.diff-file` carried `overflow: hidden`, to clip the table's corners to the panel's radius. That
makes the panel a **scroll container**, and a scroll container between a sticky element and the real
scroller is the one thing that stops sticky working at all: the header sticks to a box that never
scrolls, so it never sticks to anything.

The header was correctly `position: sticky` and correctly `top: 0`, and it scrolled away with its
file. `overflow: clip` clips identically and scrolls nothing, and the header pins.

Worth the paragraph because there is no error, no warning, and nothing in the computed style that
looks wrong - `position: sticky` reads back as `sticky` either way. The only way to see it is to walk
the ancestor chain looking for whichever one is a scrollport.

There was a second obstacle behind it, and it cost more. The virtualizer positioned each mounted file
with `transform: translateY(...)`, which is the cheap way to move an element because it composites
rather than lays out. But a sticky element inside a transformed ancestor computes its offset against
the scroller while its box is moved by the transform, so the two disagree: every header ended up
pinned to the *bottom* of its own file, with a blank strip where it should have been.

Positioning with `top` instead fixes it, and the price is measurable and worth stating:

| over a four second scroll | `transform` | `top` |
|---|---|---|
| style and layout | 205ms | 219ms |
| paint and compositing | 425ms | 497ms |
| dropped frames | 0 | 0 to 1 |

Seventy milliseconds of paint spread over four seconds, for a header that tells the reader which file
they are in. Taken.

### Traces, and comparing two commits

`scripts/benchmarks/trace.ts` records a Chrome trace over the same scroll and totals renderer-main
time per phase. `cdp.ts` is the client it uses: a WebSocket and four methods rather than a
browser-automation dependency.

The same 100 file diff, headless, over a four second scroll:

| | |
|---|---|
| style and layout | 180ms |
| paint and compositing | 381ms |
| script | 535ms |
| HTML parsing | 28ms |

`compare.ts` alternates one run each between two URLs, rather than measuring one side to completion
and then the other: anything that changes over the minute in between would otherwise land entirely
on one side and read as a regression.

Two things fell out of running these that are worth keeping:

- **The page has to settle, not just finish loading.** Heights are estimates until their file has
  been mounted and measured, so the scrollable range keeps moving after the last manifest record
  lands. A run started before it holds still scrolls a different distance than the one it was asked
  for. The runner waits, and the probe reports `stepsClamped` for the steps that asked for more than
  was left.
- **The noise floor is 5% *and* 5ms.** Found by running `compare.ts` against the same URL on both
  sides. The three large metrics drift 2 to 4 percent between identical runs, and a percentage alone
  is the wrong test for a small one: `ParseHTML` totals under thirty milliseconds, so two
  milliseconds of drift is six percent of it, and the first version called two identical URLs
  "slower" on exactly that.

- [ ] Run it in CI on a machine quiet enough for the floor to be lower than a laptop's
- [ ] A corpus larger than this repository can provide. `stacks` at 5,722 files is a tenth of the
      Linux compare DiffsHub uses as its demo.

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
- [x] `From <sha>` commit-metadata boundaries inside a mailbox-format patch are respected, so a
      multi-commit patch splits per file rather than swallowing the next commit's header
- [x] A fallback for input that never produced a `diff --git` boundary: parse the whole buffer once at
      the end rather than showing nothing
- [x] Tests: a boundary split across chunk edges, a patch with no boundary at all, a file whose
      content contains the literal string `diff --git`, and an aborted stream mid-file

## Publishing: batch against a clock and a work budget

Appending each file as it parses is as bad as waiting for all of them: the main thread never yields
and the page is unresponsive for the whole download. DiffsHub's numbers, worth starting from and then
measuring:

- [x] First batch sized to the viewport (`ceil(viewportHeight / rowHeight)`, clamped to 25..96) so the
      first paint fills the screen exactly once, then 25 files per batch after that
- [x] Publish when the batch is full **or** 100ms has passed (500ms for the very first batch, which
      buys a fuller first screen)
- [x] An 8ms work budget: if parsing has held the thread that long, yield before continuing, even
      mid-batch. Checked *between* records, so a yield never lands in the middle of one.
- [x] Yield via `requestAnimationFrame` with a `setTimeout` race behind it, so a backgrounded tab
      still makes progress - which is exactly how people open several pull requests at once.
- [x] The file tree publishes on its own slower schedule (every 1,000 files or 1,000ms) because a
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
- [x] Line-ending detection per file (`lf`, `crlf`, `mixed`, or nothing known), and a
      `\ No newline at end of file` marker rendered as itself rather than dropped
- [x] Partial diff metadata: a file can exist in the list, with correct estimated height, before its
      contents have been loaded. A loader fills them in on demand. This is what the manifest *is* -
      the row counts and the estimated height arrive in the record, and the rows follow or are
      fetched.
- [x] Tests against the shapes that break parsers: a rename with no content change, a mode-only
      change, mixed CRLF and LF in one file, a file with no trailing newline, a filename containing a
      quote or a newline, a 5,000 line single-file diff

Two of those found real bugs on the first run, which is the argument for writing them:

- **A quoted path kept its `b/` prefix.** git quotes any path with a space in it, and the prefix is
  *inside* the quotes, so it was being stripped before the unquote rather than after. Every path with
  a space in it therefore came out as `b/my file.ts`, matched nothing on the way back, and was
  silently un-expandable and un-commentable.
- **Anything after the last hunk was read as content.** The parser consumed lines to the next header,
  and `git format-patch` ends every commit with a `--` signature - which is a removed line as far as
  a marker check goes. Hunks are now bounded by the line counts their own header declares, which is
  what the counts are for.

## Virtualization: the list is the product

This is the core of it. One scroll region contains every file; only what is near the viewport exists
in the DOM.

- [ ] A viewer that owns a list of items (a file diff or a plain file), each with a stable id and a
      `version` that increments when anything about it changes. Item identity plus version is what
      decides whether a mounted item needs re-rendering.

  **Half of this landed and the half that did not is worth naming precisely.**

  `reconcileList` in `app/Actions/Pull/viewport.ts` is the decision, pure and tested like everything
  else in that file: items carry an `id` (the path, which survives a rename arriving late because a
  rename reports the *new* path) and a `version`, and a change to the list produces what to keep,
  what to render again, what to release, which measurements carry across, and where the reader's
  anchor moved to. `DiffViewer.setFiles` applies it.

  What that buys is the case a position-addressed list gets silently wrong: **inserting one item at
  the top renames every item below it.** The host mounted for `src/app.ts` starts showing
  `src/api.ts`, its measured height belongs to neither, and the anchor points at whatever moved into
  the slot the reader was in - a correct render of the wrong thing, which no screenshot flags.
  Appending cannot show it, and appending is all a manifest stream does, which is how the list got
  this far without identity.

  It has no caller yet, and that is the honest state. The obvious one - restricting the diff to the
  files that changed since the reader last looked, which today filters only the tree beside it -
  needs something else first: **every call site addresses a file by the server's index**
  (`viewer.refresh(index)`, `setRows`, `growBy`, the markup map, the row fetch queue), and that
  equals its position in the list only because the stream appends in order. Filtering breaks that
  equality everywhere at once. The next step is an id-to-position map inside the viewer so the
  server's index stays the vocabulary at the edges, and positions stay private.

  Not wired to a live update on purpose: a new head is [deliberately a banner rather than a
  refresh](./14-diff-engine.md) - `live.ts` says why, and it is right. Every line number on screen
  may have moved and a draft anchored to one is anchored to the wrong line, so the reader chooses
  the reload.
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
- [x] **A very large single file is windowed in turn.** The list virtualizes *files*, so one file is
      one item and mounts whole - and four hundred thousand table rows in one document is the failure
      the whole engine exists to avoid. A file past two thousand rows now holds a window of its rows
      and two spacers standing in for the rest, and asks for another window as the reader moves.

  What makes it safe is one number meaning the same thing in three places: the row index `countRows`
  counts, the row index `renderDiffRows` emits, and the row index the client asks for. If those
  drifted by one, every window would be off by a line and the file would appear to scroll past
  itself - so a test renders the file in seven-row windows and asserts the result is byte for byte
  what rendering it whole produces, in both layouts, with threads travelling with their lines.

  Measured against `v0.68.0...v0.70.231` of `stacks` - 5,214 files, 613,396 added lines, and an
  `openapi.json` of 28,122 rows:

  | | |
  |---|---|
  | rows in the *whole document*, scrolled to line 15,000 of that file | **1,200** |
  | rows the file has | 28,122 |
  | height the file occupies, so the scrollbar means something | 559,441px |
  | spacers standing in for what is not mounted | 288,000px above, 249,780px below |

  The window is aligned to a grid, which is what stops a slow scroll asking for a range nudged by one
  on every frame, and it is fetched while the reader is still a margin from its edge rather than
  after they have run out of rows.

- [x] Windowing sizes its spacers from the metric line height, so a windowed file with word wrap on
      has an approximate scrollbar. Everything mounted is measured as usual; it is only the rows
      standing in for themselves that are assumed to be one line tall. The arithmetic holds
      regardless of what the rows do: the spacers plus the held rows come to exactly the file's row
      count times the line height, wherever the window sits, so the scrollbar means the same thing
      at every scroll position.
- [x] And *choosing* the window no longer shares that assumption, which mattered more than the
      scrollbar did. `visibleRows` divides pixel offsets by a row height, so with wrap on - where a
      row can be two or three lines tall - the one-line metric reported twice as many rows on screen
      as there were and centred every fetch below where the reader actually was. An inexact
      scrollbar costs a little; that costs the reader the rows they were reading.

      Both uses take the same number now, and it becomes a measurement as soon as there is one:
      measured from the held rows with the spacers subtracted out, since the spacers are sized *from*
      the answer and a figure derived from them would chase its own tail every frame. Dropped rather
      than adjusted when wrap or the layout changes, because a stale height is worse than an honest
      estimate.

      The measurement is taken through a new `onMeasure` hook rather than by the caller reading a
      height when it needs one. Every synchronous layout read outside the batched pass forces the
      browser to flush the writes before it, so a read at what looks like a harmless moment is a
      stutter with no local cause - the pass exists precisely to make that impossible, and a caller
      reaching around it would have undone it quietly.
- [x] Batched read/write render passes: all measurement, then all mutation, never interleaved. Every
      synchronous layout read outside that pass is a bug and should be findable by name.
- [x] `contain: strict` on the scroll container and `contain: layout paint style` on each file, so
      one file's layout cannot invalidate the list
- [x] `overflow-anchor: none`, because the browser's own scroll anchoring fights ours
- [x] Snap computed scroll targets to the device pixel grid (`round(v * dpr) / dpr`), read fresh each
      time so switching monitors or zooming is picked up. Fractional-DPR displays otherwise leave
      scroll deltas hovering on residuals that never settle.
- [x] Measure the scrollbar gutter once per page with a hidden probe carrying the same selector as a
      real code pane, so custom scrollbar CSS is reflected and the split columns do not disagree
      about their width. Fifteen pixels here, zero on a Mac with overlay scrollbars, which is exactly
      why it is measured rather than assumed.
- [x] Sticky file headers, with the "stuck" shadow driven by `container-type: scroll-state` rather
      than a scroll listener
- [x] Scroll targets by position, item, line, and line range, each with start/center/end alignment
      and instant/smooth behaviour, honouring `prefers-reduced-motion`
- [x] A WebKit guard for the bulk-subtree-rewrite bug,
      [webkit 308027](https://bugs.webkit.org/show_bug.cgi?id=308027):
      rewriting the subtree of a `container-type: inline-size` element in bulk makes Safari clamp the
      ancestor scroller to 0. Pin `min-height` across the rebuild, force one layout read while pinned,
      then unpin. Gate it to Safari only, because it costs two synchronous layouts.
- [x] Tests: strict-mode double mount, a reconcile queue that receives updates mid-render, item
      removal while off-screen, an item id changing (a rename arriving late in a stream), and a
      collapse of an item above the current scroll position

## Highlighting: off the main thread

Worth stating before the list, because this is where the roadmap's plan meets the architecture
decision made at the top of the file and comes off second.

The plan is Pierre's, and Pierre's is right for Pierre: the **browser** tokenizes, because a static
site with no backend has no other machine. Ours cannot be that. Phase 2 settled that the client does
not download a highlighter, and the diff engine settled that the server renders rows to HTML - so by
the time markup reaches a browser it is already coloured, and a browser-side pool would have nothing
to do.

The thread that actually needs relieving is the server's. `streamManifest` awaits highlighting per
file, serially, on the event loop: while a large compare is being rendered, every other request on
the process waits behind it. Same problem, one machine to the left, and the pool is the same answer
applied there.

- [x] A worker pool that tokenizes files and diffs and posts back a syntax tree, with the pool size
      derived from `navigator.hardwareConcurrency` and a sane cap. It grows one worker at a time,
      on demand, rather than opening the whole pool on the first request - each worker parses every
      grammar as it starts, so opening eight of them to tokenize one file is a straight loss.
- [x] Per-instance task cancellation: scrolling past a file that has not been highlighted yet must
      drop its queued work, not let it complete. Best effort, and the protocol says so: a request a
      worker has already started runs to completion, because the tokenizer is a tight loop with
      nowhere to yield. The *reply* is dropped either way.
- [x] An LRU cache of highlighted results keyed by content and language, so a layout switch - which
      refetches every file's rows - re-tokenizes nothing. Keyed by content rather than by path, so it
      is correct across branches, commits and forks with nothing to invalidate.
- [x] Plain-text fallback: over a tokenization ceiling (100,000 characters) a file renders
      unhighlighted rather than blocking. The reader gets the diff; the colours are the optional part.
      In the library, so every consumer gives up at the same point rather than inventing its own
      ceiling or - much more often - not having one.
- [x] A worker stats subscription (pool state, queued, active, cache sizes) so the benchmark harness
      and a debug panel can tell "still working" from "idle"
- [x] **The server-side path stays.** Every row the browser receives is already coloured; the pool
      moved the tokenizing off the *server's* event loop rather than onto the client's.
- [ ] Lazy theme resolution, cached, with the set attached to the shared highlighter only once.
      Lazy *language* resolution landed with the grammar catalog; themes have not.
- [ ] Priming the first screen does not apply while the server renders the rows: the first screen
      arrives coloured. It becomes real if the public front door ever renders somebody else's diff in
      a browser.

### What measuring it actually showed

Against the 5,722 file compare, with the pool and the cache in place:

| | |
|---|---|
| tokenized on a worker | 9 files |
| tokenized in process, under the threshold | 969 |
| **answered from the cache** | **854** |
| workers started | **1** |

Two findings, and the second is the more useful one.

**The cache is the win.** 854 hits in a single pass, because a framework monorepo has hundreds of
near-identical `package.json` files and every file is tokenized twice - once per side. A collision in
the content key would render that file plain rather than wrong, because the tokens are verified
against the line before they are used.

**A serial pipeline cannot use a pool.** One worker started, because `streamManifest` awaits each
file before beginning the next, so there is never more than one job in flight. The pool is correct
and the concurrency is one. What it does buy even at one is the event loop: the server answers other
requests while that worker runs, which it previously could not.

- [x] A bounded look-ahead in `streamManifest`: the next few files are highlighted while the current
      one is still being emitted, so the pool has something to be a pool *of*.

  What is **not** reordered is the emission. Records come out in file order, which is what keeps the
  inline row budget honest - it is spent in order, so `rows-truncated` names the file it actually
  stopped at rather than whichever file happened to finish first. That was the objection to doing
  this at all, and separating the two answers it: reorder the tokenizing, not the output. The cost is
  a file or two highlighted past the truncation point and thrown away, bounded by the look-ahead.

  It also changed the record *interleaving*, from `file, rows, file, rows` to several records and
  then their rows - which is strictly better, because the file list now streams ahead of the
  highlighting instead of waiting behind it. Two tests were pinning that old sequence; they were
  pinning the serial pipeline, and they assert the invariants now instead.

### What the measurement could and could not settle

Against the 5,722 file compare, three runs each:

| | serial | with look-ahead |
|---|---|---|
| workers engaged | 1 | **3** |
| total | 745ms, 1147ms | 783ms, 801ms, 808ms |

The honest reading: **the noise floor on this machine is larger than the difference.** The serial runs
spread over 400ms, so no claim about which is faster survives contact with that. What the numbers do
support is that the look-ahead is markedly more *consistent* - a 25ms spread against 402ms - which is
what moving the work off the event loop should look like when the machine is busy.

The benefit that matters most is one this harness structurally cannot see: it measures one stream in
isolation, and the point of not blocking the event loop is what happens to the *other* requests.

- [x] A benchmark that loads the server while a large compare streams, which is the only way to
      measure the thing the pool was actually built for. Two of them, in the end:
      `scripts/benchmarks/under-load.ts` probes a small route over HTTP while a compare streams and
      reports what that page load cost somebody who arrived mid-render, and a second in-process
      probe times a 10ms interval to measure how long the event loop is held directly. The HTTP one
      answers the product question; the in-process one is the only one precise enough to debug with.

### What the load benchmark found, which was not the pool

Idle p99 5.6ms against 407.6ms under load. So the pool had moved the tokenizing off the event loop
and the event loop was still being held for most of a second, which meant something else was holding
it. Three hypotheses died in order, and the order is the point:

**It is the worker threshold.** If too much tokenizing were still running inline, lowering the bar
for dispatching to a worker should help. It made things worse - worst hold 1197ms, then 1601ms, then
1725ms as the threshold came down. More dispatching, more holding.

**It is the rendering.** Turning row rendering off entirely still held the loop for 451ms, with no
highlighting and no markup being built at all. Whatever this was, it was in the parse.

**It is one enormous file.** Plausible: the corpus has a 28,122 row generated file in it. Timed on
its own it costs 11ms to parse, 8ms to highlight, 45ms to render and 40ms to serialize. Around
100ms, not 450, and no single file in the corpus is big enough to explain the rest.

What it actually was: **awaiting a resolved promise is not a yield.** `streamManifest` is full of
`await`, every one of which queues a microtask, and the microtask queue runs to exhaustion before a
timer or a socket gets a turn. A consumer that does nothing slow therefore drives the whole compare
in one uninterrupted cascade. Every `await` in the chain looked like a yield and none of them was,
which is exactly why adding more of them never helped.

The fix is a real macrotask (`setImmediate`) every 512 files, and both halves of that were measured
rather than chosen:

- **A timer is the wrong macrotask.** `setTimeout(0)` has a floor around a millisecond, and paying
  it per file took the 1.4 second compare to **33 seconds**. `setImmediate` has no floor.
- **A time budget is the wrong budget.** This is a pull-based generator, so it is suspended between
  records, so elapsed wall time includes the consumer's time - every file measures as over budget no
  matter how small the work was. Counting files has no such confusion.
- **The count matters more than expected.** Every 32 files: 17.3s total, 293ms worst hold. Every
  128: 5.1s, 409ms. Every 512: **0.8s, 115ms**. Every 2048: 0.7s, 274ms. Never: 0.5s, 499ms. Both
  ends of that curve are worse than the middle, and 512 buys a bounded hold for about 50% more wall
  time on the largest compare in the corpus.

### And the second worth of it was warm-up

With the yield in place the tail was still 791ms with rows on, which looked like the fix not working.
Running the same compare twice in one process separated the two:

| | total | worst hold |
|---|---|---|
| first compare | 2058ms | 1080ms |
| second compare | 920ms | **124ms** |

Grammar loading and JIT, once per process, not once per request. On a long-lived server exactly one
reader ever pays it. Recorded rather than fixed, because the obvious fix - warm the grammars at boot
- has nowhere to be called from: `app/Routes.ts` is a config object and this framework has no boot
hook. An exported `warmHighlighter()` that nothing calls is dead code.

- [ ] A boot hook in Stacks to hang warm-up on, then warm the grammars from it. Belongs upstream in
      the framework, not worked around here.

### The bug that came with it

Shipped in `ts-syntax-highlighter@0.2.10` and fixed in `0.2.11`, recorded because the failure mode
was so unhelpful. The worker module ended with a guard that started the tokenizer when `self` looked
like a worker scope:

```ts
if (typeof self !== 'undefined' && typeof self.addEventListener === 'function')
  serveTokenizer(self)
```

True in a browser worker. Also true on Bun's and Node's **main** thread. So merely importing the
package registered a message listener on the main thread, which kept its event loop alive - and
every process that imported the library stopped exiting. Nothing threw and nothing logged; a
benchmark that had been finishing in forty seconds simply never returned, which took a while to
attribute to an import rather than to the code being measured.

There is no auto-start now. A worker entry is two lines and says what it is.

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

- [x] A worker entry in the package, so consumers do not each write their own. Four messages, and
      the scope is passed in rather than reached for, so the same function serves a browser `Worker`,
      a Bun worker and a `MessagePort`.
- [x] Token output that survives structured clone cheaply: one string per line plus parallel typed
      arrays of offsets and class ids, with the object API kept as a wrapper. The contents are *not*
      stored - they are slices of the line - which is only sound while the tokens reproduce the line,
      so the packer checks rather than assumes and falls back to one plain token when they do not.
- [x] Cancellation: a queued tokenize request must be droppable when the reader scrolls past it

### Themes

- [ ] Three themes ship today (`github-dark`, `github-light`, `nord`). Pierre ship ten first-party
      plus everything Shiki bundles, and their theme picker is a visible product feature.
- [x] **Import VS Code / TextMate / Shiki theme JSON.** `export-textmate.ts` already goes one way;
      the inverse is the higher-value direction, because it makes every theme anyone has ever
      published work with zero grammar work on our side. This is the single change that closes the
      theme gap in one move. Shipped in `ts-syntax-highlighter@0.2.9` as `importTheme`.

  Most of the work turned out to be tolerating fifteen years of format drift rather than translating
  anything: `scope` is an array, or one string, or a comma-separated list in one string; very old
  `.tmTheme` conversions put everything in a `settings` array and give the editor's own colours as
  the entry with *no* scope; `type` is usually missing and has to be inferred from the background's
  luminance; colours arrive as `#rgb`, `#rrggbbaa` and occasionally with no `#`; and VS Code reads
  its own theme files as JSONC, so a great many published themes have comments in them and are not
  valid JSON at all. A file that cannot be read throws; a file with one unreadable *part* loses that
  part and keeps the rest, because a colour scheme missing one rule is a working colour scheme and a
  thrown error is a blank page.
- [ ] Colour-vision-deficiency variants of the *syntax* themes as first-party themes in the library.
      The diff's own colours are done (below); the token palette is not.
- [x] A theme normalizer that also yields UI chrome colours (background, foreground, surface,
      border, muted, selection) so the app around the code can be coloured from the same file, which
      is what makes a themed page look like one surface. `themeChrome` derives whatever the theme did
      not state rather than leaving holes, so every imported theme yields a complete set.

### Correctness and grammars

- [x] **A property test, across all 49 grammars and a real corpus: the concatenated token contents
      must equal the input line exactly.** `app/Actions/Browse/highlight.ts` already states this as
      the one property everything depends on, and in a diff a dropped space can be the entire change.
      That property deserves a test in the library, not a comment in the consumer.
- [x] The variable-highlighting set (bash, php, powershell, scss, dockerfile) - the highest-value
      five of the library's `TODO.md` cases, because those languages are thick with `$VAR` and they
      are common in real pull requests. Every one of them tokenized it as plain text, so a shell
      script, a Blade template and a stylesheet of variables all rendered with the one thing a reader
      scans for uncoloured. Gated on the language, because `$` is a legal identifier character in
      JavaScript and TypeScript and `$foo` there is a name rather than a reference.
- [x] Markdown headings, which are the most common structure in the most common non-code file in a
      pull request and rendered as plain text.
- [ ] The remaining `.todo()` cases in the library's `TODO.md`: markdown inline links, emphasis and
      fenced code, rust lifetimes and macros, C# attributes.

### A URL is not a comment

Found while looking at those, and much worse than any of them.

The tokenizer decided whether `//` opened a comment by asking "is this HTML?" - so every language
that was not HTML inherited JavaScript's comment syntax. A URL is the shape that exposes it:

```bash
curl https://example.dev/thing     # everything from the second slash was a comment
```

There is no string around an unquoted URL to protect it, so a shell script, a YAML file or a README
link had the rest of its line rendered grey and italic. READMEs and CI files are full of URLs, so
this was visible on ordinary files, on every page - and it looked like the highlighter giving up
halfway through a line rather than like a bug with a cause.

The same check had the mirror problem: `#` was *not* a comment anywhere, so every comment in bash,
YAML, Python, TOML and Dockerfile rendered as code. Both are now named sets of languages rather than
one negative test, and a hash inside a string stays inside the string because the string is consumed
whole before the loop comes back round.
- [x] Languages a forge sees constantly and should be checked for coverage: `.stx`, `.blade.php`,
      `Dockerfile` variants, `.tf`, `.proto`, `.sql`, `.toml`, `.env`, and `.patch` itself. Every one
      of those had a grammar in the library already and none of them was mapped, so they rendered
      plain - the least interesting reason for a file to have no colour and the easiest to leave
      unnoticed. `.prisma`, `.zig` and `.ini` have no grammar and are left alone rather than mapped
      to something that nearly fits.
- [x] Filename-first language detection: the whole filename, then a two-part extension
      (`.blade.php`, `.d.ts`), then the extension, then the `Dockerfile.staging` shapes, then the
      shebang. Every step is a lookup and none is a heuristic, because a wrong guess colours code as
      the wrong language and that is worse than no colour. The shebang matters more than it sounds:
      `bin/deploy`, `scripts/release` and every git hook are extensionless by convention, and those
      are exactly the files somebody wrote by hand.
- [ ] A per-repository language override, for the cases no rule can know.

### Performance work in the library

- [ ] Throughput benchmarks in MB/s per language in the `benchmarks` package, tracked over time and
      run in CI, so a grammar change that halves throughput is visible
- [x] A tokenize ceiling with an explicit plain-text result inside the library, so every consumer
      gets the same fallback rather than each inventing one - or, much more often, not having one
- [ ] Profile `Tokenizer` against `FastTokenizer` on the corpus and decide when each is used
      automatically, rather than making the caller choose
- [ ] Reuse the `Uint8Array` character-class table approach from `FastTokenizer` in the main
      tokenizer where scope tracking allows it
- [ ] Line results are cached by (line text, language, incoming scope stack). A diff repeats context
      lines between hunks and between the two sides of a split view constantly.

  **Measured, and deliberately not built.** The premise is true and the return is not. Over the
  5,722 file compare, counting the way the renderer actually asks - a context line tokenized once
  per side in split view - 720,946 lines go to the tokenizer and **56.5% of them are repeats**.

  But a cache saves tokenizing work in proportion to *characters*, not lines, and only **29.4%** of
  the characters repeat. The repeats skew short: blank lines alone are 22% of them. Introducing a
  minimum line length trades hit rate for overhead, and the curve is flat where it matters:

  | minimum line length | lookups | hit rate | tokenizing work saved |
  |---|---|---|---|
  | 0 | 720,946 | 56.5% | 29.4% |
  | 8 | 534,458 | 41.6% | 27.9% |
  | 24 | 370,435 | 29.0% | 20.6% |
  | 64 | 110,274 | 15.2% | 6.6% |

  So a threshold of 8 would keep nearly all the benefit. The reason to stop is one layer up:
  tokenizing is not where the time goes. On the largest file in the corpus - 28,122 rows - parsing
  is 11ms, **highlighting is 8ms**, rendering is 45ms and serializing is 40ms. Saving 28% of the 8ms
  is 2ms in 104, and it would be bought with a cache keyed on the incoming scope stack in the hot
  path of a 1,100 line tokenizer shared by other projects.

  Worth revisiting only if rendering and serializing get fast enough that tokenizing is the
  remaining cost, or if a language turns up whose grammar is far more expensive than TypeScript's.
  The file-level content cache already built takes the large repeats (854 hits on this compare) at
  none of that risk.

## The diff surface

Everything a reader can turn on. DiffsHub exposes all of these; several we already have.

- [x] Split and unified layouts, switchable without reloading. The manifest carries the row counts
      for both, so the geometry switches from what the list already has and only the markup is
      refetched.
- [x] Split columns scroll-synced horizontally - by being one scrolling box rather than two kept in
      step. A pair of scrollers synchronised by script is the obvious reading and the wrong one: it
      costs a listener per file, it drifts under momentum scrolling, and it has nothing to say about
      a row being recycled mid-gesture. One scroller cannot drift from itself.

  Finding it turned up a regression from the scrollbar-gutter work: `table-layout: fixed` promises
  equal columns and also freezes them at the width of the first row, so every long line was clipped
  and the two halves overlapped. Columns are sized from content now, with a minimum width keeping
  them even.
- [x] Word-level highlighting inside changed lines. Reported as character ranges rather than as
      substrings, because the line is already carved into syntax tokens by the time it renders and
      neither carving may be dropped. Character-level is still open.
- [x] Diff indicators as a choice: classic `+`/`-` glyphs, a colour bar, or none
- [x] Line numbers toggleable, and both sides' numbers always present in split
- [x] Change backgrounds toggleable, for readers who find the wash of colour harder to read
- [x] Word wrap toggleable, per reader, remembered. Long lines scroll within their own file when wrap
      is off, which we already do.
- [x] Collapse and expand a single file, and collapse or expand all files, without losing scroll
      position
- [x] Hunk separators that say what was skipped and how much
- [x] Deleted files collapsed by default

Every one of those is an attribute on the scroll container and a selector in the stylesheet. That is
the point rather than an implementation detail: a row is created and destroyed as the reader scrolls,
so a setting applied per row would have to be re-applied on every mount, and switching one on a
forty thousand file compare would be a refetch. Applied to the container it is true of every row that
ever appears under it, and switching costs a style recalculation. Only wrapping needs more, because
it changes how tall every line is, so the viewer measures again.

### What a folded file used to cost

Found while building the panel above, and worth recording because the symptom pointed somewhere else.

A file that arrives collapsed had its rows rendered, highlighted, streamed, and parsed into the page,
and was then hidden with `display: none`. So a lock file cost its full sixteen thousand pixels of
markup, a place in the inline row budget that a file somebody wanted to read could have had, and the
highlighter time to produce it - to show a header.

Worse, the streamed rows were rendered *open* while the manifest record said collapsed. The list laid
out forty pixels for the header and mounted the whole file into it, which overlapped every file below
and made the scrollbar wrong. That looked like a virtualizer bug and was not.

A collapsed file is now a header and an empty body, rendered by one function that both the server and
the browser call. The rows are fetched if the reader opens it, which is exactly when they are worth
having. Two things fell out of it:

- **A measured height now wins whether a file is folded or not.** The old rule - a collapsed file is
  its estimated header, whatever it measured - existed only because what it measured was the *open*
  height. That is no longer true, so the rule went, and the fold state clears the measurement instead.
- **The header estimate was wrong by half.** It was 40 pixels against a real 61. Nothing on a pull
  request, and eight hundred thousand pixels of lying scrollbar on a forty thousand file compare,
  where almost every file is estimated and never measured.

- [x] The conversation page could not open a collapsed file at all: it renders no client script, so
      the fold control on it did nothing, and once a folded file stopped carrying its rows it became
      a file nobody could ever read. Folding now has two forms and the page says which it wants -
      `fetch` for the streamed viewer, which asks for the rows when the reader opens one, and `fold`
      for a page with no script, which is a `<details>` with everything already in it.
- [x] Every one of these settings persists per reader and survives a reload

## Hunk expansion and partial diffs

- [x] Expand hidden context above or below a hunk, in both directions, by a fixed count or all the way
- [x] Expansion fetches the surrounding lines on demand from the blob rather than shipping full file
      contents with the diff
- [x] `revealLine(n)`: expand whatever context is needed to bring a line into view, used by deep links
      and by jumping to a review thread anchored on a context line. Four things can be in the way -
      the file has not streamed in yet, it is collapsed, its rows have not been fetched, the line is
      inside an unexpanded gap - and each is handled by trying again rather than by predicting it.
- [x] Estimated height accounts for expansions already applied, so expanding does not shift
      everything below by a wrong amount and then correct itself. The viewer is *told* the delta
      rather than asked to measure again: clearing the measurement drops back to an estimate that
      knows nothing about the expansion, so the list shrank for one frame and grew on the next, and
      the reader watched everything below the hunk jump twice.
- [x] Files loaded on demand: a diff item can be listed and sized before its content exists

## Review threads in the diff

Pierre's annotation framework injects arbitrary rows into the grid; ours has to carry real review
threads, which is where our version has to be better rather than equal.

- [x] Annotation rows injected at a (file, side, line), measured like any other row so the
      virtualizer's height math includes them
- [x] A gutter affordance on hover that starts a comment on that line, and a drag across the gutter
      that starts one on a range
- [x] A draft comment is a row in the diff, not a modal. Only one draft open at a time across the
      whole list. Its text is held outside the DOM, so scrolling away from a half-written comment and
      back does not lose it - the row it lives in is recycled like any other.
- [x] Threads render collapsed to one line once resolved, expandable in place. A `<details>`, so it
      works on the server-rendered page too, which runs no JavaScript at all.
- [x] Outdated threads render on the line they were written against, marked, rather than being
      dropped (phase 4 already anchors them; this is the rendering half)
- [x] Draft reviews survive a reload, restored onto the line they were written against rather than
      just as text somewhere. Every field is checked on the way out of storage, because a draft put
      back on the wrong line is a comment about code it is not about, and a draft whose file is no
      longer in the diff is dropped rather than re-opened somewhere arbitrary.

  Finding it working took a second attempt, and the reason is worth keeping: the draft was restored
  into memory correctly and never appeared. After the stream ends nothing schedules another frame,
  and the painting happens in `afterRender` - so a draft restored at that moment was waiting for a
  frame that was never going to come.
- [x] Draft reviews survive a *machine* change, which means the server rather than local storage.
      `ReviewDraft` holds one per reviewer per pull request - which is what the viewer has, since it
      only ever opens one - with the path, the side and the range beside the body, because a draft
      restored without its anchor is a comment about code it is not about.

  Local storage stays, and stays first. It is synchronous, it is available before the first frame,
  and it is the only copy a signed-out reader has; the server is what makes it durable, not what
  makes it work. So every write lands locally and *then* goes out, because a reload pressed half a
  second later beats any request, and a failed request costs the reader nothing they had before the
  endpoint existed.

  The server wins on load rather than the two being merged. A union looks kinder and is wrong:
  unticking a file on one machine would see it come back from the other machine's stale cache, and a
  viewed mark that returns from the dead is worse than one that never persisted. A `signed_in: false`
  answer is the one case that changes nothing - a session that lapsed between the page rendering and
  the request going out must not wipe a review in progress.

  A draft the reader has already started typing into is theirs and stays put. Losing words to a
  version of the same draft from another machine would be the exact failure this prevents, and their
  next keystroke sends what is on screen back anyway.
- [x] Annotation rows are part of the pooling story: they must recycle too, or a heavily-commented
      diff leaks. They are inside the file's markup, so they are released with it; the draft row is
      the one exception and it is re-created from held text on the way back.

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

- [x] Click a line number to select it, shift-click or drag to select a range, across sides in split
- [x] The selection writes to the URL hash and the hash restores the selection on load, including
      expanding a collapsed file and revealing collapsed context to reach it
- [x] Restoring from a hash mid-stream: the target file may not have arrived yet, so the attempt
      repeats as batches land and stops once it succeeds
- [x] `hashchange` is honoured, so an in-page link between two threads works
- [x] A selection action surface (copy permalink, comment on selection, copy lines) anchored to the
      selection. Copying lines strips the `+`/`-` marker, which belongs to the diff and not to the
      code.

## The file tree

- [x] A windowed list beside the diff. Not a folded tree: the directory is dimmed beside the
      filename, which is what a reviewer scans to tell two `index.ts` apart, and folding is a state
      machine that earns its keep on a repository browser rather than on a diff where every file
      listed is one somebody changed.
- [x] Slice-first reads: a screenful is rendered from a window into the list rather than from a copy
      of it, and the filter produces *positions in the diff* rather than a renumbered list - so a
      filtered sidebar still scrolls the viewer to the right file.
- [ ] Search over the tree found one thing worth saying: three items that were on this list are
      about a *folded* tree, and this list is flat. Prepared input for presorted paths, flattening
      empty directories in the projection, and sticky ancestor folders are all answers to problems a
      folded tree has. A flat list sorted by the diff's own order has none of them: it is never
      sorted, it has no directories to flatten, and there are no ancestors to pin. They are left
      unticked rather than deleted because adopting a folded tree would bring all three back.
- [x] Per-file change decoration (added, modified, deleted, renamed) with counts
- [x] Search over the tree, opt-in so it takes no vertical space until asked for. `/` opens it,
      which is the key every list on the internet uses and therefore the one nobody has to be told
      about. Terms match anywhere in the path in any order, so `cart test` finds
      `tests/commerce/cart.test.ts` without the reader remembering the directory order - and it is
      substring rather than fuzzy, because a filter that returns files whose match you cannot see is
      worse than one that returns none.
- [x] Selecting a file scrolls the viewer to it, expanding it if collapsed
- [x] The tree is a separate state tree from the diff items, so a comment landing does not rebuild it
- [x] Viewed state per file, checkable from the tree, persisted across visits. Ticking one folds the
      file away, which is the point of ticking it: the next unread file moves up to where the reader
      is looking. Kept per pull request rather than per path - a key of just the path would tick a
      file on every other pull request that touches it, which looks exactly like the feature working.
- [x] Viewed state on the server rather than in local storage, so it follows a reviewer between
      machines. `ReviewedFile` is one row per reviewer per file per pull request, upserted so the
      same pull request open in two tabs cannot collide on the unique index.

  The interface half turned out to be one line short of finished already: a tick that is remembered
  across visits but does not *fold* on the way back only remembers half of what it was for. The
  reader returns to two hundred open files with a column of ticks beside them. Folded, and only
  folded - unfolding everything the server did not name would open the large files the viewer
  collapsed on purpose.

  `head_sha` is stored and deliberately not acted on. The obvious use - call the tick stale when the
  head has moved - is wrong as stated, because the head is one sha for the whole pull request, so any
  push would unmark every file including the ones it did not touch. Doing it properly means asking
  git whether *this file* changed between the two shas, which is the incremental diff in phase 4.

- [ ] Show a tick as stale when that file changed since it was read. Needs the per-file question
      above, and `head_sha` is already on the row for it.
- [x] A mobile presentation: an overlay rather than a column

## Theming

- [x] Light and dark, chosen independently, plus a system mode - which is the default, so a reader
      who has never chosen sees exactly what they saw before the choice existed.
- [x] The choice persists and is applied **before first paint**, by three inline lines in the head.
      That is the one thing on the page that cannot wait for a module to load: read it a frame late
      and the reader watches a light page turn dark, which is worse than not offering the choice at
      all. It reads the same key and writes the same attribute as `diffprefs.ts`, and if those two
      ever disagree the page flashes - which is why it is three lines rather than an import.
- [x] Switching theme re-colours without re-tokenizing anything, and that falls out of the
      architecture rather than needing a cache: tokens are rendered as semantic classes and coloured
      by CSS, so a theme is a stylesheet and switching one is a style recalculation.
- [ ] The chrome derives its colours from an *imported* theme, so a page themed by somebody's VS Code
      file is one surface. `themeChrome` in the library already yields the five values; nothing in the
      app consumes them yet. The two schemes that ship are one surface already, by hand.
- [x] Colour-vision-deficiency variants: a red-green (protanopia/deuteranopia) and a blue-yellow
      (tritanopia) pair, plus a high-contrast pair with no hue in it at all. Not a simulation of what
      those readers see - pairs chosen to stay distinguishable *for* them: blue against orange
      survives red-green deficiency, teal against magenta survives blue-yellow. Roughly one in twelve
      men cannot reliably tell the conventional pair apart, and the shape cue - the `+`/`-` glyph or
      the edge bar - stays on by default whichever palette is chosen, because that is the part that
      makes a diff readable rather than merely tinted.
- [x] Diff add and remove colours are legible against every shipped palette, checked rather than
      assumed - the values are read out of the stylesheet, so the test cannot pass while the page
      uses different colours.

  It caught the thing it was written for, immediately. **The colour-vision palettes were as
  luminance-flat as the pair they replace.** Red and green differ almost entirely in hue, which is
  precisely the channel those readers do not have - so my blue-against-orange and
  teal-against-magenta, chosen by eye, differed by 1.5% in brightness and would have been a different
  pair of colours and the same failure. They now differ by 18% and 26%, and there is a test asserting
  the classic pair does *not*, so nobody improves it into something that makes the alternatives look
  unnecessary.

## Merge conflicts

Adjacent, and it falls out of the same renderer.

The cheap part is where the content comes from. `git merge-tree --write-tree` already writes the
merged tree into the object database with the markers in it, and the mergeability check already runs
it to find out *which* paths conflict - so the conflicted content is in the repository before anybody
asks for it, and `DiffConflictsAction` reads it back with `cat-file`. No working tree is checked out
at any point, which is what makes this affordable on a page load rather than a job.

- [x] Parse conflict markers (`<<<<<<<`, `|||||||`, `=======`, `>>>>>>>`) into regions
- [x] Render a conflicted file with each region marked and its sides distinguished
- [x] Accept current, accept incoming, or accept both, per region - as a pure function over the
      parsed regions, so resolving one leaves the others exactly as git wrote them. The route that
      writes an answer back is phase 4's, and is deliberately not here.
- [x] Tests: nested markers, a marker appearing inside a string literal, a diff3-style conflict with
      a base section - plus one that builds a real conflict with real git and reads the blob
      `merge-tree` wrote, because every other test in the file is written against markers typed by
      hand, which is how a parser comes to handle a shape nobody produces.

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
- [x] A deterministic scroll driver: a fixed `scrollTop` sequence over a fixed duration, applied to
      the real scroll element, asserting the position after each step and returning a checksum. Never
      dispatch synthetic `scroll` events; they do not move browser scroll state.
- [x] A stable-page precondition checked before recording: the scroller exists, streaming has
      finished, and the worker pool is idle
- [x] Chrome traces via CDP with the renderer-main categories, one unrecorded warmup per sha, then at
      least three kept runs, alternating base and test so machine drift does not land on one side
- [x] An analysis script summarizing `UpdateLayoutTree`, `Layout`, and the paint/composite group per
      run, with average, median, min and max
- [x] Two modes: highlighting stubbed out (for CSS and layout work, where token spans are noise) and
      full production (for anything else). Never mix modes or browser headedness within a comparison.
      `?highlight=off` on both the manifest and the rows endpoint - both, because rows fetched
      coloured while the manifest was stubbed is one mode out of two. Every line becomes one plain
      token, which is the path a file over the tokenize ceiling already takes, so the markup differs
      in exactly one way: the spans carry no classes. Pinned by a test that the row count, the keys
      and the text are identical between the modes, since a stub that dropped or merged a line would
      have the two modes measuring different pages.
- [ ] A fixed corpus of test diffs committed or hosted: a 15 file pull request, a 5k line diff, a 30k
      line diff, and the Linux `v6.0...v7.0` compare. Host the large ones ourselves rather than
      hammering GitHub, which is what Pierre does for their demo links.
- [x] Results recorded per change with the sha, route, viewport, mode, and run count, so "this got
      slower" is answerable
- [x] A memory profile alongside the scroll trace: heap after load, after a full scroll, and after a
      forced GC. Three readings rather than two, and the middle one is what separates the two
      explanations of the same number: heap after scrolling says what the scroll retained, heap after
      collecting says what it retained that cannot be reclaimed. Reporting only the second cannot
      tell a leak from a collector that has not run; reporting only the first calls every
      uncollected byte a leak.

## Tests

Beyond the per-section tests above, the shapes that catch virtualizer bugs specifically:

- [ ] Partial hydration: server HTML for the first screen, hydrated into the viewer without a reflow
      or a re-render of what is already correct
- [x] Element pooling actually reuses nodes, asserted by identity rather than by count. In the
      browser probe rather than as a unit test, because the claim is about real elements surviving a
      real scroll and there is no DOM in the unit suite. Hosts are marked before the scroll and
      checked after: a count of mounts and recycles can be made to look right by a pool that hands
      back a fresh element every time, and identity cannot be. Surviving alone is not enough either,
      since a host the scroll never reached still carries its mark and has been reused for nothing -
      so what decides it is how many marked hosts are now showing a *different* file, and the probe
      states the verdict rather than leaving two numbers to be interpreted.
- [x] Scroll anchoring across collapse, expand, theme change, wrap toggle and a layout switch -
      every change the viewer makes that moves things, including the one that moves nothing and must
      therefore move nobody.
- [x] Estimated heights within a tolerance of measured heights, so the scrollbar does not lie. The
      header estimate came out of that: it was 40 pixels against a real 61.
- [ ] Range scroll to a line inside a collapsed hunk in a collapsed file
- [x] A stream that is aborted, retried, and completes, leaving no items from the first attempt.
      Writing it found that `yieldToBrowser` called `requestAnimationFrame` unguarded: the
      `setTimeout` behind it was written as the fallback for a backgrounded tab, but where the
      function is *missing* the call threw before the fallback could act. A race only works if both
      sides are optional.
- [x] Worker pool: a task cancelled mid-flight, a worker that dies, and a theme change with tasks
      queued. Needed a seam - the pool now opens its workers through a factory - because every branch
      worth testing here is one where a worker *misbehaves*, and a real worker cannot be made to.
      Two of the three found real bugs. A reset with work queued cleared the queue without resolving
      it, so every caller waiting on one of those jobs waited forever: not a slow page, a page that
      never finishes, and a theme change is exactly when it would happen. And the fixture was under
      the worker threshold on the first run, so all seven tests passed through the inline path
      instead of the pool - caught only because the first assertion in the block is that the fixture
      is big enough to reach a worker at all.
- [x] The no-JavaScript path still renders the first screen and its threads. `tests/e2e/review-page.test.ts`,
      described under *The standard to hold*, and it found a real bug on its first run.

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
