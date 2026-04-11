ARG BASE_IMAGE=ghcr.io/m1k1o/neko/intel-base:latest
FROM ${BASE_IMAGE}

# Google Chrome stable — 与 agent-chrome 同一个 deb，profile 零清理
RUN apt-get update \
    && apt-get install -y --no-install-recommends wget \
    && wget -O /tmp/google-chrome.deb "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb" \
    && apt-get install -y /tmp/google-chrome.deb \
    && rm -f /tmp/google-chrome.deb \
    && rm -rf /var/lib/apt/lists/*

# Chrome policy: 启用 cookie 持久化 + 会话恢复
COPY policies.json /etc/opt/chrome/policies/managed/policies.json
