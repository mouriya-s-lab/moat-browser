# Build from the repository root:
#   docker build --platform linux/amd64 -f images/agent-chrome/Dockerfile .
# The Chrome for Testing version is derived inside this build from the
# patchright-core pinned by packages/controller (#280 K1/K2); there is no
# version build argument, and a failed derivation or download fails the build.

FROM --platform=$BUILDPLATFORM node:22-bookworm-slim AS chrome-anchor
WORKDIR /anchor
COPY images/chrome-anchor.mjs ./
COPY packages/controller/package.json ./controller-package.json
RUN node chrome-anchor.mjs controller-package.json > chrome-version

FROM --platform=linux/amd64 debian:bookworm-slim AS chrome-for-testing
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/*
COPY --from=chrome-anchor /anchor/chrome-version /tmp/chrome-version
RUN version="$(cat /tmp/chrome-version)" \
    && curl -fsSL "https://storage.googleapis.com/chrome-for-testing-public/${version}/linux64/chrome-linux64.zip" -o /tmp/chrome.zip \
    && unzip -q /tmp/chrome.zip -d /opt/ \
    && mv /opt/chrome-linux64 /opt/chrome \
    && rm /tmp/chrome.zip

FROM --platform=linux/amd64 debian:bookworm-slim

# 系统依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    xserver-xorg-video-dummy xserver-xorg-core xinit \
    openbox \
    libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 \
    libxss1 libxtst6 libnss3 libnspr4 libatk1.0-0 \
    libatk-bridge2.0-0 libcups2 libdrm2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libdbus-1-3 libxkbcommon0 \
    fonts-liberation fonts-noto-cjk \
    supervisor socat \
    && rm -rf /var/lib/apt/lists/*

# Chrome for Testing（版本由 chrome-anchor 阶段派生）
COPY --from=chrome-for-testing /opt/chrome /opt/chrome
RUN ln -s /opt/chrome/chrome /usr/local/bin/chrome

# 非 root 用户 (UID 1000，与 neko 一致)
RUN groupadd -g 1000 chrome \
    && useradd -m -u 1000 -g chrome chrome

# Profile 挂载点
RUN mkdir -p /data/profile && chown chrome:chrome /data/profile

# 配置文件
COPY images/agent-chrome/xorg.conf /etc/X11/xorg.conf
COPY images/agent-chrome/supervisord.conf /etc/supervisor/conf.d/supervisord.conf

EXPOSE 9222

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
