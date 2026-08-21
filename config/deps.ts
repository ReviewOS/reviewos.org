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
     * The ssh client, because git invokes it rather than implementing it.
     *
     * A mirror with an `ssh://` or `git@host:` remote authenticates with a key
     * (`app/Actions/Mirror/credentials.ts` leaves those URLs alone precisely
     * because they do), and git shells out to `ssh` to make the connection. No
     * client, no mirror - and the failure surfaces as git's own "cannot run
     * ssh", once per sync, on a job nobody is watching.
     *
     * Declared here because until now only the Dockerfile installed one
     * (`apt-get install ... openssh-client`), so a bare-metal install got
     * whatever the operating system happened to ship, or nothing. That is the
     * whole point of the inventory: every binary this application causes to be
     * run traces to a declaration, including the ones git runs on our behalf.
     *
     * Note this is the *client*. The forge's own ssh server is `ts-ssh` in
     * `app/Actions/Git/ssh.ts` - TypeScript, no sshd, nothing to declare.
     */
    'openssh.com': '^9.9.0',
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
    /*
     * The search engine, and the reason it is a declared dependency rather
     * than a hosted service.
     *
     * Search is the one subsystem where a forge either owns its data or hands
     * it to somebody else: an instance that has to talk to Algolia to find its
     * own issues is not self-hostable, whatever the rest of it does. Typesense
     * runs from a single binary with no JVM under it, which is what makes
     * "search works out of the box on your own box" a claim this can keep -
     * OpenSearch, which `config/search-engine.ts` named before this, wants a
     * multi-gigabyte JVM and is not something to ask of somebody running a
     * forge for four people.
     *
     * Stacks already ships the driver (`search-engine/src/drivers/typesense.ts`)
     * and the `useSearch` trait indexes through it, so the model layer needs no
     * adapter written here.
     */
    'typesense.org': '^30.2.0',
    /*
     * The placeholder engine. Whichever one `DB_CONNECTION` names replaces it
     * when `buddy setup` regenerates deps.yaml, so exactly one is ever
     * installed: `postgres` becomes `postgresql.org@^17.10` and `mysql`
     * becomes `mysql.com@^9.2`, each with the matching pantry service, and the
     * unused engine is dropped from the file.
     *
     * That mapping is the framework's (`DB_CONNECTION_PACKAGES` in buddy's
     * setup command) rather than something to restate here: naming an engine
     * in this list would install a second one that nothing connects to. Phase
     * 17 moves this instance to MySQL, and the line that decides it is
     * `DB_CONNECTION` in `.env`.
     */
    sqlite: '^3.47.2',
    /*
     * The cross-process store, for instances running more than one process.
     *
     * Optional in use, declared always: the binary is cheap, and finding it
     * missing at the moment an operator scales to a second process is finding
     * it missing during a growth spurt. Nothing starts it - memory stays the
     * zero-dependency default for cache and broadcast - until the operator
     * opts in with `CACHE_DRIVER=redis` / `BROADCAST_REDIS_ENABLED=true`
     * and `pantry start valkey` (see "Running more than one process" in
     * docs/self-hosting.md).
     *
     * Valkey rather than Redis, recorded because the two are drop-in
     * interchangeable and somebody will reasonably ask: Redis moved to
     * RSALv2/SSPL licensing in 7.4, neither OSI-approved, and an open source
     * forge should not make a source-available store part of its recommended
     * deployment when the BSD-3 fork is protocol-identical, actively
     * maintained under the Linux Foundation, and in pantry's package set.
     * Every driver, env variable and client speaks the same protocol, so the
     * config still says `redis` where the framework does.
     */
    'valkey.io': '^8.1.8',
    // The mail server, which is also the local mail catcher: `./buddy mail:dev`
    // runs this binary in trap mode - every recipient accepted, nothing
    // delivered onward, all of it readable in the webmail UI on 8025.
    //
    // 0.3.2 or newer, and not as a preference: `catch_all` and the webmail
    // database that does not depend on SMTP AUTH both arrived in it, and
    // without them the catcher refuses almost every message and serves no
    // inbox.
    // Declared rather than commented out because `MAIL_MAILER` defaults to
    // `smtp` against 127.0.0.1:1025 - an instance whose machine has no mail
    // server is one where every password reset fails silently in development.
    // Nothing starts it; `./buddy mail:dev` does, when somebody wants it.
    'github.com/mail-os/mail': '^0.3.2',
    // craft is not declared here: it ships inside @stacksjs/stx (its `./craft`
    // export), so pantry installing it again is a second copy nothing uses.
    // Uncomment as needed:
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

    /*
     * Named, not `true`.
     *
     * `true` means "start whatever this project needs", and what the generator
     * does with it is start whatever it can *infer* - which is the database,
     * and nothing else. Typesense had been in `deps.yaml` from an earlier hand
     * edit, so regenerating the file silently dropped it: search would have
     * stopped starting on boot and nothing would have said so. Naming both is
     * what makes the generated file reproducible from this one.
     *
     * `app` and `worker` are deliberately absent. They are declared below and
     * started on purpose - a developer's laptop should not begin serving the
     * forge because they ran setup.
     *
     * The list form typechecks from ts-pantry 0.11.32. Before that the type
     * said `boolean` while every generator reading this config already
     * accepted an array, so `true` was the only thing anybody could write -
     * and `true` is what silently dropped typesense from the generated file.
     * Widened upstream rather than cast around here.
     */
    autoStart: ['postgres', 'typesense'],

    /**
     * This instance's own processes, managed the way its dependencies are.
     *
     * A production box is then pantry plus a `.env`: `pantry start app` and
     * `pantry start worker` write KeepAlive launchd agents (or systemd units
     * on Linux) with their own logs and health checks, restart on crash and
     * survive a reboot. No container runtime, no hand-written unit file, and
     * no terminal somebody has to remember to leave open - which is what the
     * queue actually ran in before this, and is why an instance that "looked
     * fine" could be quietly doing nothing asynchronous at all.
     *
     * The worker deliberately has no health check. Its liveness is queue
     * depth, which `/api/health` already reports, and a check that only
     * proved the process exists would report a wedged worker as healthy.
     *
     * Needs pantry 0.11.31 or newer, which is where `services.define` landed
     * (it was built for this).
     */
    define: {
      app: {
        // `./buddy` directly, never `bun run --bun ./buddy`: buddy is a POSIX
        // shell script with its own shebang that finds the right bun and sets
        // the environment up first, and handing it to `bun run` parses the
        // shell as JavaScript - `Expected ";" but found "$0"`, which is how
        // this first failed. It resolves bun itself, so a launchd agent with
        // no PATH still works.
        command: './buddy serve',
        port: 3000,
        health: 'curl -sf http://127.0.0.1:3000/api/health',
      },
      worker: {
        command: './buddy queue:work --concurrency 4',
      },
      /*
       * The clock, and the process this file forgot.
       *
       * `app/Scheduler.ts` declares everything that happens on a schedule -
       * the mirror sweep, the lease reclaim, artifact expiry, WAL
       * reconciliation, the nightly checkpoint, the ref-drift audit - and
       * **none of it runs unless something runs the scheduler**. A worker
       * processes what is enqueued; until this line existed, nothing enqueued
       * any of it, on any deployment. The instance looked healthy the whole
       * time, because it was: the queue was empty because nothing was filling
       * it, and every mirror on it quietly stopped updating with no error to
       * show for it.
       *
       * Exactly one, which is why it is a service of its own rather than a
       * flag on `app`. The framework takes a cross-cluster advisory lock per
       * task, so a second one is not a catastrophe - but a deployment shape
       * that depends on the lock is a deployment where the host that cannot
       * reach the database runs everything twice.
       *
       * No health check, for the worker's reason: a live process proves
       * nothing about whether the clock is being honoured. `/api/health`
       * reports overdue scheduled work instead.
       */
      scheduler: {
        command: './buddy schedule:run',
      },
    },

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
        name: "Start the search engine",
        command: "pantry",
        /*
         * Port 8208 rather than Typesense's default 8108, and that is not
         * arbitrary. Pantry runs one instance per project, but every project
         * asks for the same default port, so whichever starts second fails to
         * bind - and the health check probes the default port, gets the other
         * project's answer, and reports success. Naming a port here is what
         * makes this instance this project's.
         *
         * `config/search-engine.ts` reads TYPESENSE_PORT from `.env`, which is
         * where the matching 8208 lives. Both have to agree; there is no third
         * place that derives one from the other.
         *
         * Idempotent: pantry writes a launchd agent with KeepAlive, so this
         * survives a reboot and re-running setup is a no-op.
         *
         * **This works as written from pantry 0.11.31.** It did not before,
         * in two stages, and both are worth knowing because the symptom was
         * the same each time: `--port` reached the flag parser and stopped
         * there (fixed upstream in 0.11.20), and then reached the start
         * command but not typesense's *peering* port - which defaults to 8107
         * regardless of the API port, so a second project bound 8208 for HTTP
         * and then fought the first project for 8107 forever, logging
         * "has started listening on port 8208" and never becoming healthy.
         * Fixed upstream by deriving the peering port from the API port,
         * along with `pantry inspect`, which recomputed the definition from
         * scratch and so reported the default port, the wrong health check,
         * and a `Command:` line that was not the one running.
         *
         * `.env` and `.env.example` say 8208 to match.
         */
        args: ["start", "typesense", "--port", "8208"],
        description: "Typesense, on this project's own port and data directory",
        required: false,
      },
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
