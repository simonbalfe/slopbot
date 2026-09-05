#!/bin/sh
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl unzip nodejs git ripgrep rsync chromium fonts-liberation openbox xterm scrot xdotool dbus-x11 x11vnc xvfb
if ! id slopbot >/dev/null 2>&1; then useradd -m -s /bin/bash slopbot; fi
mkdir -p /data/browser /opt/slopbot
chown -R slopbot:slopbot /data /opt/slopbot
chmod 700 /data/browser
if ! command -v bun >/dev/null; then
  install_dir=$(mktemp -d)
  case $(uname -m) in aarch64) bun_arch=aarch64 ;; x86_64) bun_arch=x64 ;; *) exit 1 ;; esac
  curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v1.3.5/bun-linux-$bun_arch.zip" -o "$install_dir/bun.zip"
  unzip -q "$install_dir/bun.zip" -d "$install_dir"
  install "$install_dir/bun-linux-$bun_arch/bun" /usr/local/bin/bun
  rm -rf "$install_dir"
fi
cat >/etc/systemd/system/slopbot-desktop.service <<'UNIT'
[Unit]
Description=SlopBot desktop
After=network-online.target
Wants=network-online.target
[Service]
User=slopbot
WorkingDirectory=/opt/slopbot
Environment=HOME=/home/slopbot
Environment=DISPLAY=:99
Environment=PORT=6080
Environment=LISTEN_HOST=127.0.0.1
Environment=BROWSER_PROFILE_DIR=/data/browser
Environment=BROWSER_WORKSPACE=/workspace
Environment=BROWSER_CDP_PORT=9222
Environment=BROWSER_CDP_PUBLIC_URL=http://127.0.0.1:9222
ExecStart=/usr/local/bin/bun packages/browser-runtime/src/index.ts
KillMode=mixed
Restart=on-failure
TimeoutStopSec=20
[Install]
WantedBy=multi-user.target
UNIT
if test -f /etc/systemd/system/slopbot.service; then
  systemctl disable --now slopbot.service
  rm /etc/systemd/system/slopbot.service
fi
systemctl daemon-reload
