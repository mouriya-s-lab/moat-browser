#!/bin/sh
# Ensure /data/profile exists and is owned by neko (uid 1000)
mkdir -p /data/profile
chown -R 1000:1000 /data/profile

# Remove stale Chromium singleton locks from previous container
rm -f /data/profile/SingletonLock /data/profile/SingletonSocket /data/profile/SingletonCookie

# Delegate to the original neko entrypoint
exec /usr/bin/supervisord -c /etc/neko/supervisord.conf
