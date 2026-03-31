#!/bin/bash
# Wait for Chromium CDP to become available
CDP_PORT="${1:-9222}"
TIMEOUT="${2:-30}"

for i in $(seq 1 "$TIMEOUT"); do
    if curl -sf "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1; then
        echo "CDP ready on port $CDP_PORT"
        exit 0
    fi
    sleep 1
done

echo "Timeout waiting for CDP on port $CDP_PORT" >&2
exit 1
