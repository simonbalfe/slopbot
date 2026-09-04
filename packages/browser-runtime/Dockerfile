FROM oven/bun:1.3.5-debian

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates chromium fonts-liberation x11vnc xvfb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/browser-runtime/package.json ./packages/browser-runtime/package.json
RUN bun install --frozen-lockfile --production --filter @slopbot/browser-runtime
COPY packages/browser-runtime ./packages/browser-runtime

ENV BROWSER_PROFILE_DIR=/data/browser
ENV BROWSER_WORKSPACE=/workspace
ENV DISPLAY=:99
ENV PORT=8080

EXPOSE 8080 9322
CMD ["bun", "run", "--filter", "@slopbot/browser-runtime", "start"]
