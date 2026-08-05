import { route } from '@stacksjs/router'

/**
 * Uploaded files, at the root.
 *
 * Mounted with no prefix by `app/Routes.ts`, because the URL ends up written
 * into somebody's markdown and then copied into other issues, other
 * repositories, and eventually into a mirror on another host. A URL that is
 * going to outlive everything around it should be as short and as stable as it
 * can be, and `/attachments/{key}` is that: no owner, no repository name, and
 * so nothing in it that a rename can break.
 *
 * Served by an action rather than by the static file handler on purpose. An
 * attachment on a private repository's issue is exactly as private as the
 * issue, and a directory handed to the web server cannot know that. The key is
 * unguessable, which is worth something, but a name is not a permission.
 */
route.get('/attachments/{key}', 'Actions/Attachment/ServeAttachmentAction')
