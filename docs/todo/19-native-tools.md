# Phase 19 - Native repository tools

Packages, documentation and planning are part of the forge. Pantry is the package engine, BunPress
is the Markdown engine, and project cards refer to the issues and pull requests already here.

## Package registry

- [x] Wrap Pantry publishing, version metadata and tarball downloads with repository authorization.
- [x] Store package ownership through a model and a unique scoped name, with generated migrations.
- [x] Add native package read/write token scopes, browser publishing, package listings and downloads.
- [x] Honor `packages: write` in pipeline permissions, retaining repository and fork restrictions.
- [x] Document private Pantry service configuration, storage backups and publishing.
- [x] Verify publishing, duplicate versions, download privacy and service credential isolation.

## Markdown wiki

- [x] Model wiki pages and immutable revision history, with generated migrations and repository access.
- [x] Ship a safe user-document renderer in BunPress, consume its published release, and test that
      raw HTML, stx and local includes cannot execute.
- [x] Provide create, edit, read, history, restore, delete and raw Markdown download screens and APIs.
- [x] Resolve page and heading links and reject stale edits, including concurrent first saves.
- [x] Exercise signed-in cookie and CSRF form submission through the real router.

## Projects and boards

- [x] Model projects, ordered columns and issue-backed cards as native relational forge data.
- [x] Provide board and list views, live issue titles/state, search, state filtering and issue linking.
- [x] Support custom columns, column order, card order, card moves, removal and project close/reopen.
- [x] Serialize board writers, reject stale card edits, and prevent cross-project/repository attachments.
- [x] Apply read, triage and write permissions, token reach and archive rules to every endpoint.

## Integration

- [x] Add repository navigation and token settings for all three native features.
- [x] Replace the homepage's deferred claims with implemented features and link their documentation.
- [x] Verify relevant tests, model migrations, lint, type checks and browser layouts.

## Upstream fixes and verification

The integrations use the tools' native APIs. Fixes discovered here landed in their owning projects:

- BunPress 0.2.29 adds `renderUntrustedMarkdown`, a closed renderer that cannot execute stx or
  includes. Its renderer tests cover hostile HTML, URLs, templates and file directives.
- Pantry commits `15fa23096` and `3f1635ccd` make version insertion atomic, preserve content-addressed
  artifacts across concurrent publishes, verify legacy checksums, and expose the engine's actual npm
  fallback policy. The forge refuses public, unauthenticated or fallback-enabled backing services.
- bun-query-builder 0.3.25 correctly replaces model-generated foreign keys when delete behavior
  changes, including snapshots without introspected constraint names.
- Stacks commit `372b15eb63` distinguishes a constraint drop from a shadowed column drop in the
  migration guard. Both dialects' migrations are generated; MySQL migrations were applied here.
- stx 0.2.574 supplies its existing server-to-client value bridge, so the Markdown editor uses native
  typed props and reactive state without a browser bootstrap workaround.

The complete application unit suite passes (5,203 tests, two existing skips), along with the focused
router, session, CSRF and token regressions. The native-tools suite also passes against a real Pantry
registry build. Lint, type checks, documentation builds, light/dark layouts and the mobile board and
Markdown preview were verified.
