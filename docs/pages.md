# Pages

Every repository can publish a website. Push, and the site a visitor reads is
the one your default branch describes.

```
https://<owner>.pages.example.com/<repository>/
```

It is what GitHub Pages is for, built the way the rest of this product is built:
the site is a job's output, the job runs where your CI runs, and the instance
publishes and serves it.

## What gets built

You do not choose a generator. The workflow reads the tree and picks:

| What is in the repository | What builds it |
| --- | --- |
| a `docs/` folder | [bunpress](https://github.com/stacksjs/bunpress) builds it as a documentation site |
| a bunpress config, no `docs/` | bunpress builds the markdown in the root |
| a `pages/` folder, or `index.stx` | [stx](https://github.com/stacksjs/stx) renders the templates |
| an `index.html` | it is already a site; it is published as it stands |
| none of those | nothing is published, and the run says so and passes |

A `docs/` folder needs no configuration at all. bunpress has a default for
everything, so a repository with nothing but markdown files gets a site with
navigation and search. A config anywhere bunpress looks —
`bunpress.config.ts`, `bunpress.config.js`, `.config/bunpress.ts`,
`docs.config.ts`, `.config/docs.ts` — is picked up and decides the title, the
sidebar and the theme.

**Markdown in the root, with no `docs/` folder, needs one of those configs.**
Not as a formality: without it there is no way to tell a documentation site from
a repository that happens to contain a `README.md`, a `CHANGELOG.md` and a
`CONTRIBUTING.md`, and publishing the second as a website is worse than
publishing nothing. The config is how you say "these files are the site".

## Turning it on

1. **Add the workflow.** The starter is on the repository's workflows page, or
   write `.github/workflows/pages.yml` yourself. All it has to do is upload an
   artifact named `pages` containing a tarball whose root is the built site:

   ```yaml
   - run: tar -czf pages.tar.gz -C dist .
   - uses: actions/upload-artifact@v4
     with:
       name: pages
       path: pages.tar.gz
   ```

2. **Switch Pages on** in the repository's settings, and choose who may read it.

That is the whole contract. Any workflow that produces that artifact publishes —
your own build, a generator this product has never heard of, a site you
assembled by hand.

## Who can read it

| Setting | Who sees the site |
| --- | --- |
| `repository` (default) | whoever may read the repository: everybody for a public one, a signed-in member for a private one |
| `public` | anybody, whatever the repository is |

The default is the careful one. Publishing a private repository's internal
documentation to the internet is a mistake that cannot be taken back, and making
somebody click a switch to share it is not.

A site nobody may read answers **404**, never 403. "You may not read this"
confirms that it exists, which is the one thing a private repository's site must
not do.

## What publishes, and what does not

A run publishes when **all** of these are true:

- it **succeeded**;
- it ran on the site's **source branch** (the repository's default branch unless
  you name another);
- it uploaded an artifact named **`pages`**;
- the archive has an **`index.html` at its root**.

The branch rule is not a convenience. A site has an address strangers read, so a
pull request — including one from a fork — must never be able to replace it.
That is [the fork rule](./ci-threat-model.md) applied to publishing rather than
to secrets, and it is enforced by the publisher rather than by what the workflow
file says, because the workflow file is a thing a contributor can propose.

When a publish is *attempted* and fails — a malformed archive, no `index.html`,
bytes that expired out of the store — the reason is written to the settings page
in a sentence. Runs that were never going to publish are silent; a repository
with Pages on and CI running has many, and "this run had no pages artifact" on
every one of them would bury the message that matters.

## Why the instance does not build your site

Because a documentation build **executes your code**. A `bunpress.config.ts` is a
TypeScript module. An stx template evaluates expressions. Running either inside
the ReviewOS process would put a docs config on the same process that holds the
database, the session signing keys, and every private repository on the box.

So Pages is a publisher, never a builder. Builds happen on the execution plane —
the same machines your CI already runs on, under the same isolation, with the
same fork policy. See [the threat model](./ci-threat-model.md) for the whole
decision.

The practical consequence: **an instance with no execution plane can publish a
committed static site and nothing else.** `index.html` in the repository is
copied, never run, so it needs no runner. A `docs/` folder needs one, because
building it means running bunpress.

## Custom domains

A site can answer at a name of your own:

```
docs.example.com  CNAME  <owner>.pages.example.com
```

Set the domain in the repository's Pages settings. Nothing about the site
changes; the same files are served under the new name.

Custom domains need a certificate for a name this instance does not own, which
is either an on-demand TLS gateway in front of it or a certificate per site.
An operator whose gateway can do neither should set `PAGES_CUSTOM_DOMAINS=false`,
so owners are not offered a setting that produces a certificate warning.

## For operators

Pages is **off until you give it a hostname**:

```dotenv
PAGES_DOMAIN=pages.example.com
```

There is no default, and the reason is the whole security model of the feature.
A published site is somebody else's HTML and JavaScript. If it were served under
the instance's own host, a script on it would share cookies, storage and
same-origin access with the forge — publishing a site would be handing its owner
a script tag on everybody's dashboard. A separate hostname is the boundary, and
one that has not been established cannot be worked around.

What you need:

- a wildcard DNS record, `*.pages.example.com`, pointing at the instance;
- a wildcard certificate for the same;
- a gateway rule sending that host to the instance. The instance answers Pages
  requests at `/_pages/{owner}/{repository}/…` as well as by `Host`, so either
  a `Host`-preserving proxy or a path rewrite works.

Sites are extracted to `storage/pages/<repository>/<commit>/` and served from
there. A publish writes the new commit's directory in full, points the site at
it, and only then removes the previous one — a request landing mid-publish reads
one site or the other, never half of each.

### Limits

| | |
| --- | --- |
| Site size | 1 GB expanded |
| Files per site | 100,000 |
| Browser cache | 60 seconds (`PAGES_MAX_AGE`) |

The cache is deliberately short. A documentation site's value is being current,
and "I pushed the fix and the page still says the old thing" is a complaint no
amount of explaining fixes.
