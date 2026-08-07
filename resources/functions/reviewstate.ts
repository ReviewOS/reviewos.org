/**
 * Where the reader got to, kept in two places on purpose.
 *
 * Local storage is the fast copy: synchronous, available before the first
 * frame, and the only copy a signed-out reader has. The server is the durable
 * one, and it is the reason this file exists - local storage survives a reload
 * and a closed tab, and forgets everything the moment somebody opens the same
 * pull request on a different machine. A review of two hundred files is exactly
 * the kind of thing that starts on a laptop and finishes at a desk.
 *
 * The order matters and it is always the same: write locally first, then tell
 * the server. A tick has to survive a reload pressed half a second later, and
 * that reload will beat any request. A failed request costs the reader nothing
 * they had before this endpoint existed.
 *
 * The server wins on load, rather than the two being merged. A union looks
 * kinder and is wrong: unticking a file on one machine would see it come back
 * from the other machine's stale cache, and a viewed mark that returns from the
 * dead is worse than one that never persisted.
 */

import type { StoredDraft } from './filelist'
import { writeHeaders } from './csrf'
import { readDraft, readViewed, writeDraft, writeViewed } from './filelist'

export interface ReviewStateEndpoints {
  /** GET. Answers for the signed-in reader, or says nobody is signed in. */
  state: string
  /** PUT, one file's mark. */
  viewed: string
  /** PUT, the whole draft, or an empty body to discard it. */
  draft: string
}

export interface ReviewStore {
  /**
   * The paths marked as read.
   *
   * The same Set for the life of the store, mutated in place. The file list
   * holds a reference to it and paints from it, so replacing it would leave
   * that reference pointing at the previous answer.
   */
  readonly viewed: ReadonlySet<string>
  setViewed: (path: string, viewed: boolean) => void
  draft: () => StoredDraft | null
  setDraft: (draft: StoredDraft | null) => void
  /** Called when the server's answer replaced what this machine had. */
  subscribe: (listener: (what: 'viewed' | 'draft') => void) => void
  /** Ask the server. Resolves either way; a failure leaves the local copy. */
  load: () => Promise<void>
}

interface ServerState {
  signed_in?: unknown
  viewed?: unknown
  draft?: unknown
}

/**
 * A draft out of a server response, or null.
 *
 * Checked field by field for the same reason the local storage reader checks
 * them: a draft put back on the wrong line is a comment about code it is not
 * about, and this one has crossed a network and a database on the way.
 */
export function draftFromServer(value: unknown): StoredDraft | null {
  if (value === null || typeof value !== 'object')
    return null

  const draft = value as Record<string, unknown>
  const side = draft.side === 'left' || draft.side === 'right' ? draft.side : null

  if (typeof draft.path !== 'string' || side == null || typeof draft.text !== 'string')
    return null
  if (!Number.isFinite(draft.from) || !Number.isFinite(draft.to))
    return null
  if (draft.text.trim() === '')
    return null

  return { path: draft.path, side, from: Number(draft.from), to: Number(draft.to), text: draft.text }
}

/** The paths in a server answer, ignoring anything that is not one. */
export function viewedFromServer(value: unknown): string[] {
  if (!Array.isArray(value))
    return []

  return value
    .map(entry => (entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>).path : entry))
    .filter((path): path is string => typeof path === 'string' && path !== '')
}

/**
 * The store the viewer talks to.
 *
 * `endpoints` is optional so a page that has not rendered them - and the tests
 * - get a purely local store with the same interface, rather than a second code
 * path guarded at every call site.
 */
export function createReviewStore(options: {
  scope: string
  endpoints?: ReviewStateEndpoints | null
  /** Injected in tests. Defaults to the global. */
  send?: typeof fetch
}): ReviewStore {
  const { scope, endpoints } = options
  const send = options.send ?? ((...args: Parameters<typeof fetch>) => fetch(...args))

  const viewed = readViewed(scope)
  let draft = readDraft(scope)
  const listeners: Array<(what: 'viewed' | 'draft') => void> = []

  const announce = (what: 'viewed' | 'draft') => {
    for (const listener of listeners)
      listener(what)
  }

  /**
   * Tell the server, and do not care very much whether it answers.
   *
   * Every one of these has already been written locally. A reader whose network
   * dropped, whose session expired, or who is reading a repository they cannot
   * comment on still gets the interface they had before - which is why nothing
   * here surfaces an error, and why the return value is discarded rather than
   * awaited by the caller.
   */
  const tell = (url: string, form: URLSearchParams): void => {
    void send(url, {
      method: 'PUT',
      headers: writeHeaders(),
      body: form,
    }).catch(() => {})
  }

  return {
    viewed,

    setViewed(path: string, on: boolean): void {
      if (on)
        viewed.add(path)
      else
        viewed.delete(path)

      writeViewed(scope, viewed)

      if (endpoints)
        tell(endpoints.viewed, new URLSearchParams({ path, viewed: on ? 'true' : 'false' }))
    },

    draft: () => draft,

    setDraft(next: StoredDraft | null): void {
      draft = next == null || next.text.trim() === '' ? null : next
      writeDraft(scope, draft)

      if (!endpoints)
        return

      // An empty body is how the draft is discarded, so a sent comment and a
      // deleted one are the same request. The anchor still travels with it:
      // the server ignores it when there is no text, and sending a draft with
      // no line to a server that later stops ignoring it would be a comment
      // anchored to nothing.
      tell(endpoints.draft, new URLSearchParams({
        path: draft?.path ?? '',
        side: draft?.side ?? 'right',
        from_line: String(draft?.from ?? 0),
        to_line: String(draft?.to ?? 0),
        body: draft?.text ?? '',
      }))
    },

    subscribe(listener: (what: 'viewed' | 'draft') => void): void {
      listeners.push(listener)
    },

    async load(): Promise<void> {
      if (!endpoints)
        return

      let state: ServerState | null = null

      try {
        const answer = await send(endpoints.state, { headers: { Accept: 'application/json' } })
        if (!answer.ok)
          return

        state = await answer.json() as ServerState
      }
      catch {
        // Offline, or a session that expired between the page rendering and
        // this request. The local copy is still the reader's, and it is what
        // they saw a moment ago.
        return
      }

      // A signed-out reader has no server-side progress, and taking the empty
      // answer as authoritative would wipe the local one for somebody whose
      // session merely lapsed.
      if (state?.signed_in !== true)
        return

      const paths = viewedFromServer(state.viewed)
      const sameViewed = paths.length === viewed.size && paths.every(path => viewed.has(path))

      if (!sameViewed) {
        viewed.clear()
        for (const path of paths)
          viewed.add(path)

        writeViewed(scope, viewed)
        announce('viewed')
      }

      const serverDraft = draftFromServer(state.draft)
      const sameDraft = serverDraft == null
        ? draft == null
        : draft != null
          && draft.path === serverDraft.path
          && draft.side === serverDraft.side
          && draft.from === serverDraft.from
          && draft.to === serverDraft.to
          && draft.text === serverDraft.text

      if (!sameDraft) {
        draft = serverDraft
        writeDraft(scope, draft)
        announce('draft')
      }
    },
  }
}
