/**
 * Where a relative link or image in a repository's own text points.
 *
 * A README written for a git host says `![diagram](./docs/arch.png)` and
 * `[setup](docs/setup.md)`, and both are relative to *the file*, not to the
 * page the file is being rendered on. Left alone, the browser resolves them
 * against `/{owner}/{repository}` - so `./docs/arch.png` asks for
 * `/{owner}/docs/arch.png`, which is a different owner's repository or nothing
 * at all. Every image in every mirrored README was broken this way, and the
 * failure is silent: a broken image icon reads as "the upstream README is
 * broken" rather than as "this forge did not resolve it".
 *
 * Pure, and here rather than in the renderer, because the interesting part is
 * the path arithmetic and the two ways it can be wrong: `../../..` walking out
 * of the repository, and a URL that only *looks* relative. Both are tested.
 *
 * Nothing here decides whether a URL is safe to emit - `safeUrl` in `render.ts`
 * is the single answer to that, and it still runs on whatever this returns.
 */

/** The repository a piece of text belongs to, and where in it the text lives. */
export interface RepositoryUrlContext {
  owner: string
  repository: string
  /** The ref the text was read at. Without one, nothing below applies. */
  ref: string
  /**
   * The directory the document sits in, `''` at the root.
   *
   * `docs/README.md` makes this `docs`, so `./arch.png` beside it resolves to
   * `docs/arch.png` rather than to the repository root.
   */
  directory?: string
}

/**
 * Whether a reference already says where it points, and so must be left alone.
 *
 * Four kinds, and each of them would be damaged by resolution:
 *
 * - a scheme (`https:`, `mailto:`, and anything else - `safeUrl` decides which
 *   survive, not this)
 * - protocol-relative (`//example.com/x.png`)
 * - site-absolute (`/stacks/stacks/issues`), which is already a path on this
 *   forge and is how a README links to one
 * - a bare fragment (`#install`), which is a place on the page being read
 */
export function isAbsoluteReference(raw: string): boolean {
  const value = raw.trim()

  return value === ''
    || value.startsWith('#')
    || value.startsWith('/')
    || /^[a-z][a-z0-9+.-]*:/i.test(value)
}

/** A reference split into the part that is a path and the part that is not. */
export interface SplitReference {
  path: string
  /** `?query`, `#fragment`, or both, kept so a deep link survives resolution. */
  suffix: string
}

export function splitReference(raw: string): SplitReference {
  const match = /[?#]/.exec(raw)

  return match
    ? { path: raw.slice(0, match.index), suffix: raw.slice(match.index) }
    : { path: raw, suffix: '' }
}

/**
 * A relative path, resolved against the directory the document is in.
 *
 * Returns null when the result would leave the repository. `../../../etc/passwd`
 * in a README is not a link this can honour, and the honest answer is to leave
 * the reference exactly as written rather than to clamp it at the root and
 * point at a file that happens to share the name.
 *
 * Empty segments and `.` are dropped, which is what a browser does, so
 * `.//docs//setup.md` is `docs/setup.md`.
 */
export function resolveRelativePath(raw: string, directory: string): string | null {
  const segments = [
    ...String(directory ?? '').split('/'),
    ...String(raw ?? '').split('/'),
  ]

  const stack: string[] = []

  for (const segment of segments) {
    if (!segment || segment === '.')
      continue

    if (segment === '..') {
      // Above the root, and there is no honest answer below it.
      if (stack.length === 0)
        return null

      stack.pop()
      continue
    }

    stack.push(segment)
  }

  return stack.length > 0 ? stack.join('/') : null
}

/**
 * Where an image in repository text is fetched from.
 *
 * Not the raw endpoint. Raw serves every binary as `application/octet-stream`
 * with `nosniff` set, deliberately and correctly - see `app/Actions/Git/download.ts`
 * - and a browser will not render an `<img>` whose type says it is not an
 * image. The media endpoint is the narrow exception: a closed set of image
 * types, decided by the *bytes* rather than by the filename, under a CSP that
 * makes the response inert.
 */
export function repositoryMediaUrl(context: RepositoryUrlContext, path: string): string {
  const query = new URLSearchParams({
    owner: context.owner,
    repo: context.repository,
    ref: context.ref,
    path,
  })

  return `/api/repos/media?${query.toString()}`
}

/**
 * Where a relative link in repository text goes: the same browse screen a
 * reader would have reached by clicking through the file tree.
 *
 * The ref and the path are joined the way every other link on the browse
 * screen joins them, because a branch called `fix/rounding` is one name and a
 * URL that treats its slash as a separator points at a branch called `fix`.
 */
export function repositoryBlobUrl(context: RepositoryUrlContext, path: string): string {
  const owner = encodeURIComponent(context.owner)
  const repository = encodeURIComponent(context.repository)
  const ref = String(context.ref ?? '').replace(/^\/+|\/+$/g, '')

  return `/${owner}/${repository}/tree/${path ? `${ref}/${path}` : ref}`
}

/** Which of the two a reference resolves to. */
export type ReferenceKind = 'media' | 'link'

/**
 * The whole rule, in one call: a reference as written, and where it should
 * point on this forge.
 *
 * Returns the input unchanged whenever it should be - no context, no ref, an
 * absolute reference, a path that walks out of the repository - so the caller
 * can apply it to every URL it emits without deciding anything itself.
 */
export function resolveRepositoryReference(
  raw: string,
  kind: ReferenceKind,
  context: RepositoryUrlContext | null,
): string {
  if (!context?.owner || !context.repository || !context.ref)
    return raw

  if (isAbsoluteReference(raw))
    return raw

  const { path, suffix } = splitReference(raw)
  const resolved = resolveRelativePath(path, context.directory ?? '')

  if (!resolved)
    return raw

  // A fragment on an image is meaningless and a query on one would collide with
  // the endpoint's own, so the media URL takes the path and nothing else.
  return kind === 'media'
    ? repositoryMediaUrl(context, resolved)
    : `${repositoryBlobUrl(context, resolved)}${suffix}`
}
