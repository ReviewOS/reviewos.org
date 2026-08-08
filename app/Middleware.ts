export interface Middleware {
  [key: string]: string
}

/**
 * The application's middleware aliases.
 *
 * Aliases may be used instead of class names to conveniently assign middleware to routes and groups.
 */
export default {
  'maintenance': 'Maintenance',
  'cors': 'Cors',
  'auth': 'Auth',
  'guest': 'Guest',
  'api': 'Api',
  'team': 'Team',
  'logger': 'Logger',
  'abilities': 'Abilities',
  'can': 'Can',
  'throttle': 'Throttle',
  'env': 'Env',
  'env:local': 'EnvLocal',
  'env:development': 'EnvDevelopment',
  'env:dev': 'EnvDevelopment',
  'env:staging': 'EnvStaging',
  'env:production': 'EnvProduction',
  'env:prod': 'EnvProduction',
  'role': 'Role',
  'permission': 'Permission',
  'verified': 'EnsureEmailIsVerified',
  'csrf': 'Csrf',
  'compress': 'Compress',

  /*
   * Organization gates. `orgCan:<ability>` is the one to reach for - it names
   * what the endpoint is *for*, so when a rung moves in
   * `ORGANIZATION_ABILITIES` the route follows. `orgRole:<role>` is for the
   * handful of places where the rung really is the requirement.
   *
   * Both are a convenience, not the boundary: every action behind them checks
   * again, because a route registered without one looks exactly like a route
   * registered with one.
   */
  'orgRole': 'OrgRole',
  'orgCan': 'OrgCan',
  // Add more middleware aliases here
  // Note: Use ! prefix for negation (e.g., '!auth', '!env:development')
} satisfies Middleware
