#!/bin/sh
# Quick smoke test for user-chrome container
set -e

IMAGE="${1:-moat-user-chrome}"
NAME="uc-verify-$$"

echo "=== Building image ==="
docker build -t "$IMAGE" images/user-chrome/

echo "=== Starting container ==="
docker run -d --name "$NAME" \
  -p 8080:8080 \
  -v /tmp/uc-profile-$$:/data/profile \
  -e NEKO_SCREEN=1280x720@30 \
  -e NEKO_PASSWORD=test \
  -e NEKO_PASSWORD_ADMIN=test \
  "$IMAGE"

echo "=== Waiting 15s for startup ==="
sleep 15

echo "=== Checking container running ==="
docker inspect "$NAME" --format '{{.State.Running}}'

echo "=== Checking HTTP ==="
curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/

echo ""
echo "=== Checking Chromium flags ==="
docker exec "$NAME" ps aux | grep -o '\--user-data-dir=/data/profile' || true
docker exec "$NAME" ps aux | grep -o '\--no-sandbox' || true

echo "=== Checking profile ownership ==="
docker exec "$NAME" stat -c '%u:%g' /data/profile

echo "=== Cleanup ==="
docker stop "$NAME" && docker rm "$NAME"
rm -rf /tmp/uc-profile-$$
echo "=== Done ==="
