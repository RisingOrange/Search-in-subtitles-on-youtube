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

cd "$(dirname "$0")/.."

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

if [ "$EXIT_CODE" -eq 0 ]; then
  rm -f "$LOG"
  exit 0
fi

# Extract summary: last 60 lines should capture the test output + failures
TAIL=$(tail -60 "$LOG")

gh issue create \
  --title "Scheduled e2e tests failed ($(date +%Y-%m-%d))" \
  --label "bot,e2e-failure" \
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
