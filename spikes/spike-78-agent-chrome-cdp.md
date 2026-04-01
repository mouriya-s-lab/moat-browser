# Spike B: Chrome for Testing + Xorg Dummy CDP 可达性验证

- **Issue**: Mouriya-Emma/moat-browser#78
- **Date**: 2026-04-02
- **Target**: VM 104 (192.168.1.200)
- **Image**: `spike-agent-chrome` (Debian bookworm-slim + Chrome for Testing 147.0.7727.24)

## Result: PASS (8/8)

| # | Dimension | Check | Result |
|---|-----------|-------|--------|
| ac-1 | function | Chrome for Testing 可下载安装 | PASS — v147.0.7727.24 via `npx @puppeteer/browsers install chrome@stable` |
| ac-2 | environment | Xorg dummy 启动 | PASS — 1024x768, screen #0 |
| ac-3 | environment | Chrome 启动并绑定 CDP | PASS — 127.0.0.1:9222 (Chrome) + 0.0.0.0:9223 (socat) |
| ac-4 | environment | CDP HTTP 端点从容器外可达 | PASS — JSON 含 `"Browser": "Chrome/147.0.7727.24"` |
| ac-5 | assumption | Patchright connectOverCDP 成功 | PASS — page.goto("about:blank") 成功 |
| ac-6 | assumption | CDP session 稳定（无 setAutoAttach bug） | PASS — title = "Example Domain" |
| ac-7 | integration | ARIA snapshot 可提取 | PASS — 232 chars, 含 heading/paragraph/link 结构 |
| ac-8 | environment | 容器内无 neko/GStreamer 进程 | PASS — 仅 supervisord + Xorg + openbox + chrome + socat |

## Key Findings

### Chrome for Testing 147 忽略 --remote-debugging-address

Chrome for Testing 147.0.7727.24 完全忽略 `--remote-debugging-address=0.0.0.0`，始终绑定 `127.0.0.1:9222`。无论以 root 还是非 root 用户运行均如此。

**解决方案**: 使用 socat 转发：
```
socat TCP-LISTEN:9223,fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:9222
```

容器 EXPOSE 9223，host 映射 `-p 9222:9223`。

### Bun + Playwright WebSocket 不兼容

Patchright/Playwright 的 `connectOverCDP()` 在 Bun 运行时下无法建立 WebSocket 连接（timeout）。原生 Bun WebSocket API 可正常连接同一端点。

**解决方案**: Controller 中使用 Node.js 运行 Patchright，不使用 Bun。或等待 Bun 修复 Playwright WebSocket 兼容性。

### supervisord 结构

```ini
[program:xorg]     # Xorg :99 dummy display
[program:openbox]  # 窗口管理器
[program:chrome]   # Chrome for Testing + --no-sandbox + CDP port 9222
[program:socat]    # TCP forward 0.0.0.0:9223 → 127.0.0.1:9222
```

### Chrome 以 root 运行需 --no-sandbox

容器内 Chrome 以 root 运行时必须加 `--no-sandbox`。非 root 用户在 Docker 内也需要 `--no-sandbox`（sandbox 创建失败导致 SIGTRAP）。

### 验证用 Dockerfile

```dockerfile
FROM debian:bookworm-slim
# 依赖: xserver-xorg-core, xserver-xorg-video-dummy, openbox, supervisor, socat
# Chrome for Testing: npx @puppeteer/browsers install chrome@stable
# 关键: ln -s chrome-linux64 目录到 /opt/chrome，supervisord 用 /opt/chrome/chrome
```

完整 Dockerfile 和配置保存在验证临时目录中，Phase 3 (#72) 以此为基础构建。

## Conclusion

假设成立。Chrome for Testing 在 Debian 容器中通过 Xorg dummy + openbox 可正常运行，CDP 通过 socat 从容器外可达，Patchright connectOverCDP 可稳定连接并执行浏览器命令（需 Node.js 运行时）。Phase 3 (#72) 可继续。
