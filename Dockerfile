FROM node:lts-alpine

ENV MCP_CLIENT_DOCKER=true

RUN apk add --no-cache \
    bash \
    curl \
    git \
    github-cli \
    jq \
    patch \
    python3 \
    ripgrep

WORKDIR /usr/src/app

COPY DesktopCommanderMCP/package*.json ./
RUN npm install --ignore-scripts \
    && npm rebuild @vscode/ripgrep

COPY DesktopCommanderMCP/ .

COPY patches/pass-gh-token-to-mcp.patch /tmp/
COPY patches/inherit-working-directory.patch /tmp/
RUN patch -p1 < /tmp/pass-gh-token-to-mcp.patch \
    && patch -p1 < /tmp/inherit-working-directory.patch \
    && npm run build

COPY bootstrap.sh /usr/local/bin/bootstrap
RUN chmod +x /usr/local/bin/bootstrap

WORKDIR /workspace
