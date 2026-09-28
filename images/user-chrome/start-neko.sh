#!/bin/sh
set -eu

# /tmp belongs to this container's writable layer. On reuse after SIGKILL,
# Xorg's old lock can name a live process in the new PID namespace. No display
# server has started in this container boot yet: clear only display 99 before
# handing PID 1 to the inherited supervisor.
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
exec /usr/bin/supervisord -c /etc/neko/supervisord.conf
