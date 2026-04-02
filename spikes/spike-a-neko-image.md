# Spike A: neko 官方镜像可行性验证

**Issue**: Mouriya-Emma/moat-browser#77
**Date**: 2026-04-02
**Result**: ALL PASS (7/7)
**Verdict**: 假设成立。neko 官方 Chromium 镜像可直接用于 user-chrome 容器。

## Image

`ghcr.io/m1k1o/neko/chromium:latest` (digest: `sha256:13264ee217ecccda06b07aa7543dc12d8f9a423ace344b6bda6ebf6d2ecea193`)

## Checkpoint Results

| # | Dimension | Result | Notes |
|---|-----------|--------|-------|
| ac-1 | assumption | PASS | Image pulled successfully |
| ac-2 | environment | PASS | Container running after 15s |
| ac-3 | environment | PASS | HTTP 200 on `http://localhost:8080/` |
| ac-4 | assumption | PASS | WebSocket 101 on `/ws` and `/api/ws` (requires `Sec-WebSocket-Version` + `Sec-WebSocket-Key` headers) |
| ac-5 | assumption | PASS | Config at `/etc/neko/supervisord/chromium.conf` |
| ac-6 | assumption | PASS | Chromium args fully customizable via config file |
| ac-7 | environment | PASS | `/data/profile` writable by uid 1000 (neko user) |

## Key Findings

### supervisord 架构

- Main config: `/etc/neko/supervisord.conf` — includes `/etc/neko/supervisord/*.conf`
- Chromium config: `/etc/neko/supervisord/chromium.conf`
- Processes: x-server, pulseaudio, neko (server), chromium, openbox

### Chromium 启动参数

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
```

### 定制方式

- **无**环境变量支持（`NEKO_BROWSER_FLAGS` 等不存在）
- **可通过**派生 Dockerfile COPY 覆盖 `/etc/neko/supervisord/chromium.conf`
- `--user-data-dir` 可改为 `/data/profile`，`--no-sandbox` 可添加

### WebSocket 端点

- neko v3 同时支持 `/ws` 和 `/api/ws`
- 需要完整 WebSocket 握手头（`Sec-WebSocket-Version: 13` + `Sec-WebSocket-Key`），否则返回 400

## Phase 2 建议

1. 以 `ghcr.io/m1k1o/neko/chromium:latest` 为基础镜像
2. COPY 自定义 `chromium.conf` 覆盖默认配置：
   - 改 `--user-data-dir=/data/profile`
   - 加 `--no-sandbox`
   - 移除 `--bwsi`（Browser Without Sign In，会阻止 profile 持久化）
3. Volume mount `/data/profile` 用于 profile 持久化
