# 07 - Marketing and documentation

The public face: what reviewos.org shows a visitor, and the documentation someone reads when they
decide to run it.

## Landing page

- [x] Design and build `resources/views/index.stx` using the `stacks-design-taste` skill
- [x] Nav and footer as components in `resources/components/`
- [x] Light and dark, following the skill's dark mode protocol
- [x] No em-dashes in any user-visible copy, per the house pre-flight rule
- [x] stx signals and composables only; no vanilla DOM access in templates
- [x] Iconify classes for icons, no icon packages and no hand-rolled SVG paths
- [x] Styling is a scoped `<style>` block over CSS custom properties rather than Crosswind
      utilities, because the page carries its own two-theme token set. Revisit if the marketing
      page and the application need to share a system.
- [x] Responsive down to a phone, with the hero legible without scrolling
## Marketing site structure

Modelled on the uptimestatus marketing site: one catalog feeding the navigation, a page per
feature, a page per use case, and comparisons that say plainly what the alternative does better.

- [x] `resources/functions/marketing.ts` as the single catalog of features, use cases, and
      comparisons, so a page and its menu entry cannot drift apart
- [x] `resources/views/layouts/marketing.stx` shared by every marketing page below the landing one
- [x] Features mega menu, grouped into Review, Repositories, Automation, and Operations, built from
      the catalog and present on the landing page too
- [x] A page per feature under `/features/<slug>`, twelve of them, each with its own argument
      rather than a restatement of the summary
- [x] Agentic usage as a first-class feature: `/features/agentic-review`, and a use case at
      `/for/ai-assisted-teams`, because review is the control that matters when agents write
      most of the diffs
- [x] Use cases mega menu and a page per audience under `/for/<slug>`
- [x] Comparison pages under `/compare/<slug>` for GitHub, GitLab, and Forgejo, each stating what
      the alternative genuinely does better
- [x] Index pages at `/features`, `/for`, and `/compare`
- [x] Footer linking every feature, use case, and comparison
- [x] Navigation reordered around the product rather than the argument: Discover promoted to the
      top bar on both the landing page and the shared marketing layout, Use cases and Compare
      demoted to the footer, which now links every page in both catalogs rather than the subset
      that fitted in a mega panel
- [x] Sign in and sign up in the top bar, on the marketing pages and inside the product. The
      landing page's only call to action was "self-host it", so somebody who wanted an account on
      this instance had to guess the URL; `/login` and `/register` both existed and nothing
      pointed at either. `AccountNav` replaces `SettingsLink`, which rendered nothing at all to a
      signed-out reader
- [x] Social sign-in on both auth pages, drawn from the framework's `configuredSocialProviders()`
      so a provider whose keys are missing never renders as a button that fails. GitHub, Google,
      Apple and the rest light up as their keys are set; see `app/Actions/Auth/social.ts`
- [x] "Browse the source" points at this instance rather than at GitHub, along with the clone
      command, the nav, both footers, and the docs hero. A forge that sends its own readers to a
      competitor to read its own code has not made its case. The GitHub mirror stays linked and
      labelled
- [x] Featured repositories on the landing page: real repositories on this instance, with live
      star counts and languages, placed where the argument runs out. Curated in
      `app/Actions/Explore/featured.ts` rather than computed, because trending and recently-active
      both rank by accidents of the import on a freshly mirrored instance
- [ ] Pricing page, if a hosted offering ever exists
- [ ] Per-feature screenshots, once the review interface renders real data

## Landing page

- [ ] Screenshots of the actual review interface, once phase 4 exists. Placeholders now, replaced
      then; shipping invented screenshots of software that does not exist yet is not acceptable.
- [x] Contrast measured rather than eyeballed: every text pair passes WCAG AA in both themes
- [x] Remove the leftover template assets in `resources/assets/` (3.1 MB: eight national-park
      illustrations, eight fonts, a demo stylesheet and a demo script). Nothing referenced any of
      it but the two template blog posts, which went too - `content/blog/` shipped "Introducing
      Stacks", and `config/blog.ts` was titled The Stacks Blog with stacksjs.com as its canonical
      URL, so a blog build here would have published another product's branding.
- [x] Open Graph and Twitter card metadata, with a generated social image. First shipped as one
      card, written as HTML and screenshotted through headless Chrome by `buddy social:card` - a
      Chrome dependency for one image, which is why there was one image.
- [x] A card per page, and a complete `<head>` on every page. `config/images.ts` declares one card
      per route and `buddy generate:images` draws all of them with ts-images, no browser in the
      pipeline; the copy for features, use cases and comparisons is derived from the catalog in
      `resources/functions/marketing.ts` so a card cannot quote a headline the page no longer has.
      `resources/functions/meta.ts` resolves the canonical URL, the card and the robots policy from
      the request path, and both layouts render the full set - description, canonical, `og:*` with
      the image's dimensions, `twitter:card`, and `noindex` on the personal and unbounded views.
      Every view now declares a title and a description, which a test enforces.
- [x] Cards for the pages a build cannot enumerate. A repository, a pull request, an issue and a
      profile get a card drawn on request by `/api/og`, cached on disk and keyed on what the card
      says, so a rename redraws it with nothing to invalidate. Everything is resolved as a stranger,
      so a private repository gets the generic site card and no confirmation that it exists.
- [ ] Lighthouse pass: no layout shift, fonts preloaded, images sized

      Measured rather than assumed, in a browser against the served page. **Layout shift is zero**
      across repeated loads, with no shift entries recorded at all, and **there is nothing to size**:
      the page carries no images, because the icons are Iconify classes and the product shot is a
      terminal drawn in CSS. Two of the three are done and were done by construction.

      What is left is the fonts, and it is a decision rather than an oversight. The page loads Geist
      from `fonts.googleapis.com`, which is the one render-blocking third-party request on it (125ms
      cold, cached afterwards) and the one thing that sends every visitor's address to somebody else
      - on a product whose whole argument is that you host it yourself. Self-hosting the two woff2
      files removes the round trip, the privacy leak and the single point of failure in one go, and
      it is the only option here that does not put a `link` with an `onload` handler in the markup.
      Left open because it means vendoring font binaries, which is a choice about what this
      repository carries.

      The measuring turned up something better than any of it: **the server was not compressing
      anything.** 253 KB of HTML, `Accept-Encoding: gzip` ignored, on every page of every request.
      Fixed upstream in `@stacksjs/bun-router` 0.0.24 - see the note in
      [00 - Bootstrap](./00-bootstrap.md).

## Documentation site

- [x] bunpress configured through `config/docs.ts`, served by `./buddy dev:docs`
- [x] The built site actually served at `/docs` in production. It was not, and the symptom was
      misread for a while as "the roadmap page is empty": nothing served `/docs` at all, so every
      documentation URL fell through to `[owner]/index.stx` and rendered "There is no account
      called docs here" - a not-found wearing a profile page. `resources/views/docs/` reads
      bunpress's output; the deploy builds it in `preStart`.

      Written first as a route with an action behind it, which is the shape the attachment and git
      routes use, and it never answered: this application resolves file-based stx views for
      everything outside `/api`, and the route registry belongs to the API process. Two further
      shapes lost to the view router's ranking before the working one - a `[page].stx` beside an
      `index.stx` loses to `[owner]/[repository]/index.stx`, and a `[page]/index.stx` wins. Social
      sign-in moved under `/api/auth/...` for the same reason.
- [x] Phases 14 and 15 in the docs sidebar. Both existed as files, were named in the roadmap's own
      table, and were built to HTML; neither was in `config/docs.ts`, so the two largest phases
      were reachable only from inside another page.
- [x] `.md` cross-links resolve. The roadmap files link to each other as `./00-bootstrap.md`,
      which is correct in the repository and on GitHub and which bunpress does not rewrite, so
      both names answer and the extensionless one is canonical.
- [x] Roadmap published as task lists that render as checkboxes
- [x] Roadmap index counts and "not started" states are checked by `tests/unit/roadmap.test.ts`, so
      completing work cannot leave the summary silently stale
- [x] Getting started: requirements, install, first repository, and what a push actually does
- [x] Configuration reference: every environment variable that matters, and what it does.
      `docs/configuration.md` is generated from `.env.example` and the source that reads each
      variable, so it says where a value is used, which ones the boot check validates, and which
      ones git sets for a hook rather than you. The hand-written table it replaced still named
      Meilisearch months after the move to Typesense, which is the argument for generating it.
- [x] Architecture: how a request becomes a git operation, where repositories live on disk, and the
      two planes checks run in
- [x] API reference for the JSON API, generated from the actions rather than written by hand.
      `buddy docs:reference` writes `docs/api.md` from the OpenAPI document and `docs/webhooks.md`
      from the payload module; `--check` and `tests/unit/docs-reference.test.ts` fail when the
      committed copies have drifted, because a generator nobody runs is a hand-written page with
      extra steps.
- [x] Webhook payload reference, every event from `WEBHOOK_EVENTS` with the envelope described once
- [ ] Declare the remaining endpoints' inputs on their actions. 48 of 157 operations carry a
      `validations` block; the other 109 validate inside the handler, so the document has nothing to
      publish for them and the page names the action instead of guessing. The test holds that count
      from growing, and it comes down a batch at a time: the repository endpoints - star, watch,
      fork, transfer, delete - went first, because `owner` plus `repo` is how every
      repository-scoped endpoint is addressed and a caller who forgets one was being told "no such
      repository". Then the issue endpoints: list, create, comment, assign, label, lock. Then
      opening, merging and requesting a review on a pull request, which is the surface an agent
      uses most. Then webhooks and tokens - the two endpoints where a 422 is the difference between
      "your URL is refused" and a delivery that silently never happens - and the coverage upload.

      The page also stopped telling readers to go and read an action that has nothing to say. An
      endpoint that wrote its own `responses` is taken at its word about its inputs: `POST
      /api/runner/claim` takes a credential in a header and nothing else, and now says so rather
      than pointing at `ClaimJobAction`.

      One thing to carry into the next batch. A declared rule is enforced, so a wrong one is an
      outage rather than a documentation gap: `assignees` and `labels` arrive as arrays, and
      declaring them as strings turned an ordinary request into a 422. Read the handler, not the
      field name.
- [x] Contributing guide: the model to migration to action to route to view order, and the
      expectation that roadmap boxes are ticked in the same commit as the work
- [x] Search across the docs. The overlay had been rendering, taking a query, and answering
      nothing: it fetches `/search-index.json`, which bunpress serves from 0.2.0 on, and the
      framework pinned `^0.1.18`. Bumped upstream, released as Stacks 0.70.370, and verified here -
      a query returns hits across the guides, the roadmap, and the generated API reference.

## Self-hosting guide

- [x] Requirements and sizing, with honest numbers rather than optimistic ones. Measured on a real
      instance: boot to serving, resident memory idle and after a hundred requests, ref
      advertisement and a full clone of a 190 MiB pack.
- [x] Install with pantry, and install with Docker. Both paths, with the systemd units for the
      non-Docker one and why `TimeoutStopSec` has to be above the drain window.
- [x] Reverse proxy and TLS, including the `x-forwarded-proto` that decides whether the session
      cookie is marked `Secure` - getting it wrong is a login that appears to work and returns you
      signed out.
- [x] SMTP configuration for notifications, starting with the fact that the default driver is `log`
      and sends nothing, which in production is a password reset nobody receives.
- [x] Backup and restore, covering both Postgres and the repository directory. Documented after
      restoring from it against a copy, not merely written.
- [x] Upgrading, including migrations, and which failure is the one where the answer is "restore"
      rather than "fix and re-run"
- [x] Hardening checklist: what an instance should look like before other people depend on it,
      every line of it covered elsewhere on the page

## Brand

- [ ] Wordmark and icon
- [ ] Favicon set
- [x] Colour and type scale recorded so the marketing page and the application agree.
      `docs/design.md` is generated from the three stylesheets that declare the palette, and
      `tests/unit/design-tokens.test.ts` fails when a token two of them share stops having the same
      value - which is how two copies of a palette drift, one hex at a time, with nothing failing
      because both files are valid CSS.
- [ ] Social preview image
