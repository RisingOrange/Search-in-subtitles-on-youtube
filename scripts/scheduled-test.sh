#!/usr/bin/env bash
#
# Run e2e tests and create a GitHub issue on failure.
# Skips if already run today (tracks via a stamp file).
# Intended to be run hourly via cron.
#
# Usage:
#   ./scripts/scheduled-test.sh
#
# Cron example (every hour):
#   0 * * * * /path/to/repo/scripts/scheduled-test.sh

set -uo pipefail

# Load nvm so node/npm are available in cron's minimal environment
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

cd "$(dirname "$0")/.."

BOT_TOKEN_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/yt-search-e2e-bot-token"

STAMP_FILE="${XDG_STATE_HOME:-$HOME/.local/state}/yt-search-e2e-last-run"
mkdir -p "$(dirname "$STAMP_FILE")"

TODAY=$(date +%Y-%m-%d)
if [ -f "$STAMP_FILE" ] && [ "$(cat "$STAMP_FILE")" = "$TODAY" ]; then
  exit 0
fi

echo "$TODAY" > "$STAMP_FILE"

LOG=$(mktemp)
./scripts/test-local.sh >"$LOG" 2>&1
EXIT_CODE=$?

# Hydration-dependent tests skip (not fail) on YouTube skeleton pages, so a
# persistent skeleton regime would hide breakage behind green runs forever.
# Track consecutive skip days and raise an issue once per streak of 3.
SKIP_STREAK_FILE="${XDG_STATE_HOME:-$HOME/.local/state}/yt-search-e2e-skip-streak"
if grep -q "SKIP.*skeleton page" "$LOG"; then
  PREV_STREAK=$(cat "$SKIP_STREAK_FILE" 2>/dev/null || echo 0)
  PREV_STREAK=${PREV_STREAK//[^0-9]/}
  SKIP_STREAK=$(( ${PREV_STREAK:-0} + 1 ))
else
  SKIP_STREAK=0
fi
echo "$SKIP_STREAK" > "$SKIP_STREAK_FILE"

if [ "$SKIP_STREAK" -ge 3 ]; then
  GH_TOKEN=$(cat "$BOT_TOKEN_FILE") gh issue create \
    --title "e2e hydration tests skipped $SKIP_STREAK days in a row (skeleton pages)" \
    --label "bot,e2e-failure" \
    --assignee RisingOrange \
    --body "$(cat <<EOF
The hydration-dependent e2e tests (copy transcript, modern transcript scrape) have been skipping for $SKIP_STREAK consecutive daily runs because YouTube served a skeleton watch page that never hydrated, even after reload retries.

One-off skeleton pages are expected headless-environment noise, but a streak this long likely means either YouTube changed the watch-page markup (the hydration markers in \`ensureWatchPageHydrated()\` no longer match) or headless sessions are being served degraded pages permanently. Either way these features are currently untested — investigate.

*Automatically created by \`scripts/scheduled-test.sh\`*
EOF
)" 2>/dev/null || echo "Warning: failed to create GitHub issue"
  # Reset so we alert once per streak, not every day.
  echo 0 > "$SKIP_STREAK_FILE"
fi

if [ "$EXIT_CODE" -eq 0 ]; then
  rm -f "$LOG"
  exit 0
fi

# Extract summary: last 60 lines should capture the test output + failures
TAIL=$(tail -60 "$LOG")

GH_TOKEN=$(cat "$BOT_TOKEN_FILE") gh issue create \
  --title "Scheduled e2e tests failed ($(date +%Y-%m-%d))" \
  --label "bot,e2e-failure" \
  --assignee RisingOrange \
  --body "$(cat <<EOF
The daily scheduled e2e test run failed with exit code \`$EXIT_CODE\`.

<details>
<summary>Test output (last 60 lines)</summary>

\`\`\`
$TAIL
\`\`\`

</details>

*Automatically created by \`scripts/scheduled-test.sh\`*
EOF
)" 2>/dev/null || echo "Warning: failed to create GitHub issue"

rm -f "$LOG"
exit "$EXIT_CODE"
