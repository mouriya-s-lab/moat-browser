#!/bin/sh
# Fix profile directory ownership when volume-mounted
chown 1000:1000 /data/profile

# Initialize profile from default if empty (first run with fresh volume)
if [ -z "$(ls -A /data/profile 2>/dev/null)" ]; then
  cp -a /data/profile-default/* /data/profile/
fi

# Ensure Crash Reports directory exists (crashpad handler requires it)
mkdir -p "/data/profile/Crash Reports"
chown -R 1000:1000 /data/profile

exec /usr/bin/supervisord -c /etc/neko/supervisord.conf
