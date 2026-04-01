# Spike A: neko 官方镜像可行性验证

**Issue**: Mouriya-Emma/moat-browser#77
**Date**: 2026-04-02
**Result**: PASS (7/7 checkpoints)

## Summary

假设成立：neko 官方 Chromium 镜像 (`ghcr.io/m1k1o/neko/chromium:latest`) 可直接用于 user-chrome 容器。

## Checkpoint Results

| # | Dimension | Check | Result |
|---|-----------|-------|--------|
| ac-1 | assumption | neko 镜像可拉取 | PASS |
| ac-2 | environment | 容器启动 15s 后仍运行 | PASS |
| ac-3 | environment | neko HTTP 端点响应 200 | PASS |
| ac-4 | assumption | WebSocket 信令端点可达 (101) | PASS |
| ac-5 | assumption | supervisord 配置可定位 | PASS |
| ac-6 | assumption | Chromium 参数可定制 | PASS |
| ac-7 | environment | profile 目录 uid 1000 可写 | PASS |

## Key Findings

### supervisord 架构

主配置: `/etc/neko/supervisord.conf`，include `/etc/neko/supervisord/*.conf`

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

### Profile 定制

- `--user-data-dir` 已在 Chromium 启动参数中，可通过覆盖 `/etc/neko/supervisord/chromium.conf` 改为 `/data/profile`
- `/data/profile` 目录可由 uid 1000 (neko 用户) 写入

### WebSocket 端点

- Path: `/ws`
- 需要完整 WebSocket headers (`Sec-WebSocket-Version`, `Sec-WebSocket-Key`) 才能得到 101 响应
- 不带完整 headers 返回 400（符合 RFC 6455 规范）

### 容器进程

主要进程: supervisord → Xorg + PulseAudio + openbox + chromium + neko (Go binary)

## Phase 2 Implications

继续 Phase 2 (#71)，以 neko 官方 Chromium 镜像为基础构建 user-chrome。定制点:

1. 覆盖 `/etc/neko/supervisord/chromium.conf` 修改 `--user-data-dir=/data/profile`
2. 移除 `--bwsi` (Browse Without Sign In) 以允许用户登录 SaaS
3. 挂载 profile volume 到 `/data/profile`
