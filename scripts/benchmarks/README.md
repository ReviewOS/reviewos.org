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
- `firstScreen.rowRequestsBeforeScrolling`. The design says the server renders the first files' rows
  while it is already parsing the diff for the manifest and sends them on the same stream, so a
  reader's first screen costs no second request. Zero is that working; anything else means the first
  screen was fetched, which looks exactly like the server being slow rather than like the client
  asking twice.

## A diff too large to watch load

A diff of eighty thousand files takes this server about thirty seconds to compute and stream, nearly
all of it git. On a machine where a scripted browser does not live that long - a headless renderer
here is killed after about thirty seconds whatever the page is doing, `about:blank` included - the
page spends its whole life waiting and never reaches the part being measured.

So measure the two halves apart. The server's, with no browser in it:

```bash
time curl -s -o /dev/null "$SERVER/api/repos/pulls/diff/manifest?owner=o&repo=r&number=1"
```

and the client's, with no server in it:

```bash
curl -s "$SERVER/api/repos/pulls/diff/manifest?owner=o&repo=r&number=1" > kernel.ndjson
bun scripts/benchmarks/replay.ts --capture kernel.ndjson --upstream "$SERVER"
```

`replay.ts` proxies the real page to the real instance and serves the manifest from the capture -
the same records, byte for byte, at the speed of a disk. Point the probe or `trace.ts` at the port
it prints.

What it does not prove is that the two work together, and the comment at the top of the file says
so. Before believing any "the page stopped answering" result, run a blank page for the same
duration: that control is what turned an apparent stall in the viewer into a fact about this
machine.

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

`ab.ts` does the whole thing: two worktrees at two shas, both built in production mode, both served
on their own port, then `compare.ts` between them, then both worktrees removed.

```bash
bun scripts/benchmarks/ab.ts --base HEAD~1 --head HEAD \
  --path /owner/repo/pull/1/files --runs 3
```

`--dry-run` stands both sides up, says where they are, and takes them down again without building
or tracing. That is how the parts that fail *silently* - the worktree, the symlinked
`node_modules`, the removal - get exercised in three seconds rather than in twenty minutes.

Three choices in it are load-bearing:

- **Worktrees, not clones.** A worktree shares the object database, so a side stands up in a second
  and there is no chance of the two being built from different histories.
- **`node_modules` is symlinked, not installed twice.** Two installs is two chances for the
  dependency trees to differ, and a difference there is measured as a difference in *this*
  repository, which is the one thing an A/B of this repository must not do.
- **The server is waited for by asking it**, not by sleeping. A fixed wait is too short on a cold
  machine - where the first trace then measures a server still starting - and wasted time on a warm
  one.

Both worktrees are removed by the exact paths the script created and by nothing else. `--keep`
leaves them, for when a run found something worth poking at.

The manual form still works, and is what `ab.ts` ends up calling:

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

`compare.ts` itself still does not build or serve anything, and that separation is deliberate: it
takes two URLs and alternates between them, which is the part that cannot be done by hand.
`ab.ts` is the machinery around it, kept separate so that a run against two servers somebody
started themselves remains one command rather than a special case.
