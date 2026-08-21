/**
 * Where this project's own source lives, on this instance.
 *
 * Written down once because it is the answer to a question the marketing site
 * kept getting wrong: every "Browse the source" link pointed at GitHub, on a
 * page arguing that you should not need GitHub. A forge that sends its own
 * readers to a competitor to read its own code has not made its case.
 *
 * The repository is mirrored here from GitHub rather than moved off it, so the
 * upstream link still exists and is still honest - it is just no longer the
 * first thing offered. `UPSTREAM` is for the places where GitHub is the fact
 * being stated (where issues are triaged today, where releases are cut) rather
 * than a place to send somebody to read code.
 */

import { syntaxThemeCss as syntaxThemeCssImpl, themeChoices as themeChoicesImpl } from '../../app/Actions/Browse/themeCss'

/**
 * Every syntax theme the library ships, as CSS rules.
 *
 * Re-exported here rather than imported straight into the layout, because a
 * layout's server script is the one place in this project where an import that
 * cannot resolve renders a blank page rather than throwing something legible.
 */
export const syntaxThemeCss = syntaxThemeCssImpl

/** The same themes as a list, for the picker that chooses between them. */
export const themeChoices = themeChoicesImpl

/** The owner handle this instance keeps its own repository under. */
export const SOURCE_OWNER = 'reviewos'

/** The repository name, matching the mirror. */
export const SOURCE_REPOSITORY = 'reviewos.org'

/** Read the code, here. */
export const SOURCE_PATH = `/${SOURCE_OWNER}/${SOURCE_REPOSITORY}`

/** Issues, here. */
export const SOURCE_ISSUES_PATH = `${SOURCE_PATH}/issues`

/** Pull requests, here. */
export const SOURCE_PULLS_PATH = `${SOURCE_PATH}/pulls`

/**
 * The clone URL a reader can paste.
 *
 * Absolute rather than relative because it is copied out of the page into a
 * terminal, where a path beginning with a slash means nothing.
 */
export const SOURCE_CLONE_URL = `https://reviewos.org${SOURCE_PATH}.git`

/** Still true, still linked, no longer the front door. */
export const UPSTREAM_URL = 'https://github.com/ReviewOS/reviewos.org'
