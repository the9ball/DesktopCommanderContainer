# DesktopCommanderContainer

Run [Desktop Commander](https://github.com/wonderwhy-er/DesktopCommanderMCP) Remote Device inside an isolated Docker container.

This repository provides a containerized development environment that ChatGPT can access through Remote Desktop Commander while keeping the host filesystem, Docker socket, SSH keys, and host Git credentials outside the container.

## Architecture

```text
ChatGPT
    │
    │ Remote Desktop Commander
    ▼
Docker container
    │
    ├── Desktop Commander MCP
    ├── git
    ├── gh
    │
    └── /workspace
          └── <repository>
                │
                ▼
              GitHub
```

Desktop Commander is included as a Git submodule and built inside the image.

```text
DesktopCommanderContainer/
├── DesktopCommanderMCP/
├── patches/
│   ├── pass-gh-token-to-mcp.patch
│   └── inherit-working-directory.patch
├── Dockerfile
├── compose.yaml
├── bootstrap.sh
├── .env.example
└── .gitmodules
```

## Security Model

The container is intentionally isolated from the host.

It does not require:

* host filesystem bind mounts
* `/var/run/docker.sock`
* host SSH keys
* host Git credentials

The repository being worked on is cloned inside `/workspace`, which is backed by a Docker named volume.

Desktop Commander's own state is stored under `/root`, also backed by a named volume.

GitHub access is provided through `GH_TOKEN`. Use a fine-grained personal access token restricted to only the repositories and permissions required for the intended workflow.

The token is intentionally available to Desktop Commander commands inside the container. Treat the container as part of the token's trust boundary.

## Requirements

* Docker
* Docker Compose
* Git
* a GitHub personal access token

Clone this repository including its submodule:

```sh
git clone --recurse-submodules https://github.com/the9ball/DesktopCommanderContainer.git
cd DesktopCommanderContainer
```

If the repository was cloned without submodules:

```sh
git submodule update --init --recursive
```

## Configuration

Copy the example environment file:

```sh
cp .env.example .env
```

Configure the following values:

```dotenv
GITHUB_TOKEN=
GITHUB_REPOSITORY=
GIT_USER_NAME=
GIT_USER_EMAIL=
```

For example, `GITHUB_REPOSITORY` should be a GitHub repository URL accepted by `gh repo clone`.

The Compose configuration maps:

```text
GITHUB_TOKEN
    ↓
GH_TOKEN
```

inside the container.

`.env` and other `.env.*` files are ignored by Git, while `.env.example` remains tracked.

## Build

Build the image with:

```sh
docker compose build
```

The Docker build:

1. installs the required Alpine packages
2. installs Desktop Commander Node dependencies
3. copies the Desktop Commander submodule source
4. applies the local `GH_TOKEN` forwarding and working-directory patches
5. builds Desktop Commander
6. installs the container bootstrap script

To force a clean rebuild:

```sh
docker compose build --no-cache
```

## Start

Start the container:

```sh
docker compose up -d
```

View logs:

```sh
docker compose logs -f commander
```

To recreate the running container after rebuilding:

```sh
docker compose up -d --force-recreate
```

## Persistent Volumes

The Compose configuration creates two named volumes:

```yaml
volumes:
  commander-home:
  commander-workspace:
```

They are mounted as:

```text
commander-home      → /root
commander-workspace → /workspace
```

`/root` persists Desktop Commander authentication and configuration.

`/workspace` persists the cloned repository and all working-tree changes across container recreation.

## Bootstrap

The container entrypoint is:

```text
/usr/local/bin/bootstrap
```

`bootstrap.sh` requires:

```text
GH_TOKEN
GITHUB_REPOSITORY
GIT_USER_NAME
GIT_USER_EMAIL
```

At startup it:

1. configures the global Git user name
2. configures the global Git user email
3. runs `gh auth setup-git`
4. derives the repository directory name from `GITHUB_REPOSITORY`
5. clones the repository into `/workspace` if it is not already present
6. starts the Desktop Commander Remote Device

The destination directory is:

```text
/workspace/<repository-name>
```

The repository is cloned only when that directory does not already contain `.git`.

## GitHub Authentication

GitHub CLI uses the container's `GH_TOKEN` environment variable.

Verify authentication with:

```sh
gh auth status
```

A working configuration should report an authenticated GitHub account using `GH_TOKEN`.

The bootstrap script also runs:

```sh
gh auth setup-git
```

so Git over HTTPS can use GitHub CLI as its credential helper.

## Why a Local Patch Is Required

The Desktop Commander Remote Device starts the local Desktop Commander MCP through an MCP stdio transport.

That transport does not automatically inherit every environment variable from the Remote Device process.

Without additional handling, the effective environment chain is:

```text
Docker Compose
    │
    │ GH_TOKEN available
    ▼
Remote Device
    │
    │ restricted stdio environment
    ▼
Desktop Commander MCP
    │
    │ GH_TOKEN missing
    ▼
gh
    └── unauthenticated
```

This repository applies a small local patch so that only `GH_TOKEN` is forwarded to the local Desktop Commander MCP.

The resulting path is:

```text
Docker Compose
    │
    │ GH_TOKEN
    ▼
Remote Device
    │
    │ GH_TOKEN
    ▼
Desktop Commander MCP
    │
    ▼
git / gh
```

## Local Patch

The upstream Desktop Commander source remains an unmodified Git submodule.

Container-specific behavior is implemented through:

```text
patches/pass-gh-token-to-mcp.patch
patches/inherit-working-directory.patch
```

The token patch changes the `StdioClientTransport` environment from the upstream default to:

```ts
env: {
    ...getDefaultEnvironment(),
    ...config.env,
    ...(process.env.GH_TOKEN
        ? { GH_TOKEN: process.env.GH_TOKEN }
        : {}),
    DC_REMOTE_DEVICE: 'true'
}
```

Only `GH_TOKEN` is explicitly forwarded.

The entire `process.env` is deliberately not forwarded, to avoid exposing unrelated environment variables or secrets to Desktop Commander processes.

The working-directory patch sets the local MCP launch configuration to `cwd: process.cwd()` so it inherits the Remote Device's working directory. The MCP entrypoint remains an absolute path to the built server.

Both patches are applied during the Docker build:

```dockerfile
COPY DesktopCommanderMCP/ .

COPY patches/pass-gh-token-to-mcp.patch /tmp/
COPY patches/inherit-working-directory.patch /tmp/
RUN patch -p1 < /tmp/pass-gh-token-to-mcp.patch \
    && patch -p1 < /tmp/inherit-working-directory.patch \
    && npm run build
```

Using a patch rather than replacing the entire source file also provides an upstream compatibility check: if the relevant upstream source changes enough that the patch can no longer be applied, the Docker build fails instead of silently overwriting newer code.

## Verifying GH_TOKEN Forwarding

After rebuilding and recreating the container, use Desktop Commander to run:

```sh
test -n "$GH_TOKEN" && echo set || echo unset
```

Expected output:

```text
set
```

Then verify GitHub CLI authentication:

```sh
gh auth status
```

If both succeed, GitHub CLI commands executed through Desktop Commander have access to the configured GitHub token.

## Working Directory

`bootstrap.sh` changes to the cloned repository before starting the Remote Device. The local MCP inherits that working directory, so commands started through Desktop Commander initially run in:

```text
/workspace/<repository-name>
```

The directory name is derived from `GITHUB_REPOSITORY`; changing the configured repository uses the same mechanism without a repository-specific path in the patch.

After rebuilding and recreating the container, verify through Desktop Commander's `start_process`:

```sh
pwd
```

For example, with `GITHUB_REPOSITORY=the9ball/.dotfiles`, the expected output is:

```text
/workspace/.dotfiles
```

Then run `git status` and `gh auth status` through Desktop Commander. Neither an explicit `cd` nor `git -C` is needed for the initial repository, and the existing `GH_TOKEN` forwarding remains in effect.

## Typical Development Workflow

A repository workflow through Desktop Commander can include:

```text
GitHub Issue
     │
     ▼
Desktop Commander
     │
     ├── inspect issue
     ├── inspect repository
     ├── create branch
     ├── edit files
     ├── run validation
     ├── inspect diff
     ├── commit
     ├── push
     └── create pull request
```

A suitable instruction to ChatGPT is:

> Use Desktop Commander to work on the requested issue in the repository under `/workspace`.
>
> Create a working branch from the repository's default branch, inspect the existing implementation, and make the smallest appropriate change.
>
> Run applicable validation and review the diff before committing.
>
> If everything looks correct, commit and push the branch and create a pull request referencing the issue.
>
> Do not merge the pull request.
>
> Stop and report back if the requirements are ambiguous or the required change becomes substantially larger than expected.

Some external write operations may still be blocked by the surrounding tool safety layer even when the container, GitHub token, and Desktop Commander configuration are functioning correctly.

If an operation is blocked by a safety check, do not attempt to bypass it through an alternative command or API. Perform that action manually instead.

## Updating Desktop Commander

The upstream source is tracked as a Git submodule:

```text
DesktopCommanderMCP
```

To update it:

```sh
git submodule update --remote DesktopCommanderMCP
```

Then rebuild:

```sh
docker compose build
```

If the upstream source has changed incompatibly with the local patch, the build should fail while applying:

```text
patches/pass-gh-token-to-mcp.patch
patches/inherit-working-directory.patch
```

Review the upstream changes and either:

* regenerate the patch against the new pinned version, or
* remove the patch if upstream now provides equivalent functionality

The intention is to keep wrapper-specific changes small and temporary.

## Regenerating the Patch

When the patch needs updating, prefer generating it from Git rather than manually editing unified diff metadata.

Temporarily edit:

```text
DesktopCommanderMCP/src/remote-device/desktop-commander-integration.ts
```

Then generate the patch:

```sh
cd DesktopCommanderMCP

git diff -- src/remote-device/desktop-commander-integration.ts \
  > ../patches/pass-gh-token-to-mcp.patch
```

Restore the submodule working tree:

```sh
git restore src/remote-device/desktop-commander-integration.ts
cd ..
```

The `DesktopCommanderMCP` submodule should remain clean after the patch file has been generated.

## Troubleshooting

### `gh` is not authenticated

First check whether Desktop Commander received the token:

```sh
test -n "$GH_TOKEN" && echo set || echo unset
```

If it prints:

```text
unset
```

verify that the local patch was applied and rebuild the image.

If it prints:

```text
set
```

check:

```sh
gh auth status
```

### `git` reports that the current directory is not a repository

Check `pwd` through Desktop Commander. The initial directory should be:

```text
/workspace/<repository-name>
```

If it is `/usr/src/app/dist`, rebuild the image and recreate the container so the working-directory patch takes effect. If a command explicitly changed directories, return to the repository before running Git commands.

### The patch fails during Docker build

If `patch -p1` fails, the pinned upstream source may no longer match the patch.

Review the upstream changes and regenerate the patch against the current submodule commit.

### A repository-specific validation command is missing

The image intentionally installs only a small general-purpose toolchain:

* Bash
* curl
* Git
* GitHub CLI
* jq
* patch
* Node.js and npm

Repository-specific build, test, lint, or formatting tools must be added separately if they are required.

## Design Principles

This wrapper follows these principles:

* isolate Desktop Commander from the host
* do not mount the Docker socket
* do not mount host SSH keys or Git credentials
* keep repository work inside a named Docker volume
* use narrowly scoped GitHub credentials
* forward only the environment variables explicitly required
* keep upstream Desktop Commander as an unmodified submodule
* express wrapper-specific upstream changes as explicit patches
* fail visibly when an upstream change invalidates a patch
* do not bypass external-action safety checks
* keep merges under explicit human control

## License

This repository is licensed under the MIT License. See [LICENSE](LICENSE).

Desktop Commander MCP is included as a Git submodule and is licensed separately by its respective copyright holders.
