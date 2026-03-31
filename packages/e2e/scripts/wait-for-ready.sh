#!/bin/bash
set -e

TIMEOUT=${1:-60}
GATEWAY_URL="${MOAT_TEST_GATEWAY:-http://localhost:9800}"

echo "Waiting for gateway at $GATEWAY_URL/health..."
for i in $(seq 1 "$TIMEOUT"); do
  if curl -sf "$GATEWAY_URL/health" > /dev/null 2>&1; then
    echo "Gateway ready after ${i}s"
    exit 0
  fi
  sleep 1
done

echo "Timeout waiting for gateway after ${TIMEOUT}s" >&2
exit 1
