FROM node:22-bookworm-slim AS node

FROM oven/bun:1.3.5-debian

RUN apt-get update && apt-get install -y --no-install-recommends \
    bubblewrap ca-certificates curl git procps ripgrep \
    && rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node

WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/browser-runtime/package.json ./packages/browser-runtime/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
RUN bun install --frozen-lockfile
COPY apps ./apps
COPY packages ./packages
RUN bun run build:web
RUN mkdir -p /data/pi /workspace && chown -R bun:bun /app /data /workspace

USER bun
ENV PI_CODING_AGENT_DIR=/data/pi
EXPOSE 4317
CMD ["bun", "run", "start:server"]
