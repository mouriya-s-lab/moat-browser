FROM ghcr.io/m1k1o/neko/chromium:latest

# procps provides ps (needed for runtime inspection)
RUN apt-get update && apt-get install -y --no-install-recommends procps && rm -rf /var/lib/apt/lists/*

# Override chromium supervisord config:
# - Remove --bwsi (blocks profile persistence)
# - Set --user-data-dir=/data/profile
# - Add --no-sandbox (required in container)
# - Add HOME env (fixes crashpad handler)
COPY supervisord/chromium.conf /etc/neko/supervisord/chromium.conf

# Entrypoint: ensure /data/profile exists with correct ownership
COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
