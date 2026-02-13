#!/usr/bin/env bash
#
# Run e2e tests locally using your system Firefox.
#
# Usage:
#   ./test-local.sh              # headless (default)
#   ./test-local.sh --headed     # visible browser window
#   ./test-local.sh --no-adblock # disable the ad-blocker addon
#
# Prerequisites: Firefox and Node.js (npm ci to install deps).

set -euo pipefail

HEADED=0
ADBLOCK=1

for arg in "$@"; do
  case "$arg" in
    --headed)  HEADED=1 ;;
    --no-adblock) ADBLOCK=0 ;;
    -h|--help)
      echo "Usage: $0 [--headed] [--no-adblock]"
      echo "  --headed      Show the browser window instead of running headless"
      echo "  --no-adblock  Disable the AdBlocker Ultimate addon"
      exit 0
      ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

# Detect Firefox binary
if [ -n "${FIREFOX_BIN:-}" ]; then
  : # user already set it
elif command -v firefox &>/dev/null; then
  export FIREFOX_BIN="firefox"
elif command -v firefox-esr &>/dev/null; then
  export FIREFOX_BIN="firefox-esr"
elif [ -d "/Applications/Firefox.app" ]; then
  export FIREFOX_BIN="/Applications/Firefox.app/Contents/MacOS/firefox"
else
  echo "Error: Firefox not found. Install Firefox or set FIREFOX_BIN." >&2
  exit 1
fi

echo "Using Firefox: $FIREFOX_BIN"
echo "Headless: $([ "$HEADED" -eq 0 ] && echo yes || echo no)"
echo "AdBlocker: $([ "$ADBLOCK" -eq 1 ] && echo enabled || echo disabled)"
echo ""

export E2E_HEADED="$HEADED"
export E2E_ENABLE_ADBLOCKER="$ADBLOCK"

npm test
