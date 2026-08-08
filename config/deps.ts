import type { PantryConfig } from "ts-pantry";

/**
 * Pantry configuration for the Stacks project
 *
 * This file defines system-level dependencies managed by Pantry.
 * JavaScript/TypeScript dependencies remain in package.json.
 *
 * @see https://pantry.sh/docs/configuration
 */
export const config: PantryConfig = {
  /**
   * System dependencies with version constraints
   * These are binary tools and system packages required for development
   */
  dependencies: {
    // 1.3.14 is what pantry installs and what stx requires, but ts-pantry's
    // generated version union is a snapshot that currently stops at 1.3.11, so
    // pinning the exact floor does not typecheck. The caret range still resolves
    // to 1.3.14. Raise this once a ts-pantry release includes the newer versions.
    bun: '^1.3.11',
    git: '^2.47.0',
    // Commit signature verification. git can tell you a commit carries a
    // signature without it, but not whether the signature is good - that is
    // gpg's job, and the same reasoning as git applies: the binary does the
    // cryptography rather than a reimplementation of OpenPGP in TypeScript.
    //
    // 2.4.8 rather than 2.4.0 because pantry does not distribute 2.4.0 or
    // 2.4.1 - its oldest 2.4 is 2.4.2 - so the old floor named a version that
    // was never installable. 2.4.8 is the one installed and what deps.yaml
    // declares.
    //
    // The suppression is a ts-pantry bug rather than anything about the value:
    // `PackageVersions<T>` looks the name up in `Packages` first, and only a
    // flattened key like `gnupgorg` is in there, never the domain `gnupg.org`.
    // The miss indexes with `never`, which then satisfies the `{ versions }`
    // check vacuously, so the generated union - which does carry 2.2.42 through
    // 2.4.8 for this name - is never consulted and no version string at all
    // typechecks. Every domain-style name has this; `bun` above does not,
    // because it is a real key. Delete the directive once ts-pantry checks for
    // the miss before indexing: it reports itself as unused.
    // @ts-expect-error ts-pantry resolves a domain name's versions to never
    'gnupg.org': '^2.4.8',
    // The database engine is swapped for the one DB_CONNECTION names when
    // `buddy setup` regenerates deps.yaml, so only one ever gets installed.
    sqlite: '^3.47.2',
    // craft is not declared here: it ships inside @stacksjs/stx (its `./craft`
    // export), so pantry installing it again is a second copy nothing uses.
    // Uncomment as needed:
    // 'redis.io': '^7.4.1',
    // 'mailpit.axllent.org': '^1.21.8',
    // 'openjdk.org': '^21.0.3.6',
    // 'rust-lang.org': '^1.74.1',
  },

  /**
   * Install packages globally (available system-wide)
   * Set to false to install locally in the project
   */
  global: false,

  /**
   * Service management configuration
   * Auto-start and manage databases and other services
   */
  services: {
    enabled: true,
    autoStart: true,

    /**
     * Database configuration
     * Automatically provisions and starts the database
     */
    database: {
      connection: "postgres",
      name: "reviewos",
      // Pantry's cluster is initialised with trust auth and a single `postgres`
      // role, and it skips database creation entirely on an empty username.
      username: "postgres",
      password: "",
      authMethod: "trust",
    },

    /**
     * Commands to run after database setup
     * Useful for migrations and seeding
     */
    postDatabaseSetup: ["./buddy migrate", "./buddy seed"],

    /**
     * Framework-specific service detection
     */
    frameworks: {
      enabled: true,
      stacks: {
        enabled: true,
        autoDetect: true,
      },
    },
  },

  /**
   * Project-level lifecycle hooks
   */
  preSetup: {
    enabled: false,
    commands: [],
  },

  postSetup: {
    enabled: true,
    commands: [
      {
        name: "Generate model files",
        command: "./buddy",
        args: ["generate:db-types"],
        description: "Generate TypeScript model files from database schema",
        required: false,
      },
    ],
  },

  preActivation: {
    enabled: false,
    commands: [],
  },

  postActivation: {
    enabled: false,
    commands: [],
  },

  /**
   * Cache configuration for faster installations
   */
  cache: {
    enabled: true,
    maxSize: 2048, // 2GB
    ttlHours: 168, // 1 week
    autoCleanup: true,
    compression: true,
  },

  /**
   * Network settings
   */
  network: {
    timeout: 30000,
    maxConcurrent: 5,
    retries: 3,
    followRedirects: true,
  },

  /**
   * Security settings
   */
  security: {
    verifySignatures: true,
    checkVulnerabilities: true,
    allowUntrusted: false,
  },

  /**
   * Logging configuration
   */
  logging: {
    level: "info",
    toFile: false,
    timestamps: true,
    json: false,
  },

  /**
   * Update policies
   */
  updates: {
    checkForUpdates: true,
    autoUpdate: false,
    checkFrequency: 24,
    includePrereleases: false,
    channels: ["stable"],
  },

  /**
   * Resource management
   */
  resources: {
    autoCleanup: true,
    keepVersions: 3,
  },

  /**
   * Environment profiles for different contexts
   */
  profiles: {
    active: "development",
    development: {
      verbose: true,
      logging: {
        level: "debug",
      },
    },
    production: {
      verbose: false,
      logging: {
        level: "warn",
      },
      cache: {
        maxSize: 4096, // 4GB for production
      },
    },
    ci: {
      verbose: true,
      autoInstall: true,
      cache: {
        enabled: false,
      },
    },
  },

  /**
   * Verbose output
   */
  verbose: true,

  /**
   * Installation path for packages
   */
  installPath: "/usr/local",

  /**
   * Auto-install missing dependencies
   */
  autoInstall: true,

  /**
   * Install runtime dependencies
   */
  installDependencies: false,

  /**
   * Install build-time dependencies
   */
  installBuildDeps: false,
};

export default config;
