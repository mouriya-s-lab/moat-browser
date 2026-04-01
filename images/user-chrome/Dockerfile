FROM ghcr.io/m1k1o/neko/chromium:latest

# Override Chromium supervisord config:
# - --user-data-dir=/data/profile (persistent profile)
# - --no-sandbox (required for container)
COPY supervisord/chromium.conf /etc/neko/supervisord/chromium.conf
COPY scripts/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Create crashpad database directory (Debian chromium hardcodes this path)
RUN mkdir -p "/home/neko/.config/chromium/Crash Reports" \
    && chown -R 1000:1000 /home/neko/.config/chromium

# Store default profile for volume initialization
RUN mkdir -p /data && cp -a /home/neko/.config/chromium /data/profile-default \
    && mkdir -p /data/profile && chown 1000:1000 /data/profile

ENTRYPOINT ["/entrypoint.sh"]
CMD []
