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

COPY patches/pass-gh-token-to-mcp.patch /tmp/
COPY patches/inherit-working-directory.patch /tmp/
RUN patch -p1 < /tmp/pass-gh-token-to-mcp.patch \
    && patch -p1 < /tmp/inherit-working-directory.patch \
    && npm run build \
    && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

# Keep development-dependency layers out of the delivered image's ancestry.
FROM base AS runtime
WORKDIR /usr/src/app
COPY --from=build /usr/src/app/ ./

COPY bootstrap.sh /usr/local/bin/bootstrap
COPY container-logging.mjs /usr/local/lib/container-logging.mjs
RUN chmod +x /usr/local/bin/bootstrap

WORKDIR /workspace
