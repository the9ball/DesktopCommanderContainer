FROM node:lts-alpine AS token-issuer
RUN apk upgrade --no-cache
COPY auth/token-file.mjs auth/token-issuer.mjs /usr/local/lib/github-app/
CMD ["node", "/usr/local/lib/github-app/token-issuer.mjs"]

FROM node:lts-alpine AS base

ENV MCP_CLIENT_DOCKER=true

RUN apk upgrade --no-cache \
    && apk add --no-cache \
    bash \
    curl \
    git \
    github-cli \
    jq \
    patch \
    py3-beautifulsoup4 \
    py3-lxml \
    py3-pip \
    python3 \
    ripgrep

RUN npm install --global --ignore-scripts --no-audit --no-fund npm@11.21.2 \
    && npm cache clean --force

FROM base AS build
WORKDIR /usr/src/app

COPY DesktopCommanderMCP/ .
COPY patches/runtime-dependencies.patch /tmp/
RUN patch -p1 < /tmp/runtime-dependencies.patch \
    && npm ci --ignore-scripts \
    && npm rebuild @vscode/ripgrep

COPY patches/restrict-mcp-environment.patch /tmp/
COPY patches/inherit-working-directory.patch /tmp/
RUN patch -p1 < /tmp/restrict-mcp-environment.patch \
    && patch -p1 < /tmp/inherit-working-directory.patch \
    && npm run build \
    && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

# Keep development-dependency layers out of the delivered image's ancestry.
FROM base AS runtime
WORKDIR /usr/src/app
COPY --from=build /usr/src/app/ ./

COPY bootstrap.sh /usr/local/bin/bootstrap
COPY container-logging.mjs /usr/local/lib/container-logging.mjs
COPY auth/ /usr/local/lib/github-app/
RUN chmod +x /usr/local/bin/bootstrap /usr/local/lib/github-app/gh.mjs \
    /usr/local/lib/github-app/git.mjs /usr/local/lib/github-app/git-credential.mjs \
    && ln -s /usr/local/lib/github-app/gh.mjs /usr/local/bin/gh \
    && ln -s /usr/local/lib/github-app/git.mjs /usr/local/bin/git \
    && ln -s /usr/local/lib/github-app/git-credential.mjs /usr/local/bin/git-credential-github-app \
    && mkdir -p /usr/local/share/github-app/gh-config

WORKDIR /workspace
