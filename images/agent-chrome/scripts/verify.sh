#!/bin/sh
set -e

CONTAINER_NAME="ac-test"
IMAGE_NAME="moat-agent-chrome"

echo "=== Agent Chrome Verification ==="

# ac-1: Dockerfile builds successfully
echo "[ac-1] Building image..."
docker build -t "$IMAGE_NAME" images/agent-chrome/
echo "[ac-1] Build: exit $?"

# Cleanup any previous test container
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

# ac-2: Container stays running after 15s
echo "[ac-2] Starting container..."
docker run -d --name "$CONTAINER_NAME" "$IMAGE_NAME"
echo "Waiting 15s..."
sleep 15
RUNNING=$(docker inspect "$CONTAINER_NAME" --format '{{.State.Running}}')
echo "[ac-2] Running: $RUNNING"

# ac-3: Clean process list (no neko/GStreamer)
echo "[ac-3] Process list:"
docker exec "$CONTAINER_NAME" ps aux --no-headers | awk '{print $NF}' | sort -u
echo "[ac-3] Check: no neko/GStreamer expected"

# ac-4: Chrome for Testing version
CHROME_VERSION=$(docker exec "$CONTAINER_NAME" /opt/chrome/chrome --version 2>/dev/null || true)
echo "[ac-4] Chrome version: $CHROME_VERSION"

# ac-5: CDP bound to 0.0.0.0:9223 via socat (Chrome ignores --remote-debugging-address)
# ss not available in image, use /proc/net/tcp: 0x2407 = 9223
CDP_BIND=$(docker exec "$CONTAINER_NAME" cat /proc/net/tcp 2>/dev/null | grep '00000000:2407' || true)
echo "[ac-5] CDP bind (socat 0.0.0.0:9223): $CDP_BIND"

# ac-6: CDP HTTP endpoint reachable from outside
CONTAINER_IP=$(docker inspect "$CONTAINER_NAME" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
CDP_JSON=$(curl -s "http://${CONTAINER_IP}:9223/json/version" || true)
echo "[ac-6] CDP JSON: $CDP_JSON"

# ac-7/8/9: Patchright connectOverCDP + navigation + ARIA snapshot
echo "[ac-7/8/9] Running Patchright CDP tests..."
cat > /tmp/ac-cdp-test.mjs << 'SCRIPT'
import { chromium } from 'patchright';
const CONTAINER_IP = process.argv[2];
async function main() {
  const browser = await chromium.connectOverCDP('http://' + CONTAINER_IP + ':9223');
  const context = browser.contexts()[0];
  const page = context.pages()[0] || await context.newPage();
  console.log('ac-7: connectOverCDP PASS');
  await page.goto('http://example.com');
  const title = await page.title();
  console.log('ac-8: title = ' + title);
  const aria = await page.locator('body').ariaSnapshot();
  console.log('ac-9: aria length = ' + aria.length);
  await browser.close();
}
main().catch(e => { console.error(e); process.exit(1); });
SCRIPT
node /tmp/ac-cdp-test.mjs "$CONTAINER_IP" || echo "[ac-7/8/9] FAIL (requires Node.js + patchright)"
rm -f /tmp/ac-cdp-test.mjs

# ac-10: Anti-detection flag
ANTI_DETECT=$(docker exec "$CONTAINER_NAME" cat /proc/*/cmdline 2>/dev/null | tr '\0' ' ' | grep -o 'disable-blink-features=AutomationControlled' | head -1 || true)
echo "[ac-10] Anti-detection flag: $ANTI_DETECT"

# ac-11: Profile directory ownership
OWNERSHIP=$(docker exec "$CONTAINER_NAME" stat -c '%u:%g' /data/profile)
echo "[ac-11] Profile ownership: $OWNERSHIP"

# Cleanup
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1

echo ""
echo "=== Verification Complete ==="
