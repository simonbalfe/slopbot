FROM oven/bun:1.3.5-debian

RUN apt-get update && apt-get install -y --no-install-recommends \
    bubblewrap ca-certificates chromium chromium-sandbox curl dbus-x11 git novnc openbox procps ripgrep scrot websockify x11vnc xdotool xterm xvfb \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY server.ts vite.config.ts ./
COPY src ./src
COPY web ./web
RUN bun run build:web
RUN mkdir -p /codex /data /workspace && chown -R bun:bun /app /codex /data /workspace

USER bun
ENV CODEX_HOME=/codex
EXPOSE 4317 6080-6081
CMD ["bun", "run", "start:server"]
