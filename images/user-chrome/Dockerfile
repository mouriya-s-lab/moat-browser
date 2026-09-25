# Build from the repository root, just like agent-chrome:
#   docker build --platform linux/amd64 -f images/user-chrome/Dockerfile .
# Both images derive Chrome for Testing from the same Patchright anchor.
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

FROM --platform=linux/amd64 ghcr.io/m1k1o/neko/base:3.1.5@sha256:20806497c78de64700cb7befa674dbdc6bc4e8f0848a3dc911f0878a6726fa36
RUN apt-get update && apt-get install -y --no-install-recommends \
    fonts-liberation ca-certificates openbox \
    && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /home/neko/.config/chromium \
    && chown neko:neko /home/neko/.config/chromium
COPY --from=chrome-for-testing /opt/chrome /opt/chrome
COPY images/user-chrome/start-chromium.sh /usr/local/bin/start-chromium
COPY images/user-chrome/chromium.conf /etc/neko/supervisord/chromium.conf
COPY images/user-chrome/openbox.xml /etc/neko/openbox.xml
COPY images/user-chrome/policies.json /etc/opt/chrome_for_testing/policies/managed/policies.json
