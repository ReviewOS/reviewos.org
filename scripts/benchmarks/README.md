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

### What it deliberately does not do

It is not a Chrome trace. A trace attributes time to `UpdateLayoutTree`, `Layout` and `Paint`, and
that attribution is what a CSS, containment or scrollbar change needs. Capturing one requires the
DevTools protocol and a browser launched for it.

The two are complements: this says whether frames were dropped, a trace says which phase dropped
them. Reach for a trace when this reports a regression and the cause is not obvious.

### Comparing two commits

Neither script does this for you yet. The shape it wants is two git worktrees at two shas, both
built in production mode and both served, with runs alternating between them so machine drift does
not land on one side. Recorded in [phase 14](../../docs/todo/14-diff-engine.md) as still to build.
