#!/bin/sh
set -eu

if [ "$(uname -s)" != Darwin ]; then
  echo 'The installer currently supports macOS. Other Bun hosts can run bun run start:server from a checkout.' >&2
  exit 1
fi

command -v git >/dev/null 2>&1 || { echo 'Install Git first: xcode-select --install' >&2; exit 1; }
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
if [ -f "$source_dir/apps/server/src/launch.ts" ]; then
  install_dir=$source_dir
else
  install_dir=${SLOPBOT_INSTALL_DIR:-"$HOME/.local/share/slopbot"}
  if [ -e "$install_dir" ]; then
    echo "Destination already exists: $install_dir. Run its install.sh or choose SLOPBOT_INSTALL_DIR." >&2
    exit 1
  fi
  git clone https://github.com/simonbalfe/slopbot.git "$install_dir"
fi
cd "$install_dir"
"$bun_bin" install --frozen-lockfile
"$bun_bin" run build
bin_dir=${SLOPBOT_BIN_DIR:-"$HOME/.local/bin"}
mkdir -p "$bin_dir" "$HOME/workspace"
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
{
  printf '#!/bin/sh\ncd '
  quote "$install_dir"
  printf ' || exit\nexec '
  quote "$bun_bin"
  printf ' apps/server/src/launch.ts "$@"\n'
} > "$bin_dir/slopbot"
chmod 755 "$bin_dir/slopbot"
printf '\nInstalled SlopBot. Run: %s/slopbot\n' "$bin_dir"
case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) printf 'Add this directory to your shell PATH: %s\n' "$bin_dir" ;;
esac
printf 'Optional computer VM: install Lima, then run bun run vm:up from %s\n' "$install_dir"
