# DesktopCommanderContainer

Run [Desktop Commander](https://github.com/wonderwhy-er/DesktopCommanderMCP) Remote Device in Docker. GitHub operations use the `the9ball-git-agent` GitHub App, with automatically renewed Installation Access Tokens. The upstream submodule remains pinned to **v0.3.0**, commit `67694caa7f54ee2ca70d455ed730be231ed3fbfc`.

## Authentication architecture

```text
key named volume ──read only──> token-issuer ──write──> token named volume
                                   │                         │ read only
                                   ▼                         ▼
                              GitHub API                 commander
                                                           ├─ gh wrapper → gh
                                                           └─ Git wrapper → credential helper
```

The issuer alone mounts `/run/github-app-key/app.pem`. Commander mounts the token volume at `/run/github-app-token` read only, alongside its existing `/root` and `/workspace` volumes. There are no host bind mounts, Docker sockets, host SSH keys, published issuer ports, or shared issuer/commander networks. Both containers drop all capabilities and prevent privilege escalation. The issuer also uses a read-only root filesystem and a bounded `/tmp` tmpfs. Both currently run as root; nonroot migration is tracked in #11.

The App identity is deliberately fixed in `auth/token-file.mjs`: App ID `5706210`, Installation ID `180730871`, repository **the9ball/DesktopCommanderContainer**. It has Contents, Issues and Pull requests write permissions and Metadata read. No user OAuth or webhooks are needed. Issuance checks the App and repository installation API responses, explicitly requests that repository and those permissions, and verifies the resulting scope. New permissions or repositories do not silently propagate.

The issuer renews approximately 10–11 minutes before expiry, with bounded exponential retry, jitter, HTTP deadlines and bounded Retry-After. It writes one protected JSON document using an exclusive temporary file, fsync and atomic rename. Readers accept only root-owned regular files with mode `0600` in a root-owned `0700` directory, matching scope and at least 60 seconds remaining. A failed refresh preserves the previous generation until its usable lifetime ends; missing, malformed or expired credentials fail locally. After recovery, later commands work without container restart or manual token replacement.

Proactive renewal keeps a usable token while idle. On-demand issuance could avoid that exposure, but would require additional request IPC and authentication/concurrency handling instead of a read-only consumer. This deployment chooses proactive renewal.

`gh` reads the current file on every invocation and sets `GH_TOKEN` only in its child process. Its isolated configuration directory prevents use of saved PATs. Git HTTPS uses a dedicated helper on every authentication request, restricted to the exact HTTPS host and repository path. Its wrapper resets helper chains, removes credential/tracing environment overrides, disables prompts, and refuses URL-embedded credentials, all URL rewrites, HTTP extraHeaders, cookie files and `.netrc` rather than silently using them. Network subcommands also require a valid App file before Git starts. Existing saved credentials are not deleted. Repository-specific Git configuration is checked even with `git -C`.

The Remote Device and MCP receive no long-lived token environment variable. `patches/restrict-mcp-environment.patch` limits the MCP environment to SDK defaults; `patches/inherit-working-directory.patch` retains the cloned working directory. `/usr/local/bin` wrappers and fixed credential paths work within that restricted environment.

Git global arguments use a closed grammar matched to Git 2.54.0 `git.c::handle_options`: `-C` and `-c` require separate operands; `--git-dir`, `--work-tree`, `--namespace`, `--config-env` and `--attr-source` also support `=value`. Supported flags include pager/pathspec controls, `--bare`, `--no-replace-objects`, `--no-lazy-fetch`, `--no-optional-locks` and `--no-advice`. Version/help flags form command boundaries as in Git. Directory options retain their exact order, so Git resolves repeated relative/empty `-C` values; command settings are parsed and replayed through the positive policy below. Other leading options (including internal queries and exec-path overrides), missing operands and invoked Git aliases fail locally with fixed diagnostics. Do not use an unsupported option or alias to change the effective context after the probe; expand it into a supported explicit Git command. Clone options use the separate closed grammar below; other subcommand options remain subcommand arguments. See the [Git reference](https://git-scm.com/docs/git/2.54.0) and [versioned parser](https://github.com/git/git/blob/v2.54.0/git.c).

Command-supplied settings use a positive policy. Git parses the original global `-c`/`--config-env` settings and reports their canonical keys and scopes. Only `user.name`, `user.email`, `core.autocrlf`, `core.eol`, `core.fileMode`, `core.ignoreCase`, `core.quotePath`, `color.ui`, `init.defaultBranch`, `fetch.prune`, `push.default` and `pull.rebase` are replayed. Caller-supplied global credential-helper and askpass settings are discarded, including the helper options generated by stock gh; the container always installs its own helper and disables prompts. Other command-scoped keys fail locally. This preserves metadata-setting order while retaining the directory-option order, without forwarding untrusted auth controls. All ambient `GIT_*` controls are removed except author/committer name, email and date; the wrapper supplies its own prompt/system-config controls.

`git --config` is not a supported global option. `git clone -c`/`--config` writes repository-local settings before transfer, so it is parsed separately: only the same benign keys are accepted, and helper/askpass/auth/URL/include/template settings are rejected. Clone uses exact supported option names, recognizes separate/attached short values and long `=value`, handles options after operands and `--` literals, then invokes canonical long options. Supported options are quiet/verbose/progress, no-checkout, bare/mirror, single-branch/tags, local/no-hardlinks/sparse, branch/origin/depth/filter/revision and benign config. Abbreviations, bundled short options, recursive submodules, custom templates, separate git directories and unreviewed clone options fail locally.

Clone always uses an empty template and ignores existing global configuration files during transfer, preventing newly activated `includeIf` or template configuration in the destination. Existing files are not edited. Explicit benign global overrides still apply to that clone, and benign clone config remains repository-local. Fetch/push continue to use the inspected existing repository/global configuration with the controlled App helper. Normal local clone/fetch/push object transfer and gh-style helper neutralization are covered by offline tests; live GitHub operations still require the integration acceptance checks. See [Git clone configuration](https://git-scm.com/docs/git-clone/2.54.0) and [Git configuration scopes](https://git-scm.com/docs/git-config/2.54.0).

## Trust boundary and command limitations

Commands controlling commander can read the short-lived token. Host administrators and the Docker daemon can read volumes, process environments and keys. The issuer is a separate trust boundary, not a defense against a compromised daemon. Keep its key volume out of backups and other containers. There is no firewall egress allowlist; the issuer code addresses only `api.github.com` over HTTPS and rejects redirects.

The console filter masks every `ghs_` generation accepted by the reader, including previous generations and missed rotations, and retains the existing tool-payload/debug filtering. Issuer errors use fixed event names without API bodies, headers, JWTs or parser diagnostics. This does not protect intentional secret printing, arbitrary child stdout/stderr, direct stream writes, telemetry or files. Do not run `env`, `printenv`, `set -x`, `gh auth token`, HTTP tracing, unfiltered `docker inspect` or interpolated `docker compose config` in recorded diagnostics. Use `docker compose config --quiet`.

A running stock gh process retains its initial token. A long-running watch can fail after expiry; rerun that command. New invocations use the renewed token. Writes are never automatically replayed after ambiguous failure. Installation tokens normally last one hour; changing an environment variable on container startup does not implement rotation.

Use explicit repository, base/head, title and body options for noninteractive Issue/PR operations. REST API compatibility does not establish every GraphQL query or gh flag. User endpoints (`gh api user`), `@me`, user-wide status, Projects, Gists, organization management, Actions/checks and workflow-file changes are outside the supported permission scope. Do not expand App permissions automatically. In particular, App push tests must use ordinary files, not `.github/workflows`. Git identity is commit metadata; GitHub API actions are attributed to the App bot. Repository rules and branch protection still apply.

## Initial setup

Requirements: Docker with Compose, Git, the registered/installed App, and its PEM held securely by the operator. Clone with submodules:

```sh
git clone --recurse-submodules https://github.com/the9ball/DesktopCommanderContainer.git
cd DesktopCommanderContainer
cp .env.example .env
```

Set `GIT_USER_NAME` and `GIT_USER_EMAIL` in `.env`. Keep `GITHUB_REPOSITORY=the9ball/DesktopCommanderContainer`; other repositories fail startup. `GITHUB_APP_KEY_VOLUME` names an external key volume (default `desktopcommander-github-app-key`). No PAT variable is required. `.env` and private-key files are excluded from Git; the Docker build allowlist also excludes private keys and credentials. Never put secrets in allowed source files or manifests.

Build both services before key placement. Build steps require no runtime credentials:

```sh
docker compose --env-file .env.example config --quiet
docker compose build --pull
```

The default Dockerfile target remains commander `runtime`; `token-issuer` is a separate minimal Node/Alpine target and does not inherit Git, gh or Desktop Commander. The issuer uses Node builtins only: npm/npx, Yarn, Corepack, their vendored modules and package-manager caches are removed from its delivered filesystem. The issuer image test checks payloads and dangling shims as well as commands; commander retains its required npm tooling. Commander retains Alpine package upgrades, npm `11.21.2`, the production dependency patch and multi-stage pruning from #9. Floating LTS and Alpine repositories require periodic clean rebuilds.

### Place the PEM safely

Do this locally, never through a chat attachment, command string containing key bytes, environment variable or Docker build. The following POSIX-shell commands create only the dedicated key volume and a network-disabled import container. Replace `/secure/path/app.pem` with your existing protected file path. In PowerShell, the same Docker commands work with a quoted Windows source path and without POSIX line-continuation backslashes.

```sh
docker volume create desktopcommander-github-app-key
docker create --name commander-key-import --network none --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --mount type=volume,src=desktopcommander-github-app-key,dst=/key \
    --entrypoint sh desktopcommander-token-issuer:local -c \
    'test ! -e /key/app.pem && chmod 0700 /key && chmod 0600 /key/app.pem.new && node /usr/local/lib/github-app/token-issuer.mjs --check-key /key/app.pem.new && mv /key/app.pem.new /key/app.pem'
docker cp /secure/path/app.pem commander-key-import:/key/app.pem.new
docker start --attach commander-key-import
docker inspect --format '{{.State.ExitCode}}' commander-key-import
```

Require exit code `0` before removing the importer with `docker rm commander-key-import`. The resulting key is uid/gid `0:0`, file `0600`, directory `0700`. This validates an RSA key of at least 2048 bits before publishing it. It does not prove that GitHub accepts that key. A failed import keeps any existing `app.pem`; inspect only fixed error/status messages, and correct the local file/permissions before retrying. Never delete the key volume as troubleshooting. If you configured another volume name, use that name consistently in both import and Compose.

The agent stops before live tests and waits for you to perform this operation. It never requests the PEM contents.

### Start and validate

Use a separate Compose project with fresh home/workspace/token volumes for initial acceptance. Do not recreate an existing deployment with a repository outside the App installation scope, or change its repository silently.

```sh
docker compose -p commander-app up -d
docker compose -p commander-app ps
docker compose -p commander-app logs --tail=30 token-issuer
docker compose -p commander-app exec -T commander gh api repos/the9ball/DesktopCommanderContainer --silent
docker compose -p commander-app exec -T commander git -C /workspace/DesktopCommanderContainer status
```

`depends_on` waits for a healthy issuer on first startup; bootstrap also waits up to one minute for a usable token, configures Git commit identity, clones if absent, then starts Remote Device in `/workspace/DesktopCommanderContainer`. Re-authorize the new Remote Device through its normal startup guidance. Sign-in URLs/codes remain sensitive.

The four volumes are commander home, workspace, token and the external key volume. Preserve existing home/workspace data and never use `down -v` against a deployment. Root's Git config and Remote Device state remain in the home volume; repositories and edits remain in workspace. No stored PAT is erased as part of this migration.

## Rotation, recovery and rollout

For key rotation, generate a second App key through GitHub while retaining the first. Use a fresh network-disabled importer as above to copy and validate `app.pem.new`. On that importer only, preserve the current `app.pem` as `app.pem.previous` before atomically renaming the validated new file. Stop if that backup already exists; do not overwrite or delete a prior key automatically. The issuer rereads the PEM at each refresh. Verify successful issuance and Git/gh operations with the replacement before separately authorizing old-key revocation or deletion. The directory remains `0700`, all key files `0600`; a validation or rename failure leaves the active key intact.

On `refresh-failed`, inspect issuer health and fixed event logs, network reachability, system clock, volume ownership/modes, App installation/suspension and grants. Do not print credential files. The issuer retries after network/API recovery, including after token expiry; restart it only to apply an image/configuration change, not to exchange tokens. Never resolve a failure by restoring PAT environment variables or adding credential helpers. A changed App grant requires explicit review, not automatic privilege adoption.

If Git reports unsupported authentication configuration, review argument and remote/push URLs, URL rewrites, the matching repository's extraHeader/cookie settings and home `.netrc` locally, without printing values to shared logs. URL rewrites are unsupported even when they contain no visible credential: a rewrite can assemble userinfo from separate fragments. Removing existing credentials/configuration requires the operator's approval. If gh fails, use `gh api repos/the9ball/DesktopCommanderContainer --silent` as the repository-scoped probe; do not use `/user` as an installation-token health check.

Before any real test writes, explain the exact test branch, harmless marker file, test Issue and draft PR. Use only the authorized repository, record IDs, and close/remove only explicitly covered test objects. Never directly push the default branch, force push or merge. A public clone alone does not prove authentication; successful authorized writes and installation API checks are required.

Keep the existing PAT and original deployment until App identity/scope checks, Git clone/push, high-level Issue/PR operations, recovery tests and a real >1-hour expiry/renewal test succeed without manual token exchange or container restart. Record final review and obtain explicit operator approval before production switching or PAT revocation. Rollback means restoring the separately retained deployment/configuration under that approval, not an automatic runtime fallback.

## Tests and security checks

All automated fixtures are synthetic and need no App key or PAT. Run suites only in disposable containers; command tests temporarily replace gh inside that disposable filesystem to inspect hashed environment values, then restore it. Never run them inside a production container.

```sh
docker build --target runtime -t commander-security:runtime .
docker build --target token-issuer -t commander-security:token-issuer .
container=$(docker create --network none --cap-drop ALL --security-opt no-new-privileges:true \
    --entrypoint node commander-security:runtime --test --test-timeout=30000 \
    /tmp/container-logging.test.mjs /tmp/runtime-dependencies.test.mjs \
    /tmp/github-app-auth.test.mjs /tmp/github-app-commands.test.mjs)
for suite in container-logging runtime-dependencies github-app-auth github-app-commands; do
    docker cp "tests/$suite.test.mjs" "$container:/tmp/$suite.test.mjs"
done
docker start --attach "$container"
docker inspect --format '{{.State.ExitCode}}' "$container"
docker rm "$container"
```

Require the container's own exit code `0`. Tests cover RS256 assertions, identity/scope/expiry validation, atomic rotation, key permissions/symlinks, bounded retry, refresh failure/expiry/recovery/restart, secret-free failure messages, per-invocation gh refresh, real Git helper precedence and fallback blocking, previous/current token log masking, and the existing runtime dependency suite. Fast clocks/mocks complement the required live elapsed-time test; they do not replace it. Real API compatibility, mounts/RO enforcement and recovery must also be checked in an isolated Compose project after safe key placement.

CI builds both exact Docker targets with fresh base/package resolution, runs offline suites without network or volumes, validates Compose, and scans HIGH/CRITICAL OS/application findings (including unfixed) plus secrets at all severities without printing matches. It has read-only repository permission and receives no runtime secrets. Scanning the final filesystem does not prove older layers/caches or historic logs are secret-free; inspect those separately without printing matches. No deployments or image publication are performed by this workflow.

## Updating Desktop Commander

Update the submodule to a reviewed stable release, then rebuild both targets. Keep `patches/restrict-mcp-environment.patch`, `patches/inherit-working-directory.patch` and `patches/runtime-dependencies.patch` aligned with that exact version. Patch application is a compatibility gate: investigate failures rather than replacing upstream files wholesale. Re-run offline tests, scans and the authenticated integration checks before recreating deployments.

## Historical records

The following records describe the PAT-based Issue #9 deployment and its validation before this migration. Its operational examples and token-forwarding notes are historical; use the App setup and validation instructions above for this version.

## Historical Issue #9 implementation and validation

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

The first PR #12 scan reported 43 HIGH and 2 CRITICAL findings. The two unfixed `decompress 4.2.1` findings were introduced by development-only `nexe -> download`; `node-forge` was introduced by development-only `@anthropic-ai/mcpb`. The production dependency updates and multi-stage pruning address the application findings, while npm `11.21.2` contains patched `brace-expansion 5.0.12` and `undici 6.29.1`. Scanner thresholds and failure behavior are unchanged. Check the corrected candidate's CI results rather than assuming these changes have cleared every finding. Update the npm pin and dependency patch when future scans require it; do not suppress findings without evidence of non-applicability.

### Secrets and build boundaries

The `.dockerignore` allowlist sends only Dockerfile inputs. Additional final exclusions protect nested `.env` / `.env.*`, package-manager credentials, `.netrc`, Git credentials, SSH/cloud configuration, private keys, generated dependencies and logs. Do not place secrets in allowed source files, package manifests or vendored code: filename exclusions cannot recognize arbitrary secret content. No build argument, Dockerfile environment variable or build secret carries the runtime PAT. Compose injects it only when the container starts; build steps must stay unauthenticated.

Do not run `env`, `printenv`, `set -x`, `gh auth token`, verbose HTTP authentication tracing, or an unfiltered `docker inspect` / interpolated `docker compose config` when recording diagnostics. Use `docker compose config --quiet` for validation. Image history and layers, build caches, Docker logs, application logs and diagnostic bundles must be checked separately without printing matched values. A clean final filesystem does not establish that older image layers are clean.

The console filter covers this Remote Device's `console.log/info/warn/error`, not arbitrary child stdout/stderr, direct stream writes, telemetry, tool responses returned to ChatGPT, transformed/partial tokens, or files written by commands. Anyone controlling the container or Docker daemon can still read the environment and PAT. Use narrowly scoped PATs and treat host administrators and the Docker API as trusted. Do not share raw logs or diagnostic archives without a separate secret review.

### Validation and remaining acceptance checks

After building, run the regression test in an isolated container without host mounts:

```sh
docker build --pull --no-cache -t commander-security:check .
container=$(docker create --network none --cap-drop ALL --security-opt no-new-privileges:true \
    --entrypoint node commander-security:check --test --test-timeout=30000 \
    /tmp/container-logging.test.mjs /tmp/runtime-dependencies.test.mjs)
docker cp tests/container-logging.test.mjs "$container:/tmp/container-logging.test.mjs"
docker cp tests/runtime-dependencies.test.mjs "$container:/tmp/runtime-dependencies.test.mjs"
docker start --attach "$container"
docker inspect --format '{{.State.ExitCode}}' "$container"
docker rm "$container"
```

The log test uses synthetic secrets only. The runtime suite imports the Remote Device without starting it, checks bundled UI scripts and development-package removal, and exercises WebSocket framing, ripgrep, Excel, PDF serialization, Markdown, image encoding and zip operations offline. PDF dependency loading does not establish browser-based PDF rendering or all document formats. Check the container exit code, not just whether Docker attached successfully. After authorized deployment/recreation, inspect only the relevant fields:

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

During the PR #12 review, a new disposable container derived from that image was updated with the corrected lock and npm, rebuilt, and pruned. After disconnecting its external network, all seven console/runtime regression tests passed. This verifies the application dependency changes against that existing base, not the new Dockerfile's stage ancestry or the latest floating base; those require the exact candidate's CI build and scans.

The registry lookup and subsequent local clean build failed with Docker credential-helper error `A specified logon session does not exist`; the base image was not cached locally. Local full-image validation remains **unverified**. The initial GitHub Actions run did build the image and pass console and secret scans, but failed the vulnerability gate as described above. Use PR #12 for the corrected candidate's exact commit and CI outcomes. No all-layer or clean-production-log claim is made. Reconnection after recreating the deployment, authenticated clone/gh operations under the new restrictions, existing-volume read/write after recreation, and actual in-container Git push also remain **unverified**. These require final review and authorized integration testing. Publishing the implementation branch is separate from an authenticated Git push compatibility test inside the container.

### Handoff to #10 and #11

* **#10:** Replace the long-lived PAT with short-lived App tokens without adding host mounts or a Docker socket. Keep private keys outside this container and out of images/logs. The current MCP child environment forwards SDK defaults plus `GH_TOKEN`; file-based token refresh must explicitly account for that boundary and for Git/gh credential lookup. The current log mask reads `GH_TOKEN`, so a replacement token source needs corresponding masking and failure-path tests.
* **#11:** Design nonroot migration and ownership for existing `/root` and `/workspace` data before enabling a read-only filesystem. Current writes include Git configuration, Remote Device session/configuration, cloned repositories, tool output and temporary files; this list is a starting point, not a complete write audit. Preserve the restrictions added here and determine writable/tmpfs paths experimentally after #10.
* **#11:** Inventory outbound GitHub API/HTTPS Git, Remote Device authentication/realtime, telemetry and package-download destinations before enforcing egress restrictions. No egress allowlist is implemented here. Audit telemetry, child-process logs, stored sessions, token-volume permissions, backup exclusions and token cleanup separately. Initial sign-in codes and existing persistent data remain sensitive.


## License

This repository is licensed under the MIT License. See [LICENSE](LICENSE). Desktop Commander MCP is included as a Git submodule and is licensed separately by its respective copyright holders.
