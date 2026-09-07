#!/bin/sh
set -eu

case $(uname -s) in
  Darwin|Linux) ;;
  *) echo 'SlopBot currently supports macOS and Linux.' >&2; exit 1;;
esac

command -v curl >/dev/null 2>&1 || { echo 'The curl command is required to download SlopBot.' >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo 'The tar command is required to unpack SlopBot.' >&2; exit 1; }
command -v bash >/dev/null 2>&1 || { echo 'The bash command is required to install Bun.' >&2; exit 1; }
if ! command -v bun >/dev/null 2>&1 && [ ! -x "$HOME/.bun/bin/bun" ]; then
  installer=$(mktemp)
  trap 'rm -f "$installer"' EXIT HUP INT TERM
  curl -fsSL https://bun.sh/install -o "$installer"
  bash "$installer"
  rm -f "$installer"
  trap - EXIT HUP INT TERM
fi
bun_bin=$(command -v bun || true)
if [ -z "$bun_bin" ]; then bun_bin="$HOME/.bun/bin/bun"; fi

source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
managed_install=0
if [ -f "$source_dir/apps/server/src/launch.ts" ]; then
  install_dir=$source_dir
else
  install_dir=${SLOPBOT_INSTALL_DIR:-"$HOME/.local/share/slopbot"}
  if [ -e "$install_dir" ]; then
    echo "Destination already exists: $install_dir. Run its install.sh or choose SLOPBOT_INSTALL_DIR." >&2
    exit 1
  fi
  download_dir=$(mktemp -d)
  trap 'rm -rf "$download_dir"' EXIT HUP INT TERM
  curl -fsSL https://github.com/simonbalfe/slopbot/archive/refs/heads/main.tar.gz -o "$download_dir/slopbot.tar.gz"
  tar -xzf "$download_dir/slopbot.tar.gz" -C "$download_dir"
  mkdir -p "$(dirname "$install_dir")"
  mv "$download_dir/slopbot-main" "$install_dir"
  rm -rf "$download_dir"
  trap - EXIT HUP INT TERM
  managed_install=1
fi
cd "$install_dir"
"$bun_bin" install --frozen-lockfile
"$bun_bin" run build
bin_dir=${SLOPBOT_BIN_DIR:-"$HOME/.local/bin"}
data_dir=${SLOPBOT_DATA_DIR:-"$HOME/.local/share/slopbot-data"}
host_dir=${SLOPBOT_HOST_PATH:-${SLOPBOT_WORKSPACE_PATH:-"$HOME/workspace"}}
mkdir -p "$bin_dir" "$host_dir"
if [ "$managed_install" -eq 1 ]; then touch "$install_dir/.slopbot-managed-install"; fi
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
{
  printf '#!/bin/sh\nSLOPBOT_BIN_PATH='
  quote "$bin_dir/slopbot"
  printf '\nexport SLOPBOT_BIN_PATH\nif [ -z "${SLOPBOT_DATA_DIR:-}" ]; then SLOPBOT_DATA_DIR='
  quote "$data_dir"
  printf '; export SLOPBOT_DATA_DIR; fi\n'
  printf 'if [ -z "${SLOPBOT_HOST_PATH:-}" ]; then SLOPBOT_HOST_PATH='
  quote "$host_dir"
  printf '; export SLOPBOT_HOST_PATH; fi\ncd '
  quote "$install_dir"
  printf ' || exit\nexec '
  quote "$bun_bin"
  printf ' apps/server/src/launch.ts "$@"\n'
} > "$bin_dir/slopbot"
chmod 755 "$bin_dir/slopbot"
if [ "${SLOPBOT_SKIP_COMPUTER:-0}" != 1 ]; then
  printf '\nSetting up the SlopBot computer VM…\n'
  SLOPBOT_DATA_DIR="$data_dir" SLOPBOT_HOST_PATH="$host_dir" "$bun_bin" vm/manage.ts setup
fi
printf '\nInstalled SlopBot. Run: %s/slopbot\n' "$bin_dir"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) printf 'Add this directory to your shell PATH: %s\n' "$bin_dir" ;;
esac
if [ "${SLOPBOT_SKIP_COMPUTER:-0}" = 1 ]; then
  printf 'Computer setup skipped. Run %s/slopbot computer setup when needed.\n' "$bin_dir"
fi
