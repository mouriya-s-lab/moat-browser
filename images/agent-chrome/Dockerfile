FROM debian:bookworm-slim

# 系统依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget ca-certificates \
    xserver-xorg-video-dummy xserver-xorg-core xinit \
    openbox \
    fonts-liberation fonts-noto-cjk \
    supervisor socat \
    && rm -rf /var/lib/apt/lists/*

# Google Chrome stable — 与 user-chrome 同一个 deb，profile 零清理
RUN wget -O /tmp/google-chrome.deb "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb" \
    && apt-get update \
    && apt-get install -y /tmp/google-chrome.deb \
    && rm -f /tmp/google-chrome.deb \
    && rm -rf /var/lib/apt/lists/*

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
