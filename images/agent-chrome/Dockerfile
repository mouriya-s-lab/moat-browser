FROM ghcr.io/m1k1o/neko/chromium:latest

# Remove neko server, GStreamer pipeline, and audio components.
# Keep: Chromium, Xorg (xserver-xorg-video-dummy), openbox, supervisord.
RUN apt-get remove -y \
      neko \
      gstreamer1.0-plugins-base \
      gstreamer1.0-plugins-good \
      gstreamer1.0-plugins-bad \
      gstreamer1.0-plugins-ugly \
      gstreamer1.0-libav \
      gstreamer1.0-x \
      pulseaudio \
      libpulse0 \
    && apt-get autoremove -y \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Replace supervisord config with agent-only processes:
# supervisord → Xorg → openbox → Chromium (CDP :9222)
COPY supervisord/ /etc/supervisor/conf.d/

# Xorg Dummy display configuration
COPY xorg.conf /etc/X11/xorg.conf

# Profile directory (Controller mounts COW copy at runtime)
VOLUME /data/profile

EXPOSE 9222
