#!/bin/bash
set -e

DISPLAY="${DISPLAY:-:99}"
CDP_PORT="${CDP_PORT:-9222}"
PROFILE_DIR="${PROFILE_DIR:-/data/profile}"
SOCKET_DIR="${AGENT_BROWSER_SOCKET_DIR:-/run/agent-browser}"
SESSION_NAME="${AGENT_BROWSER_SESSION:-main}"

export DISPLAY

# Start Xvfb
Xvfb "$DISPLAY" -screen 0 1920x1080x24 -ac -nolisten tcp &
XVFB_PID=$!
sleep 1

# Wait for X to be ready
for i in $(seq 1 10); do
    if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
        break
    fi
    sleep 0.5
done

# Start Chromium with CDP
chromium \
    --remote-debugging-port="$CDP_PORT" \
    --remote-debugging-address=0.0.0.0 \
    --disable-blink-features=AutomationControlled \
    --user-data-dir="$PROFILE_DIR" \
    --no-first-run \
    --disable-gpu \
    --disable-dev-shm-usage \
    --disable-background-networking \
    --disable-sync \
    --no-sandbox \
    --display="$DISPLAY" \
    --window-size=1920,1080 \
    &
CHROME_PID=$!

# Wait for CDP to be available
/opt/agent-chrome/scripts/wait-for-chrome.sh "$CDP_PORT"

echo "agent-chrome ready: CDP on port $CDP_PORT"

# Start Unix socket proxy: forwards commands from socket to CDP
# This provides the /run/agent-browser/main.sock interface
SOCKET_PATH="${SOCKET_DIR}/${SESSION_NAME}.sock"
rm -f "$SOCKET_PATH"
socat UNIX-LISTEN:"$SOCKET_PATH",fork TCP:127.0.0.1:"$CDP_PORT" &
SOCAT_PID=$!

echo "agent-chrome socket ready: $SOCKET_PATH"

# Wait for any child to exit
wait -n $XVFB_PID $CHROME_PID $SOCAT_PID
