import type { StxOptions as UiOptions } from '@stacksjs/stx'

/**
 * STX Configuration for Stacks
 * Note: Dashboard mode overrides these settings via serve() options
 */

export default {
  // Where stx keeps everything it generates: the compiled-template cache, the
  // Crosswind CSS cache, client-script bundles, the route manifest and route
  // types. Stacks keeps every runtime-owned directory under storage/ rather
  // than a `.stx` in the project root - see `stxPath()` in @stacksjs/path,
  // which also exports this as STX_DIR for processes that never read a config.
  stateDir: 'storage/framework/stx',

  // Components directory - for user-defined components
  componentsDir: 'resources/components',

  // Expose @stacksjs/components' ui library (<Sidebar>, <Button>, ...)
  // to tag resolution everywhere — the dashboard's macOS-style sidebar
  // resolves through this. See the plugin file for the lookup order.
  plugins: ['./storage/framework/defaults/stx-components-plugin.ts'],

  // Layouts and partials, both under the views directory, which is where they
  // actually are and where stx looks by default: its own fallbacks are
  // `<viewsDir>/layouts` and `<viewsDir>/partials`, and the dashboard's
  // stx.config.ts says `views/layouts` for the same reason.
  //
  // These read `resources/layouts` and `resources/partials`, neither of which
  // has ever existed in this repository, so stx warned about both on every
  // boot. The 69 views calling `@layout('app')` rendered anyway, which is the
  // part worth knowing: whatever resolves a layout at render time is not
  // reading this value, so the config was wrong, load-bearing for nothing, and
  // silent about it. A typo here would have behaved exactly the same way.
  layoutsDir: 'resources/views/layouts',
  partialsDir: 'resources/views/partials',
// `plugins` landed in stx after the pinned @stacksjs/stx types — widen until the dep updates.
} satisfies UiOptions & { plugins?: string[] }
