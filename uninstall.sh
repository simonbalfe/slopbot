#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
bin_path=${SLOPBOT_BIN_PATH:-"$HOME/.local/bin/slopbot"}
data_dir=${SLOPBOT_DATA_DIR:-"$HOME/.local/share/slopbot-data"}
purge=0
if [ "${1:-}" = "--purge" ]; then purge=1; shift; fi
if [ "$#" -ne 0 ]; then
  echo 'Usage: slopbot uninstall [--purge]' >&2
  exit 1
fi

label=dev.slopbot.runtime
plist="$HOME/Library/LaunchAgents/$label.plist"
if [ -f "$plist" ] && command -v launchctl >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
fi
rm -f "$plist"
if [ -f "$bin_path" ] && grep -F "$root" "$bin_path" >/dev/null 2>&1; then rm -f "$bin_path"; fi

if [ "$purge" -eq 1 ]; then
  case "$data_dir" in ""|/|"$HOME"|"$root") echo "Refusing unsafe data path: $data_dir" >&2; exit 1;; esac
  lima_bin=$(command -v limactl || true)
  if [ -z "$lima_bin" ] && [ -x "$data_dir/dependencies/lima-2.2.0/bin/limactl" ]; then lima_bin="$data_dir/dependencies/lima-2.2.0/bin/limactl"; fi
  if [ -n "$lima_bin" ] && "$lima_bin" list --quiet | grep -Fx slopbot >/dev/null 2>&1; then
    "$lima_bin" delete --force --yes slopbot
  fi
  rm -rf "$data_dir"
fi

if [ -f "$root/.slopbot-managed-install" ]; then
  case "$data_dir/" in
    "$root/"*) if [ "$purge" -eq 0 ]; then echo "Application directory preserved because it contains data: $root"; else rm -rf "$root"; fi;;
    *) rm -rf "$root";;
  esac
fi
echo 'SlopBot uninstalled.'
if [ "$purge" -eq 0 ] && [ -e "$data_dir" ]; then echo "Data preserved at $data_dir"; fi
