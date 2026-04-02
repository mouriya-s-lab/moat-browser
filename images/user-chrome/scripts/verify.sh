#!/bin/sh
set -e

CONTAINER_NAME="uc-test"
IMAGE_NAME="moat-user-chrome"

echo "=== User Chrome Verification ==="

# ac-1: Dockerfile builds successfully
echo "[ac-1] Building image..."
docker build -t "$IMAGE_NAME" images/user-chrome/
echo "[ac-1] Build: exit $?"

# ac-2: Container stays running after 15s
echo "[ac-2] Starting container..."
docker run -d --name "$CONTAINER_NAME" \
  -p 8080:8080 \
  -v /tmp/uc-profile:/data/profile \
  -e NEKO_SCREEN=1280x720@30 \
  -e NEKO_PASSWORD=test \
  -e NEKO_PASSWORD_ADMIN=test \
  "$IMAGE_NAME"
echo "Waiting 15s..."
sleep 15
RUNNING=$(docker inspect "$CONTAINER_NAME" --format '{{.State.Running}}')
echo "[ac-2] Running: $RUNNING"

# ac-3: neko HTTP endpoint responds
HTTP_CODE=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/)
echo "[ac-3] HTTP status: $HTTP_CODE"

# ac-4: neko WebSocket signaling reachable
WS_CODE=$(curl -s -o /dev/null -w '%{http_code}' -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H 'Sec-WebSocket-Version: 13' http://localhost:8080/ws)
echo "[ac-4] WebSocket status: $WS_CODE"

# ac-5: Chromium uses specified profile
PROFILE_FLAG=$(docker exec "$CONTAINER_NAME" cat /proc/*/cmdline 2>/dev/null | tr '\0' ' ' | grep -o '\--user-data-dir=/data/profile' | head -1 || true)
echo "[ac-5] Profile flag: $PROFILE_FLAG"

# ac-6: Chromium has --no-sandbox
SANDBOX_FLAG=$(docker exec "$CONTAINER_NAME" cat /proc/*/cmdline 2>/dev/null | tr '\0' ' ' | grep -o '\--no-sandbox' | head -1 || true)
echo "[ac-6] No-sandbox flag: $SANDBOX_FLAG"

# ac-7: Profile directory uid 1000
OWNERSHIP=$(docker exec "$CONTAINER_NAME" stat -c '%u:%g' /data/profile)
echo "[ac-7] Profile ownership: $OWNERSHIP"

# ac-8: Profile data persists across restart
docker exec "$CONTAINER_NAME" sh -c 'echo test > /data/profile/marker'
docker restart "$CONTAINER_NAME"
sleep 10
MARKER=$(docker exec "$CONTAINER_NAME" cat /data/profile/marker)
echo "[ac-8] Marker after restart: $MARKER"

# ac-9: Profile directory has content
PROFILE_LS=$(docker exec "$CONTAINER_NAME" sh -c 'ls /data/profile/ | head -5')
echo "[ac-9] Profile contents: $PROFILE_LS"

# Cleanup
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1
rm -rf /tmp/uc-profile

echo ""
echo "=== Verification Complete ==="
