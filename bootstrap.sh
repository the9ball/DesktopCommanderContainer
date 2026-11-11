#!/usr/bin/env bash
set -euo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GIT_USER_NAME:?GIT_USER_NAME is required}"
: "${GIT_USER_EMAIL:?GIT_USER_EMAIL is required}"

git config --global user.name "${GIT_USER_NAME}"
git config --global user.email "${GIT_USER_EMAIL}"

unset GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN GH_DEBUG

case "${GITHUB_REPOSITORY}" in
    the9ball/DesktopCommanderContainer|https://github.com/the9ball/DesktopCommanderContainer|https://github.com/the9ball/DesktopCommanderContainer.git) ;;
    *) echo "GitHub App repository scope mismatch" >&2; exit 1 ;;
esac

# Health gating handles first startup; this bounded wait also covers direct restarts.
ready=false
for ((attempt = 0; attempt < 30; attempt++)); do
    if node --input-type=module -e "import {readToken} from '/usr/local/lib/github-app/token-file.mjs'; try { readToken(); } catch { process.exit(1); }"; then
        ready=true
        break
    fi
    sleep 2
done
if [[ "${ready}" != true ]]; then
    echo "GitHub App credential unavailable" >&2
    exit 1
fi

repo_name="$(basename "${GITHUB_REPOSITORY}" .git)"
repo_dir="/workspace/${repo_name}"

if [[ ! -d "${repo_dir}/.git" ]]; then
    gh repo clone "${GITHUB_REPOSITORY}" "${repo_dir}"
fi

cd "${repo_dir}"

exec node --import /usr/local/lib/container-logging.mjs /usr/src/app/dist/remote-device/device.js
