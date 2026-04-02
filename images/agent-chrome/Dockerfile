FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99

# System dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    xserver-xorg-core xserver-xorg-video-dummy openbox supervisor socat \
    curl ca-certificates fonts-liberation libatk-bridge2.0-0 libatk1.0-0 \
    libcups2 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 \
    libxcomposite1 libxdamage1 libxrandr2 libxss1 libasound2 libpango-1.0-0 \
    libpangocairo-1.0-0 libx11-xcb1 libxcb1 libxext6 libxfixes3 libxi6 \
    libxkbcommon0 libxtst6 nodejs npm procps \
    && rm -rf /var/lib/apt/lists/*

# Install Chrome for Testing via Puppeteer browsers CLI
RUN npx @puppeteer/browsers install chrome@stable \
    && CHROME_DIR=$(find / -name 'chrome-linux64' -type d 2>/dev/null | head -1) \
    && ln -s "$CHROME_DIR" /opt/chrome

# Create profile directory
RUN mkdir -p /data/profile && chown -R 1000:1000 /data/profile

# Xorg dummy config
COPY xorg.conf /etc/X11/xorg.conf

# Supervisord config
COPY supervisord.conf /etc/supervisor/conf.d/agent-chrome.conf

EXPOSE 9223

CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
