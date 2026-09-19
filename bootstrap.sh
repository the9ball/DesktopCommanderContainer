#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GIT_USER_NAME:?GIT_USER_NAME is required}"
: "${GIT_USER_EMAIL:?GIT_USER_EMAIL is required}"

git config --global user.name "${GIT_USER_NAME}"
git config --global user.email "${GIT_USER_EMAIL}"

gh auth setup-git

repo_name="$(basename "${GITHUB_REPOSITORY}" .git)"
repo_dir="/workspace/${repo_name}"

if [[ ! -d "${repo_dir}/.git" ]]; then
    gh repo clone "${GITHUB_REPOSITORY}" "${repo_dir}"
fi

cd "${repo_dir}"

exec node /usr/src/app/dist/remote-device/device.js
