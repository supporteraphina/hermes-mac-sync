#!/usr/bin/env bash
# Make the Mac's Hermes Desktop plugins match plugins.txt in this repo.
# Run: curl -fsSL https://raw.githubusercontent.com/supporteraphina/hermes-mac-sync/main/sync.sh | bash
set -euo pipefail

RAW="https://raw.githubusercontent.com"
LIST="$RAW/supporteraphina/hermes-mac-sync/main/plugins.txt"
DIR="${HERMES_HOME:-$HOME/.hermes}/desktop-plugins"
mkdir -p "$DIR"

list=$(curl -fsSL "$LIST?t=$(date +%s)")
while read -r action name src; do
  case "$action" in
    keep)
      repo=$(echo "$src" | cut -d/ -f1-2)
      folder=$(echo "$src" | cut -d/ -f3-)
      tmp=$(mktemp -d)
      if curl -fsSL "$RAW/$repo/main/$folder/plugin.js?t=$(date +%s)" -o "$tmp/plugin.js"; then
        rm -rf "$DIR/$name"
        mv "$tmp" "$DIR/$name"
        chmod 755 "$DIR/$name"
        echo "updated  $name"
      else
        rm -rf "$tmp"
        echo "FAILED   $name (kept the old copy)"
      fi
      ;;
    remove)
      if [ -d "$DIR/$name" ]; then
        rm -rf "$DIR/$name"
        echo "removed  $name"
      fi
      ;;
  esac
done < <(echo "$list" | grep -vE '^\s*(#|$)')

echo
echo "Done. In Hermes press Cmd+K and run: Reload desktop plugins"
