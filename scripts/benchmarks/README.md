# Benchmarks

Two halves, because the diff engine has two.

## The server half

`diff-engine.ts` measures everything that happens before a browser is involved: git, the splitter,
the parser, the highlighter, the row renderer. It needs no browser, so it can run anywhere.

```bash
bun scripts/benchmarks/diff-engine.ts storage/repos/stacks/stacks.git v0.70.230 v0.70.231
bun scripts/benchmarks/diff-engine.ts storage/repos/stacks/stacks.git v0.70.0 v0.70.231 --rows --runs 5
```

It discards a warm-up run and reports the median of the rest, because the first pass pays for git's
caches and the JIT and otherwise reports a machine warming up. Heap is sampled per record rather
than read at the end: the point of the streaming design is that nothing accumulates, and a reading
taken afterwards would miss a peak in the middle.

## The browser half

`scroll-probe.js` measures whether the list keeps up once somebody is reading it. Paste it into the
console of a review screen, then:

```js
await __reviewosScrollProbe()
await __reviewosScrollProbe({ durationMs: 6000, steps: 360 })
```

It scrolls a fixed distance over a fixed wall time, so the same run takes the same time on a fast
machine and a slow one and the dropped-frame count means the same thing on both. Every step asserts
that the scroller went where it was told; `stepMismatches` above zero means the numbers describe a
different scroll than the one asked for, and the run should be discarded.

What it reports, and why each is there:

- `droppedFrames` against `droppedOverMs`, which is **1.5 times** the 60fps budget rather than the
  budget itself. A page holding a steady sixty reports a median frame of almost exactly 16.7ms, so
  counting anything over the budget calls half of a perfect run dropped. The first version of this
  did exactly that and reported 44% on a page that never stuttered.
- `viewer.mounts` against `viewer.recycled`. The claim the design rests on is that rows are recycled,
  so mounting is a function of how far somebody scrolled rather than of how large the diff is. A
  `recycled` count near `mounts` is that claim holding.
- `heapMb.grew`. Memory after a long scroll should settle near where it started.

## Chrome traces

The probe says whether frames were dropped. `trace.ts` says which phase dropped them.

```bash
bun scripts/benchmarks/trace.ts http://localhost:3000/stacks/stacks/pull/9001/files --runs 3
```

It launches headless Chrome against a throwaway profile, waits for the page to settle, records a
trace while running the same scroll driver, and totals renderer-main time per phase: style and
layout, paint and compositing, script, and HTML parsing. `cdp.ts` is the client, which is a
WebSocket and four methods rather than a browser-automation dependency.

Waiting for the page to *settle* means more than waiting for the file list. Heights are estimates
until their file has been mounted and measured, so the scrollable range keeps moving after the last
record lands; the runner waits for it to hold still, because two runs over different ranges are not
comparable. `stepsClamped` in the output counts steps that asked for more than the list had left,
which is ordinary at the very end and a sign the page had not settled if there are many.

Headless and headed traces are not comparable to each other: compositing differs, and headless runs
uncapped rather than at the display's refresh rate. Pick one and stay with it.

## Comparing two commits

```bash
git worktree add /tmp/bench-base <base-sha>
git worktree add /tmp/bench-head <head-sha>
# install and start a dev server in each, on its own port

bun scripts/benchmarks/compare.ts \
  --base http://localhost:3000/stacks/stacks/pull/9001/files \
  --head http://localhost:3001/stacks/stacks/pull/9001/files \
  --runs 3
```

It alternates one run each rather than measuring one side to completion and then the other.
Anything that changes over the minute in between - a background job, thermal throttling, a cache
filling - would otherwise land entirely on one side and read as a regression.

### The noise floor

Found by running it against the same URL on both sides, which is the only honest way to find one.
On this machine the three large metrics drift 2 to 4 percent between identical runs, so a change has
to clear **5 percent and 5 milliseconds** before it is called one.

Both bars matter. `ParseHTML` totals under thirty milliseconds over a four second scroll, so two
milliseconds of ordinary drift is six percent of it, and the first version of this called two
identical URLs "slower" on exactly that. Run it against itself after changing the thresholds; if it
finds a difference, the thresholds are wrong.

It does not build or serve anything. Two dev servers, two databases and two builds is a lot of
machinery to get subtly wrong, and a misconfigured server produces confident numbers.
