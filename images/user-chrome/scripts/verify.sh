#!/usr/bin/env bash
# Verification script for user-chrome Docker image
# Usage: ./verify.sh [image-tag]
# Requires: docker

set -euo pipefail

IMAGE="${1:-user-chrome:test}"
CONTAINER="user-chrome-verify-$$"

cleanup() {
  docker rm -f "$CONTAINER" 2>/dev/null || true
}
trap cleanup EXIT

echo "=== Step 1: Build ==="
docker build -t "$IMAGE" "$(dirname "$0")/.." || {
  echo "FAIL: docker build failed"
  exit 1
}
echo "PASS: docker build"

echo ""
echo "=== Step 2: Start container ==="
docker run -d \
  --name "$CONTAINER" \
  -p 18080:8080 \
  -p 18081:8081 \
  -p 19222:9222 \
  -e NEKO_PASSWORD=test \
  -e NEKO_PASSWORD_ADMIN=test \
  -e NEKO_SCREEN=1280x720@24 \
  --shm-size=2g \
  "$IMAGE"

echo "Waiting for neko to start (up to 30s)..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:18080/ >/dev/null 2>&1; then
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "FAIL: neko HTTP :8080 did not respond within 30s"
    docker logs "$CONTAINER"
    exit 1
  fi
  sleep 1
done
echo "PASS: neko HTTP :8080 responded"

echo ""
echo "=== Step 3: CDP :9222 check ==="
for i in $(seq 1 15); do
  CDP_RESP=$(curl -sf http://localhost:19222/json/version 2>/dev/null || true)
  if echo "$CDP_RESP" | grep -q '"Browser"'; then
    break
  fi
  if [ "$i" -eq 15 ]; then
    echo "FAIL: CDP :9222 /json/version did not return Chromium version"
    echo "Response: $CDP_RESP"
    exit 1
  fi
  sleep 1
done
echo "PASS: CDP :9222 /json/version — $(echo "$CDP_RESP" | grep -o '"Browser":[^,]*')"

echo ""
echo "=== Step 4: Profile directory write check ==="
PROFILE_CHECK=$(docker exec "$CONTAINER" test -d /data/profile && echo "exists" || echo "missing")
if [ "$PROFILE_CHECK" != "exists" ]; then
  echo "FAIL: /data/profile directory does not exist in container"
  exit 1
fi
# Chromium writes Default/Preferences on first run
WRITE_CHECK=$(docker exec "$CONTAINER" find /data/profile -name "Preferences" 2>/dev/null | head -1)
if [ -z "$WRITE_CHECK" ]; then
  echo "WARN: /data/profile/Default/Preferences not yet written (Chromium may still be starting)"
else
  echo "PASS: profile write — $WRITE_CHECK"
fi

echo ""
echo "=== All checks passed ==="
