/**
 * A form that posts without replacing the page.
 *
 * Opt-in, per form, with `data-live`. Everything else keeps submitting the way
 * it always has, because a full round trip is this product's default for a
 * reason and most forms are better for it: refresh does not re-post, the back
 * button lands somewhere sane, and a validation failure comes back rendered by
 * the server with every field still filled in.
 *
 * ## Nothing here was blocking it
 *
 * The server has answered both shapes all along. `respond()` returns a 303 only
 * when `Accept` carries `text/html` and JSON otherwise, which is how the CLI
 * and the API already talk to the same actions. The CSRF middleware takes the
 * `_token` field out of the body, which is the field the form already carries,
 * so this sends the form's own body and needs no second token path.
 *
 * What a form loses by not navigating is the page that would have answered it,
 * so each one has to say where the answer goes: an element inside the form
 * marked `data-live-status`.
 *
 * ## Why it is not `@submit.prevent` on the form
 *
 * A handler on the form runs before the one `form-busy.js` installs on the
 * document, so cancelling there means the submit arrives at the busy behaviour
 * already cancelled and the button never says anything. Installed here, after
 * that module, the order is: mark busy, cancel the navigation, send, clear.
 */
import { clearBusy } from './form-busy.js'

/** Whether this submit is one to handle rather than let the browser do. */
export function liveDecision(input) {
  const method = String(input && input.method ? input.method : '').toLowerCase()

  return Boolean(input && input.live) && method === 'post' && !(input && input.defaultPrevented)
}

/**
 * What to tell somebody, from what came back.
 *
 * The actions do not agree on a success shape - some answer `{ ok: true }`,
 * some add the thing they changed - and none of them carry a sentence for a
 * person. They do agree on `error`, because that is what the form page renders
 * when it redirects. So: the server's words when it has any, and a plain
 * fallback when it does not, rather than a shape every action would have to be
 * changed to satisfy.
 */
export function liveMessage(ok, body, says) {
  const answer = body && typeof body === 'object' ? body : {}

  if (ok) {
    // What the form asked for, when it named a field; then a message the
    // action happened to send; then the plain fallback.
    const named = says ? pick(answer, says) : ''
    const sent = typeof answer.message === 'string' && answer.message ? answer.message : ''

    return { ok: true, message: named || sent || 'Saved.' }
  }

  const error = typeof answer.error === 'string' && answer.error ? answer.error : 'That did not save. Try again.'

  return { ok: false, message: error }
}

/**
 * A field the form named, by dotted path, or `''`.
 *
 * `data-live-says="right_now.explanation"` rather than a rule in here about
 * which key holds the sentence. The actions do not agree on a success shape
 * and should not have to: the schedule endpoint answers with what your new
 * hours would do to a review request *right now*, which is the only part of
 * that response worth reading and is exactly what the full reload used to
 * discard. A form that names nothing gets "Saved.".
 */
export function pick(body, path) {
  let at = body

  for (const step of String(path).split('.')) {
    if (!at || typeof at !== 'object')
      return ''

    at = at[step]
  }

  return typeof at === 'string' ? at : ''
}

/**
 * Whether the answer means this page is now describing the wrong thing.
 *
 * The profile form can rename the account, and the page it sits on is full of
 * the old handle: the heading link, every repository URL under it. Staying put
 * would leave somebody looking at a page that says `/old` while they are
 * `/new`, which is worse than the reload this was avoiding. So a rename
 * reloads and everything else does not.
 *
 * The form names the field (`data-live-moved`) rather than this module knowing
 * it. Reading `body.handle` unconditionally was fine while one form was live
 * and becomes a trap as soon as a second one is: any action that answers with
 * a `handle` for its own reasons - the owner of the thing it just changed,
 * say - would reload a page that had not moved at all.
 */
export function movedAway(before, body, field) {
  if (!before || !field)
    return false

  const after = pick(body, field)

  return after.length > 0 && after !== before
}

function show(form, result) {
  const status = form.querySelector('[data-live-status]')

  if (!status)
    return

  status.textContent = result.message
  status.classList.toggle('is-bad', !result.ok)
  status.hidden = false
}

/**
 * A control that submits its form as soon as it changes.
 *
 * `data-live-change` on the control, rather than `onchange="this.form.submit()"`
 * in the markup, for two reasons that both matter.
 *
 * `form.submit()` **does not fire a submit event.** Nothing that listens for
 * one can see it: not the live save here, not the busy behaviour in
 * `form-busy.js`, not the guard that refuses a second submit while the first
 * is in flight. A form wired that way silently keeps posting the whole page
 * however many times it is marked `data-live`, which is the worst of both -
 * the opt-in says it stays put and it does not. `requestSubmit()` is the one
 * that behaves like a button press, so everything downstream still works.
 *
 * And inline `on*` script in a template is the vanilla JS this project does
 * not allow in `.stx` - see AGENTS.md. One listener here covers every such
 * control instead.
 */
export function changeSubmits(control) {
  return Boolean(control && control.dataset && control.dataset.liveChange !== undefined)
}

/**
 * The value the server rendered into a control: the last one it accepted.
 *
 * A `<select>` keeps its rendered choice in the `selected` *attribute* while
 * `value` follows whatever the reader picked, so the markup still says what
 * the database said when the page was built.
 */
export function renderedValue(control) {
  if (!control)
    return ''

  if (control.tagName === 'SELECT') {
    const chosen = typeof control.querySelector === 'function' ? control.querySelector('option[selected]') : null

    return chosen ? chosen.value : ''
  }

  return typeof control.getAttribute === 'function' ? (control.getAttribute('value') ?? '') : ''
}

/**
 * Put a submit-on-change control back where it belongs once the server answers.
 *
 * Without this a refused change leaves the control showing the value that was
 * refused: demote the only owner and the select reads "Member" beside the
 * sentence explaining that it is still Owner. The reload this replaced never
 * had that problem - the server re-rendered the truth - so staying put has to
 * do the same job, or the control quietly lies about what is stored.
 *
 * On success the accepted value becomes the one to come back to.
 */
export function settleControl(control, ok) {
  if (!control || !control.dataset)
    return ''

  if (ok) {
    control.dataset.liveGood = control.value

    return control.value
  }

  if (control.dataset.liveGood !== undefined)
    control.value = control.dataset.liveGood

  return control.value
}

export function install(root, send = fetch) {
  /*
   * Which control started each in-flight submit, so the answer can settle it.
   * A `WeakMap` keyed on the form, because a form removed from the page should
   * not be kept alive by this.
   */
  const changedControls = new WeakMap()

  root.addEventListener('change', (event) => {
    const control = event.target

    if (!changeSubmits(control))
      return

    const form = control.form

    if (!form || typeof form.requestSubmit !== 'function')
      return

    // The value to come back to if the server refuses. Taken from the markup
    // the first time, because that is what the database said when the page
    // was built, and from each accepted value after that.
    if (control.dataset.liveGood === undefined)
      control.dataset.liveGood = renderedValue(control)

    // Which control to settle once the answer arrives. On the form rather
    // than in a variable here: the submit is handled in the listener below,
    // one turn of the loop later.
    changedControls.set(form, control)

    // `requestSubmit`, never `submit`: see the note above.
    form.requestSubmit()
  })

  root.addEventListener('submit', async (event) => {
    const form = event.target

    if (!form || form.tagName !== 'FORM')
      return

    if (!liveDecision({ live: form.dataset.live !== undefined, method: form.method, defaultPrevented: event.defaultPrevented }))
      return

    event.preventDefault()

    let answer

    try {
      answer = await send(form.action, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(new FormData(form)),
      })
    }
    catch {
      /*
       * The network, not the server. Submitting natively hands the whole
       * problem back to the browser, which has a page for it and a retry
       * somebody already understands. `form.submit()` does not fire another
       * submit event, so this cannot loop.
       */
      form.submit()
      return
    }

    const body = await answer.json().catch(() => ({}))

    if (answer.ok && movedAway(form.dataset.liveWas, body, form.dataset.liveMoved)) {
      root.defaultView.location.assign(root.defaultView.location.pathname)
      return
    }

    clearBusy(form)

    // A submit-on-change control goes back to the last accepted value when the
    // server refuses, so it never shows a choice that was not taken.
    settleControl(changedControls.get(form), answer.ok)
    changedControls.delete(form)

    show(form, liveMessage(answer.ok, body, form.dataset.liveSays))
  })
}

if (typeof document !== 'undefined')
  install(document)
