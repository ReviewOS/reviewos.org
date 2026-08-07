/**
 * Test Setup
 *
 * Runs before every test file. Sets environment variables that must
 * be present before any @stacksjs/* packages are evaluated, then
 * initialises the test environment.
 */

// Env vars that config reads at module-evaluation time
if (!Bun.env.STRIPE_SECRET_KEY)
  Bun.env.STRIPE_SECRET_KEY = 'sk_test_fake_key_for_testing'

// A run-local hook secret, when the checkout has not configured one. An empty
// secret deliberately disables the post-receive endpoint (a default secret is
// a published secret), which on a fresh `.env` makes git-http's push-pipeline
// test fail for configuration rather than for code. Random per run, so it is
// never a value anything can come to depend on.
if (!Bun.env.GIT_HOOK_SECRET || Bun.env.GIT_HOOK_SECRET.trim().length < 16)
  Bun.env.GIT_HOOK_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('hex')

import { applyRuntimeDirectoryEnv } from '@stacksjs/path'
import { setupTestEnvironment } from '@stacksjs/testing'

setupTestEnvironment()

// The suite does not go through the preloader, so point stx and ts-cloud at
// `storage/` here too. Without it a test that renders a template or touches a
// cloud helper would write to `.stx` / `.ts-cloud` in the project root.
applyRuntimeDirectoryEnv()
