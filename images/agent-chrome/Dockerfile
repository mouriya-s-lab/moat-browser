FROM debian:bookworm-slim

ARG CHROME_VERSION=143.0.7499.0

# 系统依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates unzip \
    xserver-xorg-video-dummy xserver-xorg-core xinit \
    openbox \
    libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 \
    libxss1 libxtst6 libnss3 libnspr4 libatk1.0-0 \
    libatk-bridge2.0-0 libcups2 libdrm2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libdbus-1-3 libxkbcommon0 \
    fonts-liberation fonts-noto-cjk \
    supervisor \
    && rm -rf /var/lib/apt/lists/*

# Chrome for Testing
RUN curl -fsSL "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/linux64/chrome-linux64.zip" \
    -o /tmp/chrome.zip \
    && unzip /tmp/chrome.zip -d /opt/ \
    && mv /opt/chrome-linux64 /opt/chrome \
    && rm /tmp/chrome.zip \
    && ln -s /opt/chrome/chrome /usr/local/bin/chrome

# 非 root 用户 (UID 1000，与 neko 一致)
RUN groupadd -g 1000 chrome \
    && useradd -m -u 1000 -g chrome chrome

# Profile 挂载点
RUN mkdir -p /data/profile && chown chrome:chrome /data/profile

# 配置文件
COPY xorg.conf /etc/X11/xorg.conf
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

EXPOSE 9222

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
