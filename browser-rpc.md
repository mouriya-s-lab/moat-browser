# 浏览器 RPC — Moat 组件参考

> 角色：Agent 的浏览器操作能力通道 + 用户的远程登录入口
> 类型：RPC 执行容器（Chromium + neko + Patchright daemon）
> 依赖：neko (Apache-2.0), agent-browser-session (Apache-2.0)
> 关联组件：RPC shim、Shim Router、Daemon、ZFS、OTel

---

## 1. 为什么需要这个组件

企业 80% 的业务系统是 Web 应用（CRM、ERP、会计、HR、客服）。这些系统的 API 要么不存在、要么不完整、要么需要企业付费。浏览器自动化是 Agent 触达非 API 世界的唯一通用路径。

浏览器操作需要两个入口：
- **Agent 入口**：结构化命令（打开 URL、点击按钮、填写表单、提取数据）
- **人类入口**：首次登录 SaaS 系统（输入密码 + MFA），建立持久会话

两个入口共享同一个 Chromium 实例和 profile，Cookie 写入一次，双方共用。

---

## 2. 为什么 Auth State 无法从用户本机提取

用户已经在本机 Chrome 登录了各种系统，但没有合法途径把登录状态给到远端：

| 路径 | 为什么不行 |
|------|-----------|
| CDP debug 模式（`--remote-debugging-port`） | 用户本机安全软件拦截；用户不能关掉日常 Chrome 重新以 debug 模式启动 |
| Chrome Extension 导出 cookie | Chrome Web Store 审核不过（和凭据窃取器没区别）；Manifest V3 收紧 |
| 直接解密 cookie 数据库 | Windows DPAPI / macOS Keychain 加密；版本依赖；安全软件拦截 |
| 复制 Chrome profile 目录 | 不同 Chrome 版本的 profile 格式不兼容（数据库 schema 变更导致崩溃） |

**结论：用户必须在 Agent 使用的浏览器里重新登录一次。** 问题变成：这个登录体验怎么做好。

---

## 3. 架构

### 3.1 组件拓扑

```
┌──── Agent 容器 ──────────────────────┐
│                                      │
│  agent-browser-session CLI (Rust)    │  ← shim binary，~5MB，零依赖
│  只是 Unix socket 客户端              │
│                                      │
└───────┬──────────────────────────────┘
        │ Unix socket
        │
┌───────▼──── Shim Router ─────────────┐
│                                      │
│  浏览器 Skill 路由                    │
│  ├── 命令 schema 验证（Zod）          │
│  ├── 域名 ACL（navigation 时校验）    │
│  ├── 资源预算（操作次数 / 时间）       │
│  └── OTel span 记录                  │
│                                      │
└───────┬──────────────────────────────┘
        │ 转发到 RPC 执行容器
        │
┌───────▼──── 浏览器 RPC 执行容器 ─────┐
│                                      │
│  supervisord                         │
│  ├── Xorg :99.0 (Dummy 驱动)         │
│  ├── openbox (窗口管理器)             │
│  ├── Chromium                        │
│  │    --remote-debugging-port=9222   │
│  │    --disable-blink-features=      │
│  │      AutomationControlled         │
│  │    --user-data-dir=/data/profile  │
│  │    --display=:99.0                │
│  │                                   │
│  ├── neko server ← 人类登录入口      │
│  │    Xorg 画面 → GStreamer →        │
│  │    WebRTC (pion) → 用户浏览器     │
│  │    用户输入 → X11 注入 → Chromium  │
│  │                                   │
│  └── agent-browser-session daemon    │
│       ← Agent 操作入口               │
│       connectOverCDP(:9222)          │
│       Unix socket 接受 shim 命令     │
│                                      │
│  /data/profile/ ← ZFS dataset        │
│   Cookies, localStorage, IndexedDB   │
└──────────────────────────────────────┘
```

### 3.2 双入口共享一个 Chromium

| | neko（人类入口） | Patchright（Agent 入口） |
|---|---|---|
| 操作层 | X11 桌面（像素级） | CDP 浏览器 API（DOM 级） |
| 输入方式 | X11 输入注入（鼠标坐标 + 键码） | Playwright locator（ARIA role + name） |
| 看到什么 | 屏幕画面 | ARIA 无障碍树 |
| 传输协议 | WebRTC（视频流 + DataChannel） | JSON-line over Unix socket |
| 何时用 | 首次登录、MFA、cookie 过期重认证 | 日常自动化操作 |

**两者完全正交**——neko 通过 X11 层面操作桌面，Patchright 通过 CDP 层面操作浏览器 DOM。Chromium 的 `--remote-debugging-port` 开启 CDP 端口，对 X11 层面无影响，对反爬检测无影响（Web 页面检测不到 localhost 上的 TCP 端口）。

Patchright 的反检测能力不受 CDP 端口影响——`--disable-blink-features=AutomationControlled` 和 stealth scripts 是启动参数 + 运行时注入，和 CDP 连接方式无关。

---

## 4. neko 技术栈

neko 是自托管虚拟桌面流式平台（Apache-2.0），用 WebRTC 推流一个 Linux X11 桌面。

| 组件 | 技术 | 说明 |
|------|------|------|
| 显示服务器 | Xorg + `xserver-xorg-video-dummy` | 无头 X11，不是 Xvfb |
| 屏幕捕获 | GStreamer `ximagesrc` | X11 画面 → 视频帧 |
| 视频编码 | GStreamer VP8 / H264 | 支持 VAAPI 硬件加速 |
| 传输 | WebRTC（pion 库，Go） | P2P 低延迟流 |
| 输入注入 | X11 C 绑定（libXtst） | 鼠标 / 键盘 / 触摸 |
| 窗口管理 | openbox | 轻量 WM |
| 进程管理 | supervisord | 启动顺序编排 |
| 服务端 | Go 单二进制 | HTTP + WebSocket + WebRTC |
| 客户端 | Vue.js | 浏览器内 WebRTC 播放器 |

neko 原生支持多种浏览器镜像：Chromium、Google Chrome、Firefox、Microsoft Edge、Brave、Vivaldi、Opera、Tor Browser、ungoogled-chromium。

---

## 5. agent-browser-session 技术栈

agent-browser-session 是 AI Agent 浏览器自动化 CLI（Apache-2.0），fork 自 vercel-labs/agent-browser。

| 组件 | 技术 | 说明 |
|------|------|------|
| CLI | Rust 静态二进制 | 毫秒级冷启动，零依赖 |
| IPC | Unix socket / TCP | JSON-line 协议 |
| Daemon | Node.js 长驻进程 | 浏览器生命周期管理 |
| 浏览器引擎 | Patchright（反检测 Playwright fork） | CDP 操作 |
| 页面表示 | ARIA Snapshot + Ref 系统 | Token 高效的结构化页面描述 |
| 多 Agent | `--tabname` 隔离 | 每个 Agent 独立 Page / CDP session / RefMap |

80+ 种浏览器命令：导航、点击、填充、截图、快照、Cookie 操作、Tab 管理、等待、JavaScript 执行等。

---

## 6. WebRTC 穿透

### 6.1 问题

neko 的 WebRTC 需要在 RPC 执行容器和用户浏览器之间建立媒体通路。但：
- RPC 执行容器在平台内网，没有公网 IP
- 用户在 NAT 后面，通过 Daemon（gRPC mTLS）连接平台

### 6.2 方案：TCP Mux + Daemon 反向代理

neko 原生支持 **ICE TCP Mux**（`webrtc.tcpmux` 配置）——把 WebRTC 的媒体流复用到单个 TCP 端口上。这意味着整个 neko 的流量（HTTP + WebSocket 信令 + WebRTC 媒体）都走 TCP，可以被反向代理。

```
用户本机                              平台侧
┌─────────────────────┐              ┌──────────────────────────────┐
│ Daemon              │              │ Shim Router                  │
│                     │    gRPC      │                              │
│ 本地 HTTP 代理      │◄───mTLS────►│  反向代理 → 执行容器          │
│ localhost:PORT      │   双向流     │                              │
│                     │              └──────────┬───────────────────┘
│ 浏览器打开          │                         │
│ localhost:PORT      │              ┌──────────▼───────────────────┐
│ → neko Web UI       │              │ 浏览器 RPC 执行容器           │
│ → WebRTC 连接       │              │                              │
│                     │              │ neko server                   │
└─────────────────────┘              │   HTTP :8080                 │
                                     │   WebSocket :8080            │
                                     │   TCP Mux :8081 (WebRTC)     │
                                     └──────────────────────────────┘
```

**流量路径**：

1. **信令**：用户浏览器 → `localhost:PORT` → Daemon → gRPC mTLS → Shim Router → 执行容器 neko HTTP/WebSocket `:8080`
2. **媒体**：用户浏览器 WebRTC → ICE candidate `localhost:PORT` → Daemon → gRPC mTLS → Shim Router → 执行容器 TCP Mux `:8081`

**关键点**：

- neko 启用 `webrtc.tcpmux=8081` 后，WebRTC 媒体走 TCP，不需要 UDP
- 不需要 TURN 服务器——所有流量通过 Daemon 的 gRPC 隧道
- neko 启用 `webrtc.icelite=true` + 后端 ICE server 指向 TCP mux 地址
- Daemon 只是一个 TCP 反向代理 / gRPC 流复用器，不需要理解 WebRTC 协议

**neko 配置**：

```yaml
webrtc:
  icelite: true
  tcpmux: 8081
  iceservers:
    frontend:
      - urls: ["stun:stun.l.google.com:19302"]  # 用户侧 STUN
```

### 6.3 备选方案

如果 gRPC 隧道的带宽或延迟不满足 WebRTC 要求：

| 方案 | 做法 | 代价 |
|------|------|------|
| **TURN 中继** | 平台部署 TURN 服务器（公网 IP），neko 和用户都通过 TURN 中继 | 需要公网端口 + 带宽成本 |
| **不用 WebRTC** | neko 有 WebSocket fallback 模式，直接推 JPEG 帧 | 延迟和帧率下降，但穿透问题消失 |

TCP Mux + gRPC 隧道是首选——零额外基础设施，复用已有的 Daemon 连接。

---

## 7. 用户登录流程

```
1. 用户在 Moat Web UI 点击"配置浏览器登录"
2. Daemon 通过 gRPC 隧道建立到执行容器 neko 的连接
3. Daemon 在本地开 HTTP 代理端口
4. 用户浏览器打开 localhost:PORT → neko Web UI
5. WebRTC 连接建立 → 用户看到远程 Chromium 窗口
6. 用户操作远程 Chromium 登录 SaaS 系统（包括 MFA）
7. 登录完成，用户关闭 neko 会话
8. Cookie 持久化在 /data/profile/
9. ZFS snapshot /data/profile → 备份登录状态
10. Agent 通过 Patchright CDP 连接同一个 Chromium → 已登录
```

后续 cookie 过期时，重复步骤 2-7。

### 输入冲突规避

人类操作（neko）和 Agent 操作（Patchright）不应同时进行：

- **人类登录时**：Shim Router 暂停该执行容器的浏览器 Skill 路由，Agent 命令排队等待
- **Agent 工作时**：neko 会话不活跃（用户已关闭），Patchright 独占

如果需要并行：Chromium 多 tab，neko 操作一个 tab（人类），Patchright 通过 `--tabname` 操作其他 tab（Agent）。

---

## 8. 容器镜像构建

### 8.1 快速验证（直接基于 neko 镜像）

```dockerfile
FROM ghcr.io/m1k1o/neko/chromium:latest

# 加入 agent-browser-session daemon
COPY --from=agent-browser-builder /dist/daemon.js /opt/agent-browser/
COPY --from=agent-browser-builder /bin/agent-browser-session-linux-x64 /usr/local/bin/

# 替换 Chromium supervisord 配置（加 CDP + 反检测参数）
COPY chromium-cdp.conf /etc/neko/supervisord/chromium.conf

# 加入 agent-browser-session daemon supervisord 配置
COPY agent-browser-daemon.conf /etc/neko/supervisord/agent-browser.conf

# Profile 目录
VOLUME /data/profile
```

**chromium-cdp.conf**：

```ini
[program:chromium]
environment=HOME="/home/%(ENV_USER)s",USER="%(ENV_USER)s",DISPLAY="%(ENV_DISPLAY)s"
command=/usr/bin/chromium
  --remote-debugging-port=9222
  --disable-blink-features=AutomationControlled
  --window-position=0,0
  --display=%(ENV_DISPLAY)s
  --user-data-dir=/data/profile
  --no-first-run
  --start-maximized
  --disable-gpu
  --disable-dev-shm-usage
stopsignal=INT
autorestart=true
priority=800
user=%(ENV_USER)s
```

**agent-browser-daemon.conf**：

```ini
[program:agent-browser-daemon]
environment=AGENT_BROWSER_DAEMON=1,AGENT_BROWSER_SESSION=main,AGENT_BROWSER_HEADED=0,AGENT_BROWSER_SOCKET_DIR=/run/agent-browser
command=node /opt/agent-browser/daemon.js
autorestart=true
priority=900
user=%(ENV_USER)s
```

### 8.2 生产优化（裁剪 neko）

从 neko 基础镜像中移除不需要的组件：

| 保留 | 移除 |
|------|------|
| Xorg Dummy | PulseAudio（浏览器操作不需要音频） |
| GStreamer ximagesrc + VP8/H264 编码 | 音频管道（pulsesrc + opus） |
| neko server（WebRTC + 信令） | 聊天插件 |
| openbox | 文件传输插件 |
| Chromium | 多用户会话管理（Moat 用 Keycloak） |

裁剪后镜像体积预计从 ~1.2GB 降到 ~800MB。

---

## 9. Shim Router 集成

### 9.1 浏览器命令的管控

Shim Router 在转发浏览器命令到执行容器之前，执行以下检查：

| 检查项 | 做法 |
|--------|------|
| **命令 schema 验证** | 用 agent-browser-session 的 Zod schema 验证 JSON 命令格式 |
| **域名 ACL** | `navigate` 命令的 URL 与 Skill 声明的域名白名单比对，不在白名单内 → 拒绝 |
| **资源预算** | 累计操作次数 / 已用时间 / 导航次数，超限 → 中断 Agent session 并通知 |
| **OTel 审计** | 每个命令记录为 `otel_traces` 中的 span：action, tabName, url, selector, duration, success |

### 9.2 域名 ACL 示例

Skill 声明文件中：

```yaml
browser:
  allowed_domains:
    - "*.salesforce.com"
    - "*.google.com"
    - "app.hubspot.com"
  blocked_domains:
    - "*.competitor.com"
```

Shim Router 拦截 `navigate` 命令，检查目标 URL 的域名是否在白名单中。

### 9.3 资源预算示例

```yaml
browser:
  limits:
    max_navigations: 50        # 最多导航 50 次
    max_actions: 500           # 最多操作 500 次（点击/填充/等待等）
    max_duration_seconds: 3600 # 最多运行 1 小时
```

超限时 Shim Router 向 Agent 返回错误（不是让 Agent 决定停不停——环境直接中断）。

---

## 10. Profile 管理

### 10.1 持久化

Profile 目录 `/data/profile/` 放在 ZFS dataset 上：

- 每次 Agent session 开始前自动 snapshot
- 登录状态出问题可以回滚到上次正常状态
- Profile 可以 clone 给多个执行容器（同一用户的多个 Agent 共享登录状态）

### 10.2 安全属性

Profile 中包含 cookie、session token、localStorage——这些都是凭据。

- Agent 容器内 **零 profile**——CLI shim 只是 socket 客户端，不接触任何浏览器数据
- Profile 只存在于 RPC 执行容器的文件系统中
- Agent 通过 shim 命令操作浏览器，返回的是 ARIA snapshot / 截图 / 文本内容，不是 cookie
- 即使 Agent 发送 `cookies` 命令，Shim Router 可以在路由策略中禁止该命令类型

---

## 11. 与其他组件的关系

| 组件 | 关系 |
|------|------|
| **RPC shim** | Agent 容器内的 `agent-browser-session` CLI 就是浏览器的 shim binary |
| **Shim Router** | 浏览器命令的路由 + 域名 ACL + 资源预算 + OTel 记录 |
| **Daemon** | 用户本机的 gRPC 客户端，做 neko WebRTC 的反向代理隧道 |
| **ZFS** | Profile 目录的 snapshot / clone / 回滚 |
| **OTel + ClickHouse** | 浏览器操作审计日志（span per command） |
| **Skills Store** | 浏览器 Skill 的域名白名单和资源预算在 Skill 入库时声明 |
| **Keycloak** | neko 的用户认证（替代 neko 内置的简单 password provider） |
| **透明代理 (Xray-core)** | Chromium 的网络出口经透明代理，域名 ACL 在网络层也有一道 |

---

## 12. 资源开销

| 组件 | 内存 | 说明 |
|------|------|------|
| Xorg (Dummy) | ~30MB | 固定 |
| openbox | ~5MB | 固定 |
| Chromium | ~300-500MB | 取决于页面数 |
| neko server (Go) | ~30MB | 固定 |
| GStreamer pipeline | ~50-100MB | 仅 neko 会话活跃时 |
| agent-browser-session daemon | ~50MB | Node.js + Patchright runtime |
| **总计（Agent 工作态）** | **~450-650MB** | neko 不活跃，GStreamer 不跑 |
| **总计（人类登录态）** | **~550-750MB** | neko 活跃，GStreamer 运行 |
