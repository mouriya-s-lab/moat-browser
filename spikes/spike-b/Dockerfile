FROM debian:bookworm-slim

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# Install minimal dependencies: Xorg dummy, openbox, supervisord, socat, utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
    xserver-xorg-video-dummy \
    xserver-xorg-core \
    x11-xserver-utils \
    openbox \
    supervisor \
    socat \
    procps \
    curl \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    iproute2 \
    && rm -rf /var/lib/apt/lists/*

# Install Chrome for Testing via npx @puppeteer/browsers
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npx -y @puppeteer/browsers install chrome@stable --path /opt/chrome \
    && ln -s /opt/chrome/chrome/*/chrome-linux64/chrome /usr/local/bin/chrome \
    && apt-get purge -y nodejs \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* /root/.npm /tmp/*

# Create neko-equivalent user (uid 1000)
RUN useradd -m -u 1000 -s /bin/bash neko

# Create profile directory with correct ownership
RUN mkdir -p /data/profile && chown -R 1000:1000 /data/profile

# Xorg dummy config (reference: neko xorg.conf)
COPY xorg.conf /etc/X11/xorg.conf

# Supervisord config
COPY supervisord.conf /etc/supervisor/conf.d/spike.conf

# Startup script
COPY scripts/start.sh /usr/local/bin/start.sh
RUN chmod +x /usr/local/bin/start.sh

EXPOSE 9223

CMD ["/usr/local/bin/start.sh"]
