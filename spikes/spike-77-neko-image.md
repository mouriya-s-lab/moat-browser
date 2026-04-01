# Spike A: neko 官方镜像可行性验证

- **Issue**: Mouriya-Emma/moat-browser#77
- **Date**: 2026-04-02
- **Target**: VM 104 (192.168.1.200)
- **Image**: `ghcr.io/m1k1o/neko/chromium:latest` (sha256:13264ee217ec)

## Result: PASS (7/7)

| # | Dimension | Check | Result |
|---|-----------|-------|--------|
| ac-1 | assumption | neko 镜像可拉取 | PASS |
| ac-2 | environment | 容器启动 15s 后仍运行 | PASS — `true` |
| ac-3 | environment | neko HTTP 端点响应 | PASS — HTTP 200 |
| ac-4 | assumption | WebSocket 信令端点可达 | PASS — HTTP 101 (需要完整 WS headers) |
| ac-5 | assumption | supervisord 配置可定位 | PASS — `/etc/neko/supervisord/chromium.conf` |
| ac-6 | assumption | Chromium 参数可定制 | PASS — 配置文件可覆盖 |
| ac-7 | environment | profile 目录 uid 1000 可写 | PASS — exit 0 |

## Key Findings

### supervisord 结构

主配置: `/etc/neko/supervisord.conf`，通过 `[include] files=/etc/neko/supervisord/*.conf` 加载子配置。

Chromium 配置: `/etc/neko/supervisord/chromium.conf`

```ini
[program:chromium]
command=/usr/bin/chromium
  --window-position=0,0
  --display=%(ENV_DISPLAY)s
  --user-data-dir=/home/neko/.config/chromium
  --no-first-run
  --start-maximized
  --bwsi
  --force-dark-mode
  --disable-file-system
  --disable-gpu
  --disable-software-rasterizer
  --disable-dev-shm-usage
user=%(ENV_USER)s
```

### 定制方式

派生镜像中 COPY 替换 `/etc/neko/supervisord/chromium.conf` 即可修改 Chromium 启动参数（如 `--user-data-dir=/data/profile`）。

### neko 用户

Chromium 以 `neko` 用户 (uid 1000) 运行。Profile 目录需 `chown 1000:1000`。

## Conclusion

假设成立。neko 官方 Chromium 镜像可直接用于 user-chrome 容器基础。Phase 2 (#71) 可继续。
