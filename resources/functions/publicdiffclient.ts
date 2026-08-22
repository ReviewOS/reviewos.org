/**
 * The token half of the public diff viewer, in the browser.
 *
 * Everything else about this page is server-rendered: the diff arrives as
 * markup, there is no highlighter in the browser, and a reader with no script
 * running gets the whole public diff. This exists for the one thing the server
 * cannot do, which is hold a credential that belongs to the person looking.
 *
 * ## Where the token lives, and where it does not
 *
 * `localStorage`, in this browser, under one key. It is sent as an
 * `Authorization` header on the request for this one diff and nowhere else:
 *
 * - **Not in the query string.** Every proxy between here and the server logs
 *   query strings, and a personal access token in a log file outlives the
 *   request by months.
 * - **Not in a form post.** Same reason, plus a form is the thing a page can be
 *   made to submit from somewhere else.
 * - **Not stored on the server.** The endpoint uses it for one outbound fetch
 *   and drops it. A viewer that stored the token would be asking a stranger to
 *   hand over a credential to somebody else's repositories.
 *
 * ## Why the server renders the rows and not this file
 *
 * The same reason the rest of the product does. Sending the patch back to be
 * rendered here would mean a second renderer in the browser, and the seam
 * between what the page rendered and what the script rendered is exactly where
 * a reader is looking.
 */

import { setDiffRequestHeaders } from './diffviewer'

const STORAGE_KEY = 'reviewos:view-token'

/**
 * Storage, if this browser has any we may use.
 *
 * Safari in private browsing throws on access, and so does a browser with
 * third-party storage blocked in a frame. A reader who cannot be remembered
 * still gets a working page - they just type the token again.
 */
function storage(): Storage | null {
  try {
    return window.localStorage
  }
  catch {
    return null
  }
}

function storedToken(): string {
  try {
    return storage()?.getItem(STORAGE_KEY) ?? ''
  }
  catch {
    return ''
  }
}

/** The target this page is showing, as the query every view endpoint takes. */
function targetQuery(): string | null {
  const parts = window.location.pathname.replace(/^\/+/, '').split('/')

  // `view/owner/repository/kind/ref…` - a compare range can carry slashes, so
  // everything after the kind is the ref. Which is also why the endpoints take
  // it in the query: a path parameter does not match across a slash.
  if (parts.length < 5 || parts[0] !== 'view')
    return null

  const [, owner, repository, kind, ...rest] = parts

  return `owner=${encodeURIComponent(owner!)}&repo=${encodeURIComponent(repository!)}`
    + `&kind=${encodeURIComponent(kind!)}&ref=${encodeURIComponent(rest.join('/'))}`
}

/**
 * The saved token, as a header the streamed viewer will carry.
 *
 * A large diff is not rendered into the page - it is streamed, by the same
 * viewer the review screen uses - and those requests need the reader's token
 * just as the rendered path does. Set before mounting, so the very first
 * manifest request carries it.
 *
 * Still a header and still never a query parameter, for the reason the rest of
 * this file exists: proxies log query strings.
 */
export function applyStoredToken(): void {
  const token = storedToken()

  if (token)
    setDiffRequestHeaders({ authorization: `Bearer ${token}` })
}

export function mountPublicDiff(): void {
  const input = document.querySelector<HTMLInputElement>('[data-view-token]')
  const save = document.querySelector<HTMLButtonElement>('[data-view-token-save]')
  const clear = document.querySelector<HTMLButtonElement>('[data-view-token-clear]')
  const status = document.querySelector<HTMLElement>('[data-view-token-status]')

  if (!input || !save || !clear)
    return

  const say = (message: string): void => {
    if (status)
      status.textContent = message
  }

  const held = storedToken()

  if (held) {
    // The value, not a placeholder: a reader has to be able to tell "a token is
    // saved" from "the box is empty", and the field is a password field.
    input.value = held
    say('A token is saved in this browser.')
  }

  const reload = async (token: string): Promise<void> => {
    const query = targetQuery()

    if (!query) {
      say('This page is not a diff.')
      return
    }

    const url = `/api/view/patch?${query}`

    say('Fetching…')

    let answer: Response

    try {
      answer = await fetch(url, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      })
    }
    catch {
      say('That request did not reach the server.')
      return
    }

    const body = await answer.json().catch(() => null) as
      | { ok?: boolean, html?: string, files?: number, message?: string, note?: string }
      | null

    if (!body) {
      say('The server answered with something unreadable.')
      return
    }

    if (!body.ok) {
      // The reason comes from the server, which is where the status and the
      // headers were. Repeating it verbatim is the point: it names which of the
      // four indistinguishable failures this is and what to do about it.
      say(body.message ?? 'That diff could not be fetched.')
      return
    }

    const root = document.querySelector<HTMLElement>('[data-diff-root]')
    const failure = document.querySelector<HTMLElement>('[data-view-failure]')

    if (root) {
      root.innerHTML = body.html ?? ''
    }
    else if (failure) {
      // The page rendered a failure rather than a diff, so there is no diff
      // element to fill: replace the explanation with one.
      const holder = document.createElement('div')
      holder.className = 'diff'
      holder.setAttribute('data-diff-root', '')
      holder.innerHTML = body.html ?? ''
      failure.replaceWith(holder)
    }

    say(body.note ?? `${body.files ?? 0} files.`)
  }

  save.addEventListener('click', () => {
    const token = input.value.trim()

    try {
      if (token)
        storage()?.setItem(STORAGE_KEY, token)
      else
        storage()?.removeItem(STORAGE_KEY)
    }
    catch {
      // Not being remembered is not a reason to refuse the fetch.
    }

    /*
     * A streamed diff reloads the page rather than being patched in place.
     *
     * The viewer is already mounted against a manifest fetched without the
     * token, and re-mounting it means unwinding a scroll position, a file list
     * and every measured height. A reload is one line and lands the reader
     * exactly where a fresh visit with a saved token would.
     */
    if (document.querySelector('[data-diff-stream]')) {
      say('Reloading with your token…')
      window.location.reload()
      return
    }

    void reload(token)
  })

  clear.addEventListener('click', () => {
    try {
      storage()?.removeItem(STORAGE_KEY)
    }
    catch {
      // Nothing to forget.
    }

    input.value = ''
    say('Forgotten.')
  })
}
