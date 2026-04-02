#!/bin/bash
set -e

# Ensure profile directory has correct ownership
chown -R 1000:1000 /data/profile

# Start supervisord in foreground
exec /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf
