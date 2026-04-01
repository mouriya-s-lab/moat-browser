# moat-browser

企业级浏览器 RPC 系统。让 AI Agent 通过 CDP 操作远程 Chromium，用户通过 neko WebRTC 完成 SaaS 登录。

**核心理念：有状态登录 + 无状态执行。**

---

## 1. 为什么需要这个系统

企业 80% 的业务系统是 Web 应用（CRM、ERP、会计、HR、客服）。这些系统的 API 要么不存在、要么不完整、要么需要企业付费。浏览器自动化是 AI Agent 触达非 API 世界的唯一通用路径。

浏览器操作需要两个入口：

- **Agent 入口**：结构化命令（打开 URL、点击按钮、填写表单、提取数据）
- **人类入口**：首次登录 SaaS 系统（输入密码 + MFA），建立持久会话

人类负责登录，Agent 负责执行，Profile（Cookie/Session/localStorage）在中间桥接。

---

## 2. 为什么 Auth State 无法从用户本机提取

用户已经在本机 Chrome 登录了各种系统，但没有合法途径把登录状态给到远端：

| 路径 | 为什么不行 |
|------|-----------|
| CDP debug 模式 (`--remote-debugging-port`) | 用户本机安全软件拦截；用户不能关掉日常 Chrome 重新以 debug 模式启动 |
| Chrome Extension 导出 cookie | Chrome Web Store 审核不过（和凭据窃取器没区别）；Manifest V3 收紧 |
| 直接解密 cookie 数据库 | Windows DPAPI / macOS Keychain 加密；版本依赖；安全软件拦截 |
| 复制 Chrome profile 目录 | 不同 Chrome 版本的 profile 格式不兼容（数据库 schema 变更导致崩溃） |

**结论：用户必须在 Agent 使用的浏览器里重新登录一次。** 问题变成：这个登录体验怎么做好。

---

## 3. 系统架构

### 3.1 三容器模型

```
                       Shim SDK (Agent 侧)
                           │
                      Socket.IO
                           │
              ┌────────────▼────────────┐
              │       Controller        │
              │                         │
              │  Socket.IO Server       │  ← 对外 API
              │  Session Registry       │  ← Agent 注册 + 状态机
              │  Container Manager      │  ← Docker Engine API
              │  Patchright CDP Bridge  │  ← connectOverCDP 执行命令
              │                         │
              └────────────┬────────────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
   ┌──────▼──────┐  ┌─────▼──────┐  ┌──────▼─────┐
   │ user-chrome  │  │ agent-chr  │  │ agent-chr  │
   │              │  │ #1         │  │ #2         │
   │ neko WebRTC  │  │ CDP :9222  │  │ CDP :9222  │
   │ + Chromium   │  │ Chromium   │  │ Chromium   │
   │              │  │            │  │            │
   │ /data/profile│  │ /profile-1 │  │ /profile-2 │
   │ (源 profile) │  │ (cp -a)   │  │ (cp -a)   │
   └──────────────┘  └────────────┘  └────────────┘
```

### 3.2 三个容器的职责

| 容器 | 功能 | 生命周期 | 关键进程 |
|------|------|---------|---------|
| **user-chrome** | 人类通过 neko WebRTC 远程登录 SaaS | 常驻运行 | neko server + Xorg + GStreamer + Chromium |
| **agent-chrome** | 纯浏览器环境，供 Controller 通过 CDP 操控 | 按需创建/销毁 | Xorg + openbox + Chrome for Testing |
| **controller** | 唯一服务端进程，所有逻辑集中于此 | 常驻运行 | Bun + Socket.IO + Patchright |

### 3.3 为什么分容器而不是共享一个 Chromium

browser-rpc.md 原始设计是单容器：neko + Chromium + agent-browser-session daemon 共存，人类和 Agent 共享同一个 Chromium 实例。

分容器的理由：

- **隔离性**：Agent 操作不影响人类登录环境。agent-chrome 崩溃不影响 user-chrome
- **可伸缩**：一个 user-chrome 可以派生多个 agent-chrome（同一用户的多个 Agent 并行操作）
- **简化**：agent-chrome 不需要 neko/GStreamer/WebRTC，是纯净的浏览器 + CDP

代价是 profile 需要 `cp -a` 拷贝，而非直接共享。

---

## 4. 命令链路

```
Agent 进程                             平台侧
┌──────────────┐                ┌──────────────────────────┐
│ Shim SDK     │   Socket.IO   │ Controller               │
│              │◄─────────────►│                          │
│ connect()    │               │  验证 JWT                │
│ navigate()   │               │  创建 agent-chrome 容器   │
│ click()      │               │  Patchright               │
│ fill()       │               │    connectOverCDP(:9222)  │
│ snapshot()   │               │    page.goto()            │
│ screenshot() │               │    page.click()           │
│ disconnect() │               │    page.fill()            │
│              │               │    ariaSnapshot()         │
└──────────────┘               │    screenshot()           │
                               │  销毁容器 + 清理 profile  │
                               └──────────────┬───────────┘
                                              │
                                    ┌─────────▼─────────┐
                                    │ agent-chrome       │
                                    │ Chrome for Testing │
                                    │ CDP :9222          │
                                    └───────────────────┘
```

浏览器命令的完整路径：

1. Agent 调用 Shim SDK 的方法（如 `navigate("https://crm.example.com")`）
2. SDK 通过 Socket.IO 发送 `BrowserCommand` ADT 消息到 Controller
3. Controller 通过 arktype 验证消息格式
4. Controller 通过 Patchright `connectOverCDP("http://<container_ip>:9222")` 连接对应 agent-chrome
5. Controller 调用 Playwright API 执行操作（`page.goto()`, `page.click()` 等）
6. 结果封装为 `BrowserResult` ADT 返回给 Agent

---

## 5. 用户登录流程

### 5.1 neko 暴露方式

user-chrome 容器的 neko HTTP 端口直接暴露。用户浏览器直接访问 neko Web UI，WebRTC 在用户浏览器和 neko 容器之间自然建立，不需要中间代理或隧道。

```
用户浏览器                          user-chrome 容器
┌──────────────┐     HTTP/WS      ┌──────────────────┐
│              │◄────────────────►│ neko server :8080 │
│ neko Vue.js  │                  │   ├── 信令 (WS)   │
│ WebRTC 客户端│◄── WebRTC ─────►│   └── 媒体 (pion) │
│              │  (直连，无 NAT)  │                    │
└──────────────┘                  └──────────────────┘
```

### 5.2 登录流程

```
1. 用户浏览器直接访问 neko HTTP 端口（如 http://192.168.1.200:8080）
2. neko Vue.js 客户端加载，WebRTC 连接建立
3. 用户看到远程 Chromium 桌面
4. 用户操作远程 Chromium 登录 SaaS 系统（包括 MFA）
5. 登录完成 → Cookie 持久化在 /data/profile/
6. 用户关闭 neko 会话
7. Agent 注册 → Controller cp -a profile → 创建 agent-chrome → 已登录
```

后续 cookie 过期时，重复步骤 1-6。

---

## 6. 容器技术栈

### 6.1 user-chrome

基于 neko 官方 Chromium 镜像。neko 提供完整的远程桌面功能栈：

| 组件 | 技术 | 说明 |
|------|------|------|
| 显示服务器 | Xorg + `xserver-xorg-video-dummy` | 无头 X11 |
| 屏幕捕获 | GStreamer `ximagesrc` | X11 画面 → 视频帧 |
| 视频编码 | GStreamer VP8 / H264 | WebRTC 媒体流 |
| 传输 | WebRTC (pion, Go) | P2P 低延迟流 |
| 输入注入 | X11 C 绑定 (libXtst) | 鼠标 / 键盘 |
| 窗口管理 | openbox | 轻量 WM |
| 进程管理 | supervisord | 启动顺序编排 |
| 服务端 | neko (Go 单二进制) | HTTP + WebSocket + WebRTC |
| 客户端 | Vue.js | 浏览器内 WebRTC 播放器 |

neko 官方镜像的 Chromium 足以支撑人类登录场景。如果验证不可用，备选方案是参考 neko 源码从零组装。

### 6.2 agent-chrome

**不使用 neko 官方镜像。** Debian 打包的 Chromium 143 有 CDP session bug（`Target.setAutoAttach` 创建的 session 立即失效），导致 Playwright/Patchright `connectOverCDP` 完全不工作。

agent-chrome 需要参考 neko 和 agent-browser-session 的源码，从干净 Debian base 组装：

| 组件 | 来源 | 说明 |
|------|------|------|
| Xorg dummy | 参考 neko 的 xorg.conf | 无头显示 |
| openbox | 参考 neko | 窗口管理 |
| Chrome for Testing | Playwright CDN | **替代 Debian Chromium**，CDP 实现正确 |
| supervisord | 参考 neko | 进程编排（只需 Xorg + openbox + Chrome） |

不需要：neko server、GStreamer、WebRTC、输入注入、PulseAudio。

### 6.3 双入口对比

| | neko (人类入口, user-chrome) | Patchright (Agent 入口, agent-chrome) |
|---|---|---|
| 操作层 | X11 桌面（像素级） | CDP 浏览器 API（DOM 级） |
| 输入方式 | X11 输入注入（鼠标坐标 + 键码） | Playwright locator（ARIA role + name） |
| 看到什么 | 屏幕画面 | ARIA 无障碍树 |
| 传输协议 | WebRTC（视频流 + DataChannel） | Socket.IO → Patchright CDP |
| 何时用 | 首次登录、MFA、cookie 过期重认证 | 日常自动化操作 |

---

## 7. Controller 设计

Controller 是系统中唯一的服务端进程，不拆分 Gateway、daemon、注册服务等独立模块。

### 7.1 技术栈

| 技术 | 用途 |
|------|------|
| Bun + TypeScript | 运行时 |
| socket.io | 对外 WebSocket API |
| patchright | connectOverCDP 连接 agent-chrome（反检测 Playwright fork） |
| arktype | 运行时消息验证 |
| Docker Engine API | fetch + Unix socket 管理容器（不用 dockerode） |

### 7.2 核心模块

**Container Manager** — 通过 Docker Engine API 管理 agent-chrome 容器生命周期：

- 创建：`cp -a` profile → 创建容器挂载拷贝 → 等待 CDP 就绪
- 销毁：停止容器 → 删除容器 → 清理 profile 拷贝
- 查询：获取容器 IP（用于 CDP 连接）

**Patchright CDP Bridge** — 通过 Patchright `connectOverCDP` 连接 agent-chrome 执行浏览器命令：

- exhaustive switch 处理所有 BrowserCommand 变体
- 支持：Navigate, Click, Fill, Snapshot, Screenshot, Evaluate, NewTab, SwitchTab, CloseTab, Wait
- CDP 断连 → session 自动过期

**Session Registry** — Agent session 状态机：

```
Registering → CreatingContainer → ConnectingCDP → Active
                                                    │
                                    ┌───────────────┼───────────────┐
                                    │               │               │
                                 idle 超时      CDP 断连     Socket.IO 断连
                                    │               │               │
                                    ▼               ▼               ▼
                                 Expired         Expired      Reconnecting
                                                                    │
                                                              5s 超时 │
                                                                    ▼
                                                                 Expired
```

**Socket.IO Server** — 对外事件：

| 事件 | 方向 | 说明 |
|------|------|------|
| `register` | client → server | Agent 注册，创建 agent-chrome 容器 |
| `resume` | client → server | 恢复断连的 session |
| `command` | client → server | 发送浏览器命令 |
| `result` | server → client | 返回命令执行结果 |
| `deregister` | client → server | 注销，销毁容器 |

### 7.3 核心模型

一个人类，一份 profile，多个 agent。

```
user-chrome
└── /data/profile/          ← 人类登录后的源 profile
    ├── Cookies
    ├── Local Storage/
    └── ...

agent 注册时:
cp -a /data/profile/ → /data/profiles/agent-<id>/
chown -R 1000:1000 /data/profiles/agent-<id>/

agent-chrome 容器挂载:
/data/profiles/agent-<id>/ → /data/profile/

agent 注销时:
rm -rf /data/profiles/agent-<id>/
```

---

## 8. ADT 类型系统

所有请求、响应、错误、状态均使用 discriminated union（`_tag` 字段）建模。

### 8.1 BrowserCommand

```typescript
type BrowserCommand =
  | { readonly _tag: "Navigate"; readonly url: string }
  | { readonly _tag: "Click"; readonly selector: string }
  | { readonly _tag: "Fill"; readonly selector: string; readonly value: string }
  | { readonly _tag: "Snapshot" }
  | { readonly _tag: "Screenshot" }
  | { readonly _tag: "Evaluate"; readonly expression: string }
  | { readonly _tag: "NewTab"; readonly url?: string }
  | { readonly _tag: "SwitchTab"; readonly index: number }
  | { readonly _tag: "CloseTab"; readonly index: number }
  | { readonly _tag: "Wait"; readonly selector: string; readonly timeout?: number };
```

### 8.2 BrowserResult

```typescript
type BrowserResult =
  | { readonly _tag: "NavigateResult"; readonly url: string; readonly title: string }
  | { readonly _tag: "ClickResult" }
  | { readonly _tag: "FillResult" }
  | { readonly _tag: "SnapshotResult"; readonly aria: string }
  | { readonly _tag: "ScreenshotResult"; readonly png: string }  // base64
  | { readonly _tag: "EvaluateResult"; readonly value: unknown }
  | { readonly _tag: "TabResult"; readonly tabs: ReadonlyArray<{ index: number; url: string; title: string }> }
  | { readonly _tag: "WaitResult" };
```

### 8.3 GatewayError

```typescript
type GatewayError =
  | { readonly _tag: "AuthError"; readonly message: string }
  | { readonly _tag: "SessionNotFound"; readonly sessionId: string }
  | { readonly _tag: "SessionExpired"; readonly sessionId: string }
  | { readonly _tag: "CommandError"; readonly command: string; readonly message: string }
  | { readonly _tag: "ContainerError"; readonly message: string }
  | { readonly _tag: "ValidationError"; readonly message: string };
```

### 8.4 设计约束

- 所有 ADT 字段使用 `readonly`
- 所有 `switch` 必须有 `default: exhaustive(x)` 兜底
- arktype 做运行时验证，TypeScript 类型做编译时检查
- 函数返回 `Result | Error` union，不 throw
- 不使用 `any`、`as` 类型断言（除非与第三方库交互必须）

---

## 9. 已知问题与决策记录

### 9.1 Debian Chromium CDP Session Bug

neko 官方镜像自带的 Debian Chromium 143 有 CDP `Target.setAutoAttach` 缺陷——session 创建后立即失效，所有 Playwright/Patchright/Puppeteer 均复现。Chrome for Testing 同版本号无此问题。

**影响**：agent-chrome 不能使用 neko 官方镜像的 Chromium，必须使用 Chrome for Testing。

**不影响**：user-chrome 的人类登录场景（不依赖 CDP session 的高级功能）。

### 9.2 容器内 Chromium 必须 --no-sandbox

Docker 容器内 zygote 沙箱需要特权，必须加 `--no-sandbox`，否则 `Operation not permitted`。

### 9.4 Profile 目录权限

Chromium 以 neko 用户 (uid 1000) 运行。profile 目录必须 `chown -R 1000:1000`，否则 `Permission denied`。

### 9.5 Patchright 版本匹配

Patchright 版本必须与 Chrome for Testing 版本匹配。Patchright 1.57.0 = Chrome 143.0.7499。版本不匹配会导致 CDP 协议不兼容。

### 9.6 Bun 需要 host CPU

Bun 在 qemu64 CPU 上会 hang。VM 必须使用 `cpu: host`。

---

## 10. 参考项目

### neko

- 仓库：`github.com/m1k1o/neko`
- 许可：Apache-2.0
- 用途：user-chrome 的 WebRTC 远程桌面功能栈；agent-chrome 参考其 Xorg 基础设施配置
- 技术：Go 单二进制，Xorg + GStreamer + pion WebRTC + X11 输入注入

### agent-browser-session

- 仓库：`github.com/anthropics/agent-browser-session`
- 许可：Apache-2.0
- 用途：参考其 Chromium 启动参数、反检测配置、CDP 连接方式
- 技术：Rust CLI + Node.js daemon + Patchright

---

## 11. 项目结构

```
moat-browser/
├── packages/
│   ├── types/          # 共享 ADT 类型 + arktype schema
│   ├── controller/     # Controller（容器管理 + Socket.IO + CDP Bridge）
│   ├── shim/           # Shim SDK（Agent 端客户端库）
│   └── e2e/            # E2E 测试
├── images/
│   ├── user-chrome/    # User Chrome 镜像
│   └── agent-chrome/   # Agent Chrome 镜像
├── browser-rpc.md      # 原始设计参考（单容器架构，已演进为三容器）
├── CLAUDE.md           # 无人值守开发指南
├── package.json
├── bunfig.toml
└── tsconfig.json
```

---

## 12. 交付路线图

| Phase | 内容 | 状态 |
|-------|------|------|
| 1 | Browser VM IaC (Terraform + Ansible) | ✅ 完成 |
| 2 | User Chrome Docker 镜像 (neko + Chromium) | Open |
| 3 | Agent Chrome Docker 镜像 (从零组装，Chrome for Testing + CDP) | Open |
| 4 | Controller (容器管理 + Socket.IO + Patchright CDP) | Open |
| 5 | Profile 管理 (冻结/拷贝/快照) | Open |
| 6 | RPC Shim 客户端 SDK | Open |
| 7 | E2E 测试框架 | Open |

---

## 13. 资源开销估算

| 容器 | 组件 | 内存 |
|------|------|------|
| user-chrome (人类登录态) | Xorg + openbox + Chromium + neko + GStreamer | ~550-750MB |
| user-chrome (空闲) | Xorg + openbox + Chromium + neko | ~450-550MB |
| agent-chrome | Xorg + openbox + Chrome for Testing | ~350-550MB |
| controller | Bun + Patchright runtime | ~100-200MB |

每增加一个 Agent 实例 = 一个 agent-chrome 容器 ≈ 350-550MB。
