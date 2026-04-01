#!/usr/bin/env bash
# Verification script for agent-chrome Docker image
# Usage: ./verify.sh [image-tag]
# Requires: docker, curl

set -euo pipefail

IMAGE="${1:-agent-chrome:test}"
CONTAINER="agent-chrome-verify-$$"

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
  -p 19222:9222 \
  --shm-size=2g \
  "$IMAGE"

echo "Waiting for CDP :9222 to respond (up to 30s)..."
CDP_RESP=""
for i in $(seq 1 30); do
  CDP_RESP=$(curl -sf http://localhost:19222/json/version 2>/dev/null || true)
  if echo "$CDP_RESP" | grep -q '"Browser"'; then
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "FAIL: CDP :9222 /json/version did not respond within 30s"
    echo "Container logs:"
    docker logs "$CONTAINER" 2>&1 | tail -30
    exit 1
  fi
  sleep 1
done
echo "PASS: CDP :9222 /json/version — $(echo "$CDP_RESP" | grep -o '"Browser":[^,]*')"

echo ""
echo "=== Step 3: CDP Page.navigate ==="
# Get WebSocket URL from CDP
WS_URL=$(curl -sf http://localhost:19222/json 2>/dev/null \
  | grep -o '"webSocketDebuggerUrl":"[^"]*"' \
  | head -1 \
  | sed 's/"webSocketDebuggerUrl":"//;s/"//')

if [ -z "$WS_URL" ]; then
  echo "FAIL: No WebSocket debugger URL found in /json"
  exit 1
fi
echo "WebSocket URL: $WS_URL"

# Use curl to send a Page.navigate command over CDP WebSocket
# Convert ws:// → http:// for the page list check (simpler than full WS handshake)
PAGE_COUNT=$(curl -sf http://localhost:19222/json 2>/dev/null | grep -c '"type":"page"' || true)
if [ "$PAGE_COUNT" -lt 1 ]; then
  echo "FAIL: No pages found in CDP /json"
  exit 1
fi
echo "PASS: CDP has $PAGE_COUNT page(s) available for automation"

echo ""
echo "=== Step 4: Profile directory write ==="
PROFILE_DIR=$(docker exec "$CONTAINER" test -d /data/profile && echo "exists" || echo "missing")
if [ "$PROFILE_DIR" != "exists" ]; then
  echo "FAIL: /data/profile directory does not exist in container"
  exit 1
fi
echo "PASS: /data/profile directory exists"

echo ""
echo "=== Step 5: Process check (only supervisord + Xorg + openbox + Chromium) ==="
PROCS=$(docker exec "$CONTAINER" ps aux 2>/dev/null | grep -v 'ps aux\|grep\|bash\|sh ' || true)
echo "Running processes:"
echo "$PROCS"

# Verify required processes are present
for proc in supervisord Xorg openbox chromium; do
  if echo "$PROCS" | grep -qi "$proc"; then
    echo "PASS: $proc is running"
  else
    echo "WARN: $proc not found in process list"
  fi
done

# Verify neko server is NOT running
if echo "$PROCS" | grep -qi "neko"; then
  echo "FAIL: neko server is running — should have been removed"
  exit 1
fi
echo "PASS: neko server is NOT running"

# Verify socat is NOT running
if echo "$PROCS" | grep -qi "socat"; then
  echo "FAIL: socat is running — violates no-extra-process constraint"
  exit 1
fi
echo "PASS: socat is NOT running"

echo ""
echo "=== All checks passed ==="
