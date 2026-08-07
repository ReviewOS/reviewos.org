import { route } from '@stacksjs/router'
import ui from '../config/ui'

/**
 * Not a route: where the file-based views find their components.
 *
 * Two servers render stx here and only one of them was told. The dev frontend
 * goes through bun-plugin-stx, which loads `config/ui.ts` itself and searches
 * `resources/components`. Everything that boots through `route.serve()` - the
 * API server behind `./buddy dev`, the e2e suite, a production boot - renders
 * through bun-router's file-based routing instead, which never reads that
 * config: it falls back to `<viewsDir>/components`, a directory this project
 * does not have, and every `<Component />` tag on those boots renders as an
 * "[Error loading component]" line in the page. `<CsrfField />` is one of
 * them, so any form served that way loses its token and submits into a 403.
 *
 * This file runs with the other route files, which both boot paths import
 * before serving, so the render config is set wherever rendering happens.
 *
 * `componentsDir` only, deliberately. `config/ui.ts` also names a layoutsDir
 * of `resources/layouts`, which does not exist - layouts live under
 * `resources/views/layouts`, exactly where bun-router's fallback looks, so
 * forwarding the config value would break every page while fixing nothing.
 */
route.bunRouter.views({ componentsDir: ui.componentsDir })
