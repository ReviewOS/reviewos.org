import type { AuthConfig } from '@stacksjs/types'
import { env } from '@stacksjs/env'

/**
 * **Authentication Configuration**
 *
 * This configuration defines all of your authentication options. Because Stacks is fully-typed,
 * you may hover any of the options below and the definitions will be provided. In case
 * you have any questions, feel free to reach out via Discord or GitHub Discussions.
 */
export default {
  enabled: true,

  /**
   * The authentication guard to use for your application.
   */
  default: 'api',

  /**
   * The authentication guards available for your application.
   */
  guards: {
    api: {
      driver: 'token',
      provider: 'users',
    },
  },

  /**
   * The authentication providers available for your application.
   */
  providers: {
    users: {
      driver: 'database',
      table: 'users',
    },
  },

  /**
   * The username field used for authentication.
   */
  username: env.AUTH_USERNAME_FIELD || 'email',

  /**
   * The password field used for authentication.
   */
  password: env.AUTH_PASSWORD_FIELD || 'password',

  /**
   * Access-token expiry in milliseconds (default: 1 hour).
   *
   * Access tokens are deliberately short-lived: a leaked bearer (logs,
   * proxy, browser storage) is then usable for an hour, not a month. The
   * paired refresh token (`refreshTokenExpiry`) carries the long-lived
   * session and is rotated on use, so UX is unaffected.
   */
  tokenExpiry: env.AUTH_TOKEN_EXPIRY || 60 * 60 * 1000,

  /**
   * Refresh-token expiry in milliseconds (default: 30 days). This is the
   * long-lived credential exchanged for fresh access tokens.
   */
  refreshTokenExpiry: env.AUTH_REFRESH_TOKEN_EXPIRY || 30 * 24 * 60 * 60 * 1000,

  /**
   * How long a session may go **unused** before it stops working.
   *
   * Distinct from `tokenExpiry` above, and the distinction is the whole point:
   * that one bounds how long a session may live, this one bounds how long it
   * may live untouched. An absolute limit alone lets a browser left open on a
   * machine somebody walked away from keep working for its full term, which is
   * the case an idle limit is for.
   *
   * **Off by default here, deliberately.** This is a policy about a
   * deployment's physical security rather than a property of the software, and
   * a self-hosted instance on somebody's home server has a different answer
   * from one in a shared office. An idle timeout imposed by surprise reads to
   * the person it logs out as being logged out at random, which is how people
   * come to distrust a product's sign-in.
   *
   * `AUTH_IDLE_TIMEOUT=1800000` is thirty minutes, which is the number most
   * offices land on. `docs/self-hosting.md` says so beside the other values an
   * operator sets.
   */
  // Coerced rather than passed through: an environment variable is a string,
  // and a hardening control that quietly reads as `NaN` is one nobody notices
  // is off. `buddy instance:check` warns when this is set to something that is
  // not a positive number of milliseconds, so a typo is reported rather than
  // silently meaning "no limit".
  idleTimeout: Number(env.AUTH_IDLE_TIMEOUT ?? 0) || 0,

  /**
   * The token rotation time in hours (default: 24 hours).
   */
  tokenRotation: env.AUTH_TOKEN_ROTATION || 24,

  /**
   * The token abilities that are granted by default.
   */
  defaultAbilities: ['*'],

  /**
   * The token name used when creating new tokens.
   */
  defaultTokenName: 'auth-token',

  /**
   * Password reset configuration.
   */
  passwordReset: {
    /**
     * Token expiration time in minutes.
     * After this time, the reset link becomes invalid.
     *
     * @default 60
     */
    expire: env.AUTH_PASSWORD_RESET_EXPIRE ||60,

    /**
     * Throttle time in seconds between password reset requests.
     * Users must wait this long before requesting another reset email.
     *
     * @default 60
     */
    throttle: env.AUTH_PASSWORD_RESET_THROTTLE ||60,

    /**
     * Where the link in the mail lands.
     *
     * `/forgot-password` serves both halves of the flow: with no token it asks
     * for an address, with one it asks for a new password. The framework's
     * default template is `/password/reset/{token}`, which is a page this
     * product does not have - the mail would have gone out pointing at a 404.
     *
     * The address rides along because the token is stored hashed against it and
     * `passwordResets(email)` is keyed on it, so the reader does not retype
     * what they typed a minute ago.
     */
    url: '/forgot-password?token={token}&email={email}',
  },

  /**
   * Verifying an email address.
   */
  emailVerification: {
    /**
     * Same reason as the reset link above: the framework's default is
     * `/verify-email/{id}/{token}`, and the endpoint here is an action that
     * redirects a browser rather than a page. The mail points straight at it.
     */
    url: '/api/auth/verify?id={id}&token={token}',
  },
} satisfies AuthConfig
