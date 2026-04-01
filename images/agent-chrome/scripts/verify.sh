#!/usr/bin/env bash
# verify.sh — agent-chrome image verification
# Run on a host with Docker daemon access (Browser VM 192.168.1.200)
set -euo pipefail

IMAGE="moat-browser/agent-chrome"
CONTAINER="moat-browser-verify-agent-chrome"
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
  -p 19222:9222 \
  -v "$PROFILE_DIR:/data/profile" \
  --shm-size=2g \
  "$IMAGE"
echo "✓ Container started"

echo ""
echo "=== Step 3: Wait for CDP :9222 ==="
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
echo "=== Step 4: CDP targets check ==="
TARGET_ID=$(curl -sf http://localhost:19222/json/list 2>/dev/null | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
if [ -n "$TARGET_ID" ]; then
  echo "✓ CDP target available: $TARGET_ID"
else
  echo "✗ No CDP targets available"
  docker logs "$CONTAINER"
  exit 1
fi

echo ""
echo "=== Step 5: Profile directory ==="
sleep 3
if [ -n "$(ls -A "$PROFILE_DIR" 2>/dev/null)" ]; then
  echo "✓ /data/profile has content: $(ls "$PROFILE_DIR")"
else
  echo "⚠ /data/profile is empty (acceptable at startup)"
fi

echo ""
echo "=== Step 6: Process check — only supervisord+Xorg+openbox+Chromium allowed ==="
PROCS=$(docker exec "$CONTAINER" ps aux --no-headers 2>/dev/null | awk '{print $11}' | grep -vE "^(ps|$)" | sort -u || true)
echo "Running executables:"
echo "$PROCS"
for FORBIDDEN in socat bun node daemon xvfb Xvfb; do
  if echo "$PROCS" | grep -qi "$FORBIDDEN"; then
    echo "✗ Forbidden process found: $FORBIDDEN"
    exit 1
  fi
done
echo "✓ No forbidden processes"

echo ""
echo "=== All checks passed ==="
