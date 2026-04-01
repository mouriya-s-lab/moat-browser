FROM ghcr.io/m1k1o/neko/chromium:latest

# Strip neko server and audio — agent-chrome is a pure browser container.
# Only supervisord + Xorg + openbox + Chromium remain.
RUN rm -f /etc/neko/supervisord/neko.conf \
    && rm -f /etc/neko/supervisord/pulseaudio.conf

# Xorg Dummy driver config (no physical display, no Xvfb)
COPY xorg.conf /etc/neko/xorg.conf

# Supervisord configs: Xorg, openbox, Chromium only
COPY supervisord/xorg.conf /etc/neko/supervisord/xorg.conf
COPY supervisord/openbox.conf /etc/neko/supervisord/openbox.conf
COPY supervisord/chromium.conf /etc/neko/supervisord/chromium.conf

# Profile volume — controller mounts user profile here
VOLUME /data/profile

# CDP port
EXPOSE 9222
