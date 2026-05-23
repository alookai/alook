#!/bin/bash
# Bulk clear content/output/input from 'tool-result' rows in task_message table (batches of 50k)
# The record is kept (for audit trail) but the payload is zeroed out to save space.
# Run from repo root: bash scripts/cleanup-tool-result-content.sh

cd "$(dirname "$0")/../src/web"

BATCH=10000
TOTAL_UPDATED=0

while true; do
  echo "Updating batch of $BATCH rows..."
  RESULT=$(npx wrangler d1 execute alook-app --remote --json --command \
    "UPDATE task_message SET content = '', output = '', input = NULL WHERE type = 'tool-result' AND (content != '' OR output != '' OR input IS NOT NULL) LIMIT $BATCH;" 2>&1)

  if [ $? -ne 0 ]; then
    echo "Wrangler command failed. Output:"
    echo "$RESULT"
    echo "Waiting 30s before retry..."
    sleep 30
    continue
  fi

  if echo "$RESULT" | grep -q '"error"'; then
    echo "D1 error detected, waiting 30s before retry..."
    echo "$RESULT"
    sleep 30
    continue
  fi

  CHANGES=$(echo "$RESULT" | grep -o '"changes":[[:space:]]*[0-9]*' | head -1 | grep -o '[0-9]*' || true)

  if [ -z "$CHANGES" ]; then
    echo "Could not parse changes from response:"
    echo "$RESULT"
    echo "Waiting 10s before retry..."
    sleep 10
    continue
  fi

  TOTAL_UPDATED=$((TOTAL_UPDATED + CHANGES))
  echo "Updated $CHANGES rows (total: $TOTAL_UPDATED)"

  if [ "$CHANGES" -lt "$BATCH" ]; then
    echo "Done! Total updated: $TOTAL_UPDATED"
    break
  fi

  sleep 5
done
