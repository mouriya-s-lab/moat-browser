FROM ghcr.io/m1k1o/neko/chromium:latest

# Override Chromium supervisord config:
#   - user-data-dir → /data/profile (mounted volume)
#   - remove --bwsi (browse without sign-in) to allow logins
#   - add --disable-blink-features=AutomationControlled
COPY supervisord/chromium.conf /etc/neko/supervisord/chromium.conf

# Override neko config:
#   - WebRTC TCP mux on 8081
#   - ICE lite for NAT traversal
COPY neko.yaml /etc/neko/neko.yaml

# Remove PulseAudio (no audio needed for login sessions)
# Replace with a no-op to keep supervisord happy
RUN sed -i 's|command=/usr/bin/pulseaudio.*|command=/bin/true|' /etc/neko/supervisord.conf \
    && sed -i '/\[program:pulseaudio\]/a autostart=false' /etc/neko/supervisord.conf

# Create profile mount point with correct ownership
RUN mkdir -p /data/profile && chown neko:neko /data/profile

# Healthcheck: neko HTTP endpoint
COPY scripts/healthcheck.sh /usr/local/bin/healthcheck.sh
RUN chmod +x /usr/local/bin/healthcheck.sh
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
    CMD /usr/local/bin/healthcheck.sh

EXPOSE 8080 8081
VOLUME ["/data/profile"]
