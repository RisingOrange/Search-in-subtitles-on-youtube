#!/usr/bin/env bash
#
# Launch Firefox with the extension + adblocker for manual testing.
# Opens a YouTube video and leaves the browser open for interaction.
#
# Usage:
#   ./dev-browser.sh                    # opens default test video
#   ./dev-browser.sh --no-adblock       # without adblocker
#   ./dev-browser.sh URL                # opens a specific URL
#
# Prerequisites: Firefox and Node.js (npm ci to install deps).

set -euo pipefail

ADBLOCK=1
VIDEO_URL=""

for arg in "$@"; do
  case "$arg" in
    --no-adblock) ADBLOCK=0 ;;
    -h|--help)
      echo "Usage: $0 [--no-adblock] [URL]"
      echo "  --no-adblock  Disable the AdBlocker Ultimate addon"
      echo "  URL           YouTube URL to open (default: test video)"
      exit 0
      ;;
    http*) VIDEO_URL="$arg" ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

# Detect Firefox binary
if [ -n "${FIREFOX_BIN:-}" ]; then
  : # user already set it
elif command -v firefox &>/dev/null; then
  export FIREFOX_BIN="$(readlink -f "$(command -v firefox)")"
elif command -v firefox-esr &>/dev/null; then
  export FIREFOX_BIN="firefox-esr"
elif [ -d "/Applications/Firefox.app" ]; then
  export FIREFOX_BIN="/Applications/Firefox.app/Contents/MacOS/firefox"
else
  echo "Error: Firefox not found. Install Firefox or set FIREFOX_BIN." >&2
  exit 1
fi

echo "Using Firefox: $FIREFOX_BIN"
echo "AdBlocker: $([ "$ADBLOCK" -eq 1 ] && echo enabled || echo disabled)"
echo ""

export E2E_HEADED=1
export E2E_ENABLE_ADBLOCKER="$ADBLOCK"
export DEV_BROWSER_URL="$VIDEO_URL"

node tests/e2e/dev-browser.js
