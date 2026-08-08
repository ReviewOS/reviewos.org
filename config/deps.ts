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
    // The floor stx requires, and what pantry installs. It had been held at
    // ^1.3.11 because ts-pantry's generated version union is a snapshot and
    // that was as far as it went; 0.11.19's snapshot reaches 1.3.19.
    bun: '^1.3.14',
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
    // This line carried a `@ts-expect-error` until ts-pantry 0.11.19, and it
    // was the tool rather than the value: `PackageVersions<T>` looked the name
    // up in `Packages`, which is keyed by flattened names like `gnupgorg` and
    // never by the domain, so the miss indexed with `never` - which satisfies
    // the `{ versions }` check vacuously - and the generated union that does
    // carry these versions was never consulted. No version string at all
    // typechecked for any domain-style name.
    'gnupg.org': '^2.4.8',
    /*
     * The LFS client, for the operator rather than for the server.
     *
     * Nothing here shells out to it: the protocol is `ts-git-lfs` and the
     * object store is this forge's own, so serving LFS needs no binary. It is
     * declared because an operator on the box - checking what a pointer
     * resolves to, migrating a store, cloning a repository to look at it -
     * needs the client, and finding it missing at that moment is finding it
     * missing during an incident.
     *
     * It had been hand-added to `deps.yaml` and never declared here, so the
     * next `buddy setup` would have quietly dropped it. That file is generated;
     * this one is the source.
     */
    'git-lfs': '^3.7.1',
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
