FROM debian:13-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    curl \
    socat \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Bun runtime
COPY --from=oven/bun:latest /usr/local/bin/bun /usr/local/bin/bun

# Entrypoint and scripts
COPY entrypoint.sh /entrypoint.sh
COPY scripts/ /opt/agent-chrome/scripts/
RUN chmod +x /entrypoint.sh /opt/agent-chrome/scripts/*.sh

# Profile mount point and socket directory
RUN mkdir -p /data/profile /run/agent-browser

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=3 \
    CMD /opt/agent-chrome/scripts/healthcheck.sh

EXPOSE 9222
VOLUME ["/data/profile"]

ENTRYPOINT ["/entrypoint.sh"]
