FROM ghcr.io/m1k1o/neko/chromium:latest

# Replace Chromium supervisord config to add CDP port and profile directory
COPY supervisord/chromium.conf /etc/neko/supervisord/chromium.conf

# Profile directory (mounted as volume)
VOLUME /data/profile
