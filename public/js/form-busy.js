/**
 * Every form that changes something says so while it is doing it.
 *
 * Wired once, here, rather than a flag per form. There are around eighty submit
 * buttons in this product that post, across thirty-odd files, and a pattern
 * copied eighty times is a pattern that is wrong in a few of them.
 *
 * Plain JavaScript in `public/` rather than TypeScript in
 * `resources/functions/`, because that directory is imported by `<script
 * server>` blocks and never reaches the browser. The layout loads this the same
 * way it loads mermaid, and `tests/unit/form-busy.test.ts` imports this file
 * directly, so the rules below are the ones that ship.
 *
 * ## Why it never disables the button
 *
 * The obvious implementation is `button.disabled = true` in the submit handler.
 * It drops the button's own `name` and `value` from the body. Measured, not
 * assumed: two identical forms posting to a local echo server, one disabling
 * its submitter inside its own `submit` listener and one not.
 *
 *     control  -> field=v&operation=close
 *     disabled -> field=v
 *
 * The form still posts, so the failure is silent: the server simply never sees
 * `operation`. This product has ten such buttons - the bulk actions in
 * `RepoList.stx`, approve and deny in `cli/login.stx`, the column moves on a
 * project board, and the preview toggle in `MarkdownEditor.stx` - and every one
 * of them would have broken with no error anywhere.
 *
 * So the submitter keeps its name and its value, and the second press is
 * refused at the second `submit` event instead. The button is marked busy for
 * the reader and left alone for the browser.
 */

/**
 * What to do with one submit event.
 *
 * A GET form is a query rather than a change: the search box and the people
 * filter come back as an ordinary navigation, and a spinner on them is noise.
 * A submission something else already cancelled never left, so marking it busy
 * would leave a button spinning over a form that is not going anywhere.
 */
export function busyDecision(input) {
  const method = String(input && input.method ? input.method : '').toLowerCase()

  if ((input && input.defaultPrevented) || method !== 'post')
    return { mark: false, cancel: false }

  // The second press of a button whose first press is still in flight: the
  // whole point of the exercise, and the only case that cancels anything.
  if (input && input.busy)
    return { mark: false, cancel: true }

  return { mark: true, cancel: false }
}

/**
 * What a busy button should read.
 *
 * `data-busy-label` where a word is clearer than a spinner alone - "Saving..."
 * under a button that said "Save". Left alone otherwise, because the verbs here
 * are not interchangeable: a generic "Saving..." over "Delete", "Revoke" or
 * "Merge pull request" would name the wrong action, which is worse than naming
 * none.
 */
export function busyLabel(current, requested) {
  const wanted = String(requested === null || requested === undefined ? '' : requested).trim()

  return wanted.length > 0 ? wanted : current
}

/** Attach the behaviour to a document. */
export function install(root) {
  root.addEventListener('submit', (event) => {
    const form = event.target

    if (!form || form.tagName !== 'FORM')
      return

    const decision = busyDecision({
      method: form.method,
      busy: form.dataset.busy === '1',
      defaultPrevented: event.defaultPrevented,
    })

    if (decision.cancel) {
      event.preventDefault()
      return
    }

    if (!decision.mark)
      return

    form.dataset.busy = '1'

    const button = event.submitter

    if (!button || button.tagName !== 'BUTTON')
      return

    button.setAttribute('aria-busy', 'true')
    button.classList.add('is-busy')

    // Kept so `clearBusy` can restore it. A navigating form never needs this,
    // because the page it is replaced by renders the label fresh.
    const was = button.textContent.trim()
    const next = busyLabel(was, button.dataset.busyLabel)

    if (next !== was)
      button.dataset.busyWas = was

    button.textContent = next
  })

  /*
   * Coming back leaves a button spinning over a form nobody is submitting any
   * more: the back/forward cache restores the page as it was at navigation,
   * which is mid-submit.
   */
  const view = root.defaultView

  if (view) {
    view.addEventListener('pageshow', (event) => {
      if (!event.persisted)
        return

      for (const form of root.querySelectorAll('form[data-busy="1"]'))
        clearBusy(form)
    })
  }
}

/**
 * Let a form go again, and put its button back the way it was.
 *
 * Needed by anything that handles a submit itself rather than letting the
 * browser navigate: without the navigation there is nothing to replace the
 * page, so the marks have to come off deliberately. `form-live.js` calls this
 * when its request finishes, and `pageshow` calls it for a page restored
 * mid-submit from the back/forward cache.
 */
export function clearBusy(form) {
  form.removeAttribute('data-busy')

  for (const button of form.querySelectorAll('button.is-busy')) {
    button.classList.remove('is-busy')
    button.removeAttribute('aria-busy')

    if (button.dataset.busyWas !== undefined) {
      button.textContent = button.dataset.busyWas
      delete button.dataset.busyWas
    }
  }
}

// A browser gets the behaviour on import; a test importing the rules above
// gets only the rules, because it has no document to install into.
if (typeof document !== 'undefined')
  install(document)
