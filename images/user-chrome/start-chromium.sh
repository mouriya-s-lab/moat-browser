#!/bin/sh
set -eu

# A replaced container keeps the mounted profile but gets a new hostname. Its
# predecessor's process-singleton links must not block the next browser.
profile=/home/neko/.config/chromium
rm -f "$profile/SingletonLock" "$profile/SingletonSocket" "$profile/SingletonCookie"
exec /opt/chrome/chrome "$@"
