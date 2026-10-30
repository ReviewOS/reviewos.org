// The reader's light/dark choice, applied before anything paints.
//
// A file rather than an inline block, because these pages do not load the stx
// runtime and stx lifts an inline <script> in a template into that runtime's
// client-block pipeline - where, with no runtime on the page, it is compiled
// and then dropped. `layouts/app.stx` can write the same three lines inline
// for exactly that reason: the product pages do load the runtime.
//
// It reads the key `resources/functions/diffprefs.ts` writes and sets the
// attribute its `applyColourScheme` sets, so the two cannot disagree. Keep it
// blocking and keep it in the head: read a frame late and the reader watches a
// light page turn dark.
try {
  const stored = JSON.parse(localStorage.getItem('reviewos:diff') || '{}')
  const scheme = stored && stored.scheme
  document.documentElement.dataset.theme = scheme === 'light' || scheme === 'dark' ? scheme : 'system'
}
catch (error) {
  document.documentElement.dataset.theme = 'system'
}
