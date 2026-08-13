# Contributing

What to build, in what order, and what "done" means here.

## Pick something from the roadmap

[docs/todo](./todo/) is the plan, one file per phase, every line a checkbox. `docs/todo/index.md`
says which phases are in flight and what is deliberately deferred - read it before starting one,
because "not started" and "decided against for now" look the same from outside.

**Tick the box in the same commit as the work.** An unticked box that is actually done is worse than
no roadmap: the next person does it again. If you build something the roadmap does not mention, add
the line and tick it.

## The order to build in

Model, migration, action, route, test. Each step exists because skipping it costs more later.

**1. The model.** `app/Models/`, using `defineModel()`. Attributes carry their validation rule and a
realistic factory; relationships are declared as `hasMany` / `belongsTo` rather than an id column you
remember to join by hand; behaviour comes from traits rather than from code repeated per model.

A JSON blob standing in for a relation, or a comma-joined string standing in for rows, is a design
bug rather than a shortcut - it is unqueryable, unindexable, and it will be parsed by hand in six
places before anybody fixes it.

**2. The migration**, generated:

```bash
./buddy generate:migrations   # then read what it produced
./buddy migrate
```

Read the generated SQL before running it. That is the step that catches a column rename being read
as a drop and an add, which on a real instance is data loss.

**3. The action.** One per endpoint, in `app/Actions/<Domain>/`. Inputs go in `validations`, so the
validator and the generated OpenAPI document read the same object and cannot disagree. What the
endpoint answers goes in `responses`, so the sentence a client's author reads is the sentence the
person who wrote the endpoint wrote.

**4. The route**, in `routes/`. Check first whether `useApi` on the model already generates it.

**5. The test.** Unit tests for the reasoning, feature tests for the endpoint. A test that asserts
what the code does is worth less than one that asserts what somebody depends on: the interesting
cases are the malformed input, the private repository, the second identical request.

## Use the framework, not around it

Stacks and stx have an opinion about almost everything you are about to build. Where they do, that
opinion wins - most of what looks like a missing feature is a feature with a different name.

When the framework is genuinely in the way, **fix the framework**. Stacks, stx, bunpress and the
rest are local checkouts, and a workaround living in this repository hides the bug from every other
project that has it. A fix upstream, a rebuild, a verification from here, and a line in the roadmap
saying what it was.

Two rules that were both filed as stx limitations here and were both this codebase using the wrong
tool:

- **Pass non-strings with `:prop="value"`**, not `prop="{{ value }}"`. The interpolation form is
  string interpolation into an attribute, so an object arrives as `[object Object]` and an array as
  a comma-joined string. Scalars survive either form, which is exactly why the mistake gets through
  review.
- **A component imports nothing on its own.** A `.stx` component with no `<script>` block cannot
  reach `resources/functions`, and calling one there yields `undefined` rather than an error. Do the
  work in the view, where the imports are, and pass the result down.

## House rules

- **No em-dashes in anything a person reads.** Headlines, body copy, labels, buttons, alt text.
  A hyphen, a comma, or two sentences. It is the most common AI design tell and it is a pre-flight
  failure here.
- **Crosswind utilities** for styling, **Iconify classes** (`i-hugeicons-*`) for icons. No icon
  packages, no hand-rolled SVG paths, no animation library.
- **`repository`, not `repo`,** in models, routes, and anything user-visible. The domain vocabulary
  in `AGENTS.md` is short and worth reading once: owner, collaborator, pull request, review, review
  thread, stack.
- **Conventional commits.** `feat:`, `fix:`, `docs:`, `chore:`.
- **Comments explain why.** What the code does is visible; the constraint that made it look like
  that is not, and it is the thing the next person needs.

## Before you open a pull request

```bash
./buddy lint          # pickier, --fix for the mechanical half
./buddy typecheck     # app/, config/, resources/, routes/
./buddy test          # the suite
```

Two of those have failure modes worth knowing:

- `TESTS_REQUIRE_ALL=1 ./buddy test` turns a suite that skipped itself into a failure. A suite that
  skips because a service is not running is a suite that has been passing without running for
  months.
- The generated pages have a drift check: `buddy docs:reference --check` fails when the committed
  `docs/api.md`, `docs/webhooks.md` or `docs/configuration.md` no longer matches what the code
  produces. Run `buddy docs:reference` and commit the result.

## What gets a change turned down

Not much, and it is worth being explicit:

- A feature that makes the roadmap longer without making a review better. Breadth is cheap here and
  reviewing a hundred-file diff well is not.
- A workaround where the fix belongs upstream.
- A green box over work that is half done. If part of it is deferred, say so in the roadmap line
  rather than ticking around it.
