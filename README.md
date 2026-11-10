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

The pinned version is **v0.3.0** (67694caa7f54ee2ca70d455ed730be231ed3fbfc).
The container patches retain the restricted MCP environment (GH_TOKEN plus the SDK defaults) and the repository working directory.

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

1. upgrades all installed Alpine packages and installs the required tools
2. copies the vendored telemetry package and installs locked Node dependencies with `npm ci`
3. copies the Desktop Commander submodule source
4. applies the local `GH_TOKEN` forwarding and working-directory patches
5. builds Desktop Commander
6. installs the container bootstrap script

To force a clean rebuild:

```sh
docker compose build --pull --no-cache
```

### Alpine package updates and TLS verification

The Dockerfile runs `apk upgrade --no-cache` before `apk add --no-cache` in the same build step. This upgrades all installed Alpine packages, including the CA bundle and OpenSSL libraries, from the configured repositories before installing tools. `apk add --no-cache` alone can retain installed packages when dependency constraints are satisfied. Alpine continues to maintain the trust store; certificates are not removed individually.

In the Alpine 3.24.2 image, upgrading the bundle from `20260909-r0` to `20261020-r0` changed curl's result for the eMudhra test endpoint from success to certificate rejection (exit code 60, `unable to get local issuer certificate (20)`). Updating OpenSSL or other packages was not needed to reproduce this fix.

For a manual regression check, build a separate image without reusing build layers, check for remaining package updates against fresh indexes, and run bounded HTTPS checks:

```sh
docker build --pull --no-cache -t desktopcommandercontainer:ca-check .
docker run --rm --entrypoint sh desktopcommandercontainer:ca-check -c '
    set -eu
    apk update
    upgradable_packages=$(apk list --upgradable)
    if [ -n "$upgradable_packages" ]; then
        printf "%s\n" "$upgradable_packages" >&2
        exit 1
    fi
    apk list --installed ca-certificates-bundle
    curl --noproxy "*" --fail --silent --show-error --connect-timeout 10 --max-time 30 \
        --output /dev/null https://example.com/
    status=0
    curl --noproxy "*" --silent --show-error --connect-timeout 10 --max-time 30 \
        --output /dev/null https://dv-g3b-emudhra.we-have-a-problem.com/ \
        2>/tmp/ca-check-error || status=$?
    cat /tmp/ca-check-error
    if [ "$status" -ne 60 ]; then
        echo "Expected certificate verification exit code 60; got $status" >&2
        exit 1
    fi
    if ! grep -Fq "unable to get local issuer certificate (20)" /tmp/ca-check-error; then
        echo "Unexpected certificate failure; inspect the endpoint and certificate chain" >&2
        exit 1
    fi
    echo "CA regression check passed"
'
```

DNS failures, connection failures, and timeouts do not pass this check. These external endpoints can change or become unavailable; any unexpected result needs investigation of the endpoint, certificate chain, and network before attributing it to the image. Direct HTTPS access is required; a TLS-intercepting proxy can invalidate the result. This is an opt-in check rather than a build-time dependency.

`--pull` refreshes the floating `node:lts-alpine` base, and `--no-cache` forces the package step to run again. Rebuild and recreate deployed containers to receive package updates; existing images and running containers do not update automatically. The selected Alpine repositories must provide the corrected bundle (`20261020-r0` or later). Package versions can change as the base and repositories advance, and updates published after a build may appear in the verification check.

## Start

Start the container:

```sh
docker compose up -d
```

View protected logs locally (initial device authorization links and codes remain visible):

```sh
docker compose logs -f commander
```

Do not paste authentication links or codes into tickets or shared logs.

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
git -C DesktopCommanderMCP fetch origin --tags
git -C DesktopCommanderMCP checkout --detach <stable-release-tag>
```

Choose the latest stable release tag after reviewing its release notes; the default branch can include unreleased changes. Update the pinned-version note above when changing the submodule.

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

### Python HTML parsing and package management

The image includes Python 3, pip, Beautiful Soup (`beautifulsoup4`), and `lxml` as Alpine packages. HTML parsing is available immediately:

```sh
python3 -c 'from bs4 import BeautifulSoup; import lxml; print("ok")'
python3 -m pip --version
```

Alpine manages the system Python environment. Install additional Python packages in a virtual environment rather than running pip against the system interpreter:

```sh
python3 -m venv /tmp/analysis-venv
/tmp/analysis-venv/bin/python -m pip --version
/tmp/analysis-venv/bin/python -m pip install beautifulsoup4 lxml
```

Virtual environments are isolated from system packages by default, so install the libraries needed by that environment explicitly. Use `/workspace` instead of `/tmp` when the environment needs to persist across container recreation; remove temporary environments after use.

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

## Container hardening (Issue #9)

### Runtime restrictions

| Setting | Before #9 | After #9 |
| --- | --- | --- |
| Linux capabilities | Docker defaults | `cap_drop: [ALL]` |
| Privilege gain through exec | Docker defaults | `no-new-privileges:true` |
| Docker logs | Daemon defaults | `local`, 10 MB per file, 3 files |
| Remote console | Tool arguments, metadata, results and debug details | Protected lifecycle messages, current PAT masked, debug disabled |
| Execution user / root filesystem | root / writable | root / writable; deferred to #11 |
| Host access | Two named volumes, no host binds | Same |

The restrictions are intended to preserve the normal file access and outbound HTTPS used by Git/gh and the Remote Device; authenticated integration checks remain necessary. Dropping capabilities removes privileges such as raw sockets and mount operations. `no-new-privileges` prevents executable files from granting additional privileges; it does not remove the existing root identity. Commands that require extra capabilities, including some package installation scripts or repository-specific tools, may fail. Do not restore capabilities globally to work around such failures without reviewing the requirement.

`container-logging.mjs` is loaded before the Remote Device with Node's `--import`. It formats console messages, replaces the current `GH_TOKEN` literally, retains only the first line, and applies the pinned upstream `cleanLine` diagnostic filter. Tool arguments, metadata, results and tool error details are omitted; ordinary startup messages and initial authorization guidance remain available. Debug messages are always discarded. This intentionally reduces diagnostic detail. The filter is coupled to the pinned Desktop Commander revision: rerun its regression test when updating the submodule.

Log rotation limits retention, not access. Initial device sign-in URLs/codes remain sensitive. Older containers' logs and existing files in `/root` or `/workspace` are not scrubbed by this change.

### Base image updates and vulnerability scans

| Approach | Benefit | Cost / limitation | Decision |
| --- | --- | --- | --- |
| Pin `node:lts-alpine@sha256:...` | Fixes the base content and permits review of digest changes | Requires reviewed digest updates; `--pull` alone cannot update a pinned base | Not adopted in #9 |
| Refresh the LTS tag and rebuild without cache | Receives current Node/Alpine and `apk upgrade` fixes | Base and package repositories can change between builds | Adopted |
| Scan the completed image | Detects known OS and application dependency vulnerabilities | Database coverage is incomplete; a scan does not apply fixes | Adopted, with the rebuild |

The floating LTS tag is retained to preserve the existing update path with minimal maintenance. This is an explicit tradeoff: builds are not fully reproducible, and an LTS transition can change Node or Alpine. Digest pinning alone would not freeze `apk` repositories. For a future pinning policy, resolve the multi-platform manifest digest with `docker buildx imagetools inspect node:lts-alpine`, review the base change, replace `FROM` with the verified digest, and automate weekly digest update proposals. Never copy an unverified digest into the Dockerfile. See Docker's [base-image guidance](https://docs.docker.com/build/building/best-practices/#pin-base-image-versions).

`.github/workflows/image-security.yaml` builds with `--pull --no-cache`, tests the log filter without networking or volumes, and scans the resulting local image with Trivy on PRs targeting `master`, pushes to `master`, every Monday at 03:23 UTC, and manual dispatch. The vulnerability scanner fails on HIGH/CRITICAL OS or application findings, including findings without a fix. A separate secret scan checks all severities and reports only that findings exist, without matched values or snippets. It checks the image filesystem; it does not establish that deleted files in older layers are clean. Build/scan errors also fail the job. Actions are pinned to commit SHAs and the workflow has read-only repository permission; the runtime PAT is never supplied. It neither publishes images nor deploys containers. After a successful run, rebuild and recreate the deployment to apply updates; review failed runs promptly and update Action/scanner pins periodically. A passing workflow is not a guarantee that no vulnerabilities exist.

### Secrets and build boundaries

The `.dockerignore` allowlist sends only Dockerfile inputs. Additional final exclusions protect nested `.env` / `.env.*`, package-manager credentials, `.netrc`, Git credentials, SSH/cloud configuration, private keys, generated dependencies and logs. Do not place secrets in allowed source files, package manifests or vendored code: filename exclusions cannot recognize arbitrary secret content. No build argument, Dockerfile environment variable or build secret carries the runtime PAT. Compose injects it only when the container starts; build steps must stay unauthenticated.

Do not run `env`, `printenv`, `set -x`, `gh auth token`, verbose HTTP authentication tracing, or an unfiltered `docker inspect` / interpolated `docker compose config` when recording diagnostics. Use `docker compose config --quiet` for validation. Image history and layers, build caches, Docker logs, application logs and diagnostic bundles must be checked separately without printing matched values. A clean final filesystem does not establish that older image layers are clean.

The console filter covers this Remote Device's `console.log/info/warn/error`, not arbitrary child stdout/stderr, direct stream writes, telemetry, tool responses returned to ChatGPT, transformed/partial tokens, or files written by commands. Anyone controlling the container or Docker daemon can still read the environment and PAT. Use narrowly scoped PATs and treat host administrators and the Docker API as trusted. Do not share raw logs or diagnostic archives without a separate secret review.

### Validation and remaining acceptance checks

After building, run the regression test in an isolated container without host mounts:

```sh
docker build --pull --no-cache -t commander-security:check .
container=$(docker create --network none --cap-drop ALL --security-opt no-new-privileges:true \
    --entrypoint node commander-security:check --test /tmp/container-logging.test.mjs)
docker cp tests/container-logging.test.mjs "$container:/tmp/container-logging.test.mjs"
docker start --attach "$container"
docker inspect --format '{{.State.ExitCode}}' "$container"
docker rm "$container"
```

The test uses synthetic secrets only. Check the container exit code, not just whether Docker attached successfully. After authorized deployment/recreation, inspect only the relevant fields:

```sh
docker compose config --quiet
container=$(docker compose ps -q commander)
docker inspect --format '{{json .HostConfig.SecurityOpt}} {{json .HostConfig.CapDrop}} {{json .HostConfig.LogConfig}}' "$container"
docker inspect --format '{{range .Mounts}}{{.Type}} {{.Destination}}{{println}}{{end}}' "$container"
docker compose exec -T commander sh -c 'grep -E "^(CapInh|CapPrm|CapEff|CapBnd|CapAmb|NoNewPrivs):" /proc/self/status'
docker compose exec -T commander gh api user --silent
```

All capability fields should be zero and `NoNewPrivs` should be `1`; mounts must remain named volumes at `/root` and `/workspace`. Through the Remote Device, verify `pwd`, `git status`, an authorized `gh` read and an HTTPS clone into a temporary directory. Before recreating an existing deployment, record a non-sensitive file checksum in each existing volume and verify it afterwards. Run an actual `git push` only against an explicitly authorized test repository/branch. `git --version` and `git push --dry-run` do not prove write access. Never use `down -v` on the deployment or delete its volumes.

Local validation on 2026-11-11 used the existing image `sha256:7df79b5e2d99f04d442449d3d5385325d691f28dbce9c2313ef06f485db95dc9` in disposable containers. The new preload was copied into an isolated container: its synthetic PAT/payload regression passed. A separate Compose project with fresh volumes passed configuration validation, all five zero-capability checks, `NoNewPrivs: 1`, Git/gh startup, and sentinel persistence after forced recreation. Its temporary resources were removed; the running deployment and its existing volumes were untouched. A scratch build with a synthetic context verified 8 allowed files and 17 excluded secret/configuration canaries using the actual `.dockerignore`.

The registry lookup failed with Docker credential-helper error `A specified logon session does not exist`; the base image was not cached locally. The modified full image build, its build history/all layers, its vulnerability scan and the GitHub Actions run remain **unverified**. No clean-image or clean-production-log claim is made. Reconnection after recreating the deployment, authenticated clone/gh operations under the new restrictions, existing-volume read/write after recreation, and actual Git push also remain **unverified**. These require an image build in a working registry environment, final review, and authorized integration testing. The supplied implementation instruction did not authorize push.

### Handoff to #10 and #11

* **#10:** Replace the long-lived PAT with short-lived App tokens without adding host mounts or a Docker socket. Keep private keys outside this container and out of images/logs. The current MCP child environment forwards SDK defaults plus `GH_TOKEN`; file-based token refresh must explicitly account for that boundary and for Git/gh credential lookup. The current log mask reads `GH_TOKEN`, so a replacement token source needs corresponding masking and failure-path tests.
* **#11:** Design nonroot migration and ownership for existing `/root` and `/workspace` data before enabling a read-only filesystem. Current writes include Git configuration, Remote Device session/configuration, cloned repositories, tool output and temporary files; this list is a starting point, not a complete write audit. Preserve the restrictions added here and determine writable/tmpfs paths experimentally after #10.
* **#11:** Inventory outbound GitHub API/HTTPS Git, Remote Device authentication/realtime, telemetry and package-download destinations before enforcing egress restrictions. No egress allowlist is implemented here. Audit telemetry, child-process logs, stored sessions, token-volume permissions, backup exclusions and token cleanup separately. Initial sign-in codes and existing persistent data remain sensitive.

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
