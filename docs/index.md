---
title: ReviewOS
layout: home
hero:
  name: ReviewOS
  text: A git forge built around review
  tagline: Open source, self-hostable, and organized around the part of the workflow everyone actually spends their time in.
  actions:
    - theme: brand
      text: Roadmap
      link: /todo/
    - theme: alt
      text: Browse the source
      link: https://reviewos.org/reviewos/reviewos.org
features:
  - title: Review is the primary object
    details: Approvals, requested changes, and threads anchored to a file, line, and side of the diff. Not a tab bolted onto a pull request.
  - title: Stacked pull requests
    details: Dependent changes that merge in order, so a large piece of work can be reviewed in pieces that each make sense.
  - title: Yours to host
    details: Your repositories on your disk, your data in your Postgres. No seat counts and no plan tiers.
---

## What this is

ReviewOS is an open source git forge: repositories, issues, and pull requests, in the same territory
as GitHub, Codeberg, and Tangled. What separates it is the emphasis. Most forges treat code review
as a feature of pull requests. Here it is the thing the rest of the product is arranged around.

It is built on [Stacks](https://stacksjs.com), runs on [Bun](https://bun.sh), and stores its data in
PostgreSQL. Repositories are ordinary bare git repositories on disk, driven by the git binary, so
nothing about your data is locked inside this application.

## Where it is

Early. The [roadmap](/todo/) is the honest picture: each phase is a checklist, and boxes are ticked
only when the work is done and verified. If a box is empty, assume the feature does not exist.

## Running it

```bash
git clone https://github.com/ReviewOS/reviewos.org.git
cd reviewos.org
./buddy setup
./buddy dev
```

`./buddy setup` installs Bun, PostgreSQL, and git through pantry, starts the database, creates the
schema named in your `.env`, and runs the migrations. You do not need any of those installed
beforehand.
