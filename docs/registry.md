# Native package registry

ReviewOS uses Pantry as its package engine. The forge owns repository access and the association
between package names and repositories. Pantry owns publishing, immutable version artifacts,
checksums, malware scanning, metadata and storage. Both are part of our toolchain.

Each repository has a **Packages** tab. Names use the owner's scope, such as `@your-team/library`.
A repository can publish multiple packages, and each name is bound to one repository. Failed uploads
retain that name reservation so a retry cannot be captured by another repository. Deleting a
repository also retains the name reservation, with no readable repository attached. Reusing a
repository or owner name cannot expose an earlier private package.

## Run the Pantry service

Run a dedicated private Pantry registry using the [Pantry registry source](https://github.com/pantry-pm/pantry/tree/main/packages/registry).
Use [Pantry commit 3f1635ccd](https://github.com/pantry-pm/pantry/commit/3f1635ccd) or a newer registry build.
Its README documents local storage, S3-compatible storage, metadata persistence and scanner setup.
Run the production service with persistent storage and a working malware scanner. Keep the service
on a private network or loopback, accessible only by the forge. Disable npm fallback so a name that
has not been published here never resolves to somebody else's package. Before accepting a publish,
ReviewOS checks Pantry's reported policy and requires private visibility, authentication and disabled
npm fallback. An older service that cannot report those settings must be upgraded.

Set these values in the forge's environment, then restart the forge:

```dotenv
REVIEWOS_REGISTRY_URL=http://127.0.0.1:8210
REVIEWOS_REGISTRY_TOKEN=your-private-pantry-service-token
```

The service token is the Pantry registry's `PANTRY_REGISTRY_TOKEN`. Configure Pantry with
`REGISTRY_VISIBILITY=private`, `NPM_FALLBACK=false`, `PORT=8210` and a base URL matching its private service address.
It must not be exposed as the public registry endpoint: repository privacy is enforced by the forge.
Keep this token in the instance secret store and out of browser configuration. ReviewOS replaces the
caller's credential with it only after checking the caller's repository permission. Redirects from
the service are refused, and neither metadata nor downloads expose its private address or token.

Pantry's storage contains the artifacts and version metadata; the forge database contains package
ownership links. Back up both. Use the Pantry README for scanner deployment and storage settings.
A disconnected or refusing service is reported as unavailable rather than as an empty registry.

## Publish and install

Create a ReviewOS fine-grained access token with **Packages: write** and access to the repository.
The Packages tab shows its registry address:

```text
https://your-forge.example/api/repos/your-team/your-repository/registry
```

Configure the credential through Pantry, then publish:

```sh
pantry token set --registry https://your-forge.example/api/repos/your-team/your-repository/registry
pantry publish --registry https://your-forge.example/api/repos/your-team/your-repository/registry
```

The package manifest's name must start with `@your-team/`. The browser can also upload a tarball
using **Publish a version**. Pantry validates and scans the uploaded artifact. The forge accepts
artifacts up to 50 MB, and the service may apply a smaller policy. An existing version returns `409`.

Metadata and version-list endpoints use Pantry's native protocol, so Pantry clients can resolve and
download through the same registry address. Private downloads require a token with **Packages:
read**. Public repository packages can be read without signing in. Metadata tarball URLs point back
through the forge's access check, and downloads are streamed with private, non-cacheable responses.
Archiving a repository keeps downloads available and refuses publishing.

## Publish from a pipeline

A job can request the native package scope without getting permission to push code:

```yaml
permissions:
  contents: read
  packages: write
```

The job's ReviewOS token reaches only its own repository. Fork pull requests keep the existing
read-only restriction. Pass the token to your Pantry publishing step using its normal token
configuration, and use the registry URL above.

## API

All paths below start with `/api/repos/{owner}/{repository}/registry`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | List package names and service status; accepts `offset` and returns `next_offset` |
| POST | `/publish` | Pantry multipart `metadata` JSON plus `tarball`, or browser upload fields |
| GET | `/packages/@scope/name` | Latest version metadata |
| GET | `/packages/@scope/name/versions` | Version list |
| GET | `/packages/@scope/name/1.0.0` | Version metadata |
| GET | `/packages/@scope/name/1.0.0/tarball` | Artifact download through repository authorization |

This is the Pantry package protocol. It does not advertise an npm or OCI protocol endpoint.
