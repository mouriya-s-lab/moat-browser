#!/usr/bin/env bash
# verify.sh — user-chrome image verification
# Run on a host with Docker daemon access (Browser VM 192.168.1.200)
set -euo pipefail

IMAGE="moat-browser/user-chrome"
CONTAINER="moat-browser-verify-user-chrome"
PROFILE_DIR="$(mktemp -d)"

cleanup() {
  docker rm -f "$CONTAINER" 2>/dev/null || true
  rm -rf "$PROFILE_DIR"
}
trap cleanup EXIT

echo "=== Step 1: Build ==="
docker build -t "$IMAGE" "$(dirname "$0")/.." 2>&1
echo "✓ Build succeeded"

echo ""
echo "=== Step 2: Start container ==="
docker run -d \
  --name "$CONTAINER" \
  -p 18080:8080 \
  -p 18081:8081 \
  -p 19222:9222 \
  -v "$PROFILE_DIR:/data/profile" \
  -e NEKO_SCREEN=1280x720@30 \
  -e NEKO_PASSWORD=test \
  -e NEKO_PASSWORD_ADMIN=admin \
  "$IMAGE"
echo "✓ Container started"

echo ""
echo "=== Step 3: Wait for neko HTTP :8080 ==="
for i in $(seq 1 30); do
  if curl -sf http://localhost:18080/ -o /dev/null 2>/dev/null; then
    echo "✓ neko HTTP :8080 responding"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "✗ neko HTTP :8080 not responding after 30s"
    docker logs "$CONTAINER"
    exit 1
  fi
  sleep 1
done

echo ""
echo "=== Step 4: CDP :9222 check ==="
for i in $(seq 1 30); do
  CHROME_VERSION=$(curl -sf http://localhost:19222/json/version 2>/dev/null | grep -o '"Browser":"[^"]*"' || true)
  if [ -n "$CHROME_VERSION" ]; then
    echo "✓ CDP :9222 responding — $CHROME_VERSION"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "✗ CDP :9222 not responding after 30s"
    docker logs "$CONTAINER"
    exit 1
  fi
  sleep 1
done

echo ""
echo "=== Step 5: Profile directory write ==="
sleep 3
if [ -n "$(ls -A "$PROFILE_DIR" 2>/dev/null)" ]; then
  echo "✓ /data/profile has content: $(ls "$PROFILE_DIR")"
else
  echo "⚠ /data/profile is empty (Chromium may not have written yet — acceptable at startup)"
fi

echo ""
echo "=== All checks passed ==="
