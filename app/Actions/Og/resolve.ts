import type { CardCopy } from './card'
import { resolveOwner } from '../Identity/lookup'
import { repositoryForView } from '../Repo/forView'

/**
 * Turn a request path into the copy its card should carry.
 *
 * **Everything here is resolved as a stranger.** `repositoryForView` is called
 * with no cookies, so a private repository resolves to null exactly as it does
 * for an anonymous reader, and a card is never drawn for something the person
 * who would see the card may not see. This matters more than usual because the
 * reader of a card is not a person at all: it is whatever server unfurled the
 * link, and it arrives with no session and often from a different network than
 * the person who pasted the URL.
 *
 * Null means "no card worth drawing", and the caller answers with the generic
 * site card rather than with an error - a preview that says ReviewOS is a fine
 * answer for a page that has nothing more specific to say, and a 404 on an
 * `og:image` is a broken image in somebody's chat window.
 */

/** Repository sub-pages whose card is the repository's own. */
function trimmed(text: unknown, limit: number): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()

  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}...`
}

/** `open`, `closed`, `merged`, `draft` - said in words a reader recognises. */
function pullState(row: { state?: unknown, draft?: unknown, merged_at?: unknown }): string {
  if (row.merged_at)
    return 'Merged'
  if (String(row.state ?? '') === 'closed')
    return 'Closed'
  if (row.draft)
    return 'Draft'

  return 'Open'
}

async function profileCard(handle: string): Promise<CardCopy | null> {
  const owner = await resolveOwner(handle)
  if (!owner)
    return null

  const table = owner.kind === 'user' ? 'users' : 'organizations'
  const row: any = await db
    .selectFrom(table as never)
    .selectAll()
    .where('id', '=', owner.id)
    .executeTakeFirst()

  if (!row)
    return null

  // An organization describes itself in `description` and a person in `bio`,
  // and either may be empty - in which case the card carries the handle alone,
  // which is still the page's identity and still worth a preview.
  const about = owner.kind === 'user' ? row.bio : row.description

  return {
    eyebrow: owner.kind === 'user' ? 'Profile' : 'Organization',
    title: String(row.name ?? '').trim() || `@${owner.handle}`,
    subtitle: trimmed(about, 150) || `@${owner.handle} on ReviewOS`,
  }
}

export async function cardCopyFor(path: string): Promise<CardCopy | null> {
  const segments = String(path ?? '').split('?')[0]!.split('/').filter(Boolean)
  const [handle, name, section, number] = segments

  if (!handle)
    return null

  if (!name)
    return profileCard(handle)

  // No cookies: a stranger's view, which is the only view a scraper has.
  const access = await repositoryForView(handle, name)
  if (!access)
    return null

  const repository: any = access.repository
  const slug = `${handle}/${name}`

  if (section === 'pull' && number) {
    const pull: any = await db
      .selectFrom('pull_requests')
      .select(['number', 'title', 'state', 'draft', 'merged_at', 'changed_files', 'additions', 'deletions'])
      .where('repository_id', '=', Number(repository.id))
      .where('number', '=', Number(number))
      .executeTakeFirst()

    if (pull) {
      const files = Number(pull.changed_files ?? 0)

      return {
        eyebrow: `${slug} · Pull request #${pull.number}`,
        title: trimmed(pull.title, 110),
        // The shape of the change, which is what a reviewer deciding whether
        // to open the link actually wants from a preview: how big is this.
        subtitle: [
          pullState(pull),
          files ? `${files} file${files === 1 ? '' : 's'} changed` : '',
          Number(pull.additions ?? 0) || Number(pull.deletions ?? 0)
            ? `+${Number(pull.additions ?? 0)} -${Number(pull.deletions ?? 0)}`
            : '',
        ].filter(Boolean).join(' · '),
      }
    }
  }

  if (section === 'issue' && number) {
    const issue: any = await db
      .selectFrom('issues')
      .select(['number', 'title', 'state', 'comments_count'])
      .where('repository_id', '=', Number(repository.id))
      .where('number', '=', Number(number))
      .executeTakeFirst()

    if (issue) {
      const comments = Number(issue.comments_count ?? 0)

      return {
        eyebrow: `${slug} · Issue #${issue.number}`,
        title: trimmed(issue.title, 110),
        subtitle: [
          String(issue.state ?? 'open') === 'closed' ? 'Closed' : 'Open',
          comments ? `${comments} comment${comments === 1 ? '' : 's'}` : '',
        ].filter(Boolean).join(' · '),
      }
    }
  }

  /*
   * Everything else under a repository gets the repository's own card: a file
   * at a path, a commit, a compare range, the issue list. Those pages are
   * shared as often as the repository root and there is nothing better to say
   * about a tree listing than which repository it belongs to.
   */
  const stars = Number(repository.stars_count ?? 0)
  const openIssues = Number(repository.open_issues_count ?? 0)

  return {
    eyebrow: handle,
    title: name,
    subtitle: trimmed(repository.description, 140)
      || [
        stars ? `${stars} star${stars === 1 ? '' : 's'}` : '',
        openIssues ? `${openIssues} open issue${openIssues === 1 ? '' : 's'}` : '',
      ].filter(Boolean).join(' · ')
      || 'A repository on ReviewOS',
  }
}
