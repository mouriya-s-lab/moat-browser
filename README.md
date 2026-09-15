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
                     Agent (Claude Code / Cursor)
                           │
               ┌───────────┴───────────┐
               │ shell 命令            │ TS import
               ▼                       ▼
        ┌─────────────┐        ┌─────────────┐
        │ moat CLI    │        │ TS 程序      │
        │ (Rust)      │        │ / 第三方 CLI  │
        └──────┬──────┘        └──────┬──────┘
               │                      │
        ┌──────▼──────┐        ┌──────▼──────┐
        │  Rust SDK   │        │   TS SDK    │
        │  (RPC 客户端)│        │  (RPC 客户端)│
        └──────┬──────┘        └──────┬──────┘
               │                      │
               └──────────┬───────────┘
                          │ 相同 wire 协议
                          │ (agent-browser daemon JSON + session envelope)
                          ▼
                     WebSocket
                          │
           ┌──────────────▼──────────┐
           │       Controller        │
           │                         │
           │  WebSocket Server       │  ← 实现 wire 协议服务端
           │  Session Registry       │  ← session → 容器映射
           │  Container Manager      │  ← Docker Engine API
           │  Patchright CDP Bridge  │  ← connectOverCDP 执行命令
           │                         │
           └────────────┬────────────┘
                        │
       ┌────────────────┼────────────────┐
       │                │                │
┌──────▼──────┐  ┌──────▼─────┐  ┌──────▼─────┐
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
| **controller** | 唯一服务端进程，所有逻辑集中于此 | 常驻运行 | Node.js + Socket.IO + Patchright |

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
Agent 侧                                 平台侧 (VM 104)

路径 A: Rust CLI
┌──────────────────┐
│ moat CLI (Rust)  │
│                  │
│ $ moat find role │
│     button ...   │
│ $ moat find label│
│     "Email" fill │
│ $ moat snapshot  │
│ $ moat screenshot│
└────────┬─────────┘
         │ 调用
┌────────▼─────────┐                ┌──────────────────────────┐
│   Rust SDK       │   WebSocket    │ Controller (Node.js)     │
│   (RPC 客户端)    │◄──────────────►│                          │
└──────────────────┘  wire 协议      │  WebSocket Server        │
                                    │  Session Registry         │
路径 B: TS SDK                       │  → 定位 agent-chrome      │
┌──────────────────┐                │                           │
│ TS 程序 /        │                │  Patchright               │
│ 第三方 TS CLI    │                │    connectOverCDP(:9222)  │
└────────┬─────────┘                │    getByRole()            │
         │ import                   │    getByLabel()           │
┌────────▼─────────┐                │    click() / fill()       │
│    TS SDK        │   WebSocket    │    ariaSnapshot()         │
│   (RPC 客户端)    │◄──────────────►│                          │
└──────────────────┘  wire 协议      └──────────────┬───────────┘
                                                   │
                                         ┌─────────▼─────────┐
                                         │ agent-chrome       │
                                         │ Chrome for Testing │
                                         │ CDP :9222          │
                                         └───────────────────┘
```

命令完整路径（以 Rust CLI 为例，TS SDK 路径等价）：

1. Agent 在 shell 中执行 CLI 命令（如 `moat find role button --name "Submit"`）
2. moat CLI 解析命令，调用 Rust SDK 的 RPC 方法
3. Rust SDK 将命令序列化为 wire 协议 JSON，通过 WebSocket 发送到远程 Controller
4. Controller 通过 Session Registry 定位对应 agent-chrome 容器
5. Controller 通过 Patchright `connectOverCDP("http://<container_ip>:9222")` 执行命令，语义定位器直接映射到 Playwright 的 `getByRole()` / `getByLabel()` 等
6. 结果以 wire 协议 JSON 回传 → SDK 反序列化 → CLI 格式化输出 → Agent

TS 程序可以直接 import TS SDK 调用，也可以通过 TS SDK 构建 opencli / CLI-Anything 风格的 CLI 包装。

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
1. 用户浏览器直接访问 neko HTTP 端口（如 http://browser.mouriya.lan:8080）
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
| Node.js + TypeScript | 运行时（Patchright/Playwright 与 Bun 有 CDP 兼容性问题） |
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

## 8. SDK 设计

### 8.1 定位：RPC 抽象层，CLI 的基座

SDK 是 moat-browser 的**核心客户端抽象**，实现 wire 协议（Section 10.1）的客户端侧。所有 CLI 和程序化调用都建在 SDK 之上，SDK 不是 CLI 的附属品。

**双实现**：TS 和 Rust 各一个 SDK，实现相同的 wire 协议：

| SDK | 语言 | 消费者 |
|-----|------|--------|
| TS SDK | TypeScript | TS/JS 程序、opencli 风格 CLI、CLI-Anything 风格 CLI |
| Rust SDK | Rust | moat CLI（agent-browser 命令词汇） |

**分层关系**：

```
┌─────────────────────────────────────────────────┐
│                   CLI 层                         │
│  moat CLI (Rust)  │  TS CLI 包装 (可选)           │
│  命令解析 + 输出格式 │  opencli / CLI-Anything 风格  │
├───────────────────┼─────────────────────────────┤
│                   SDK 层                         │
│    Rust SDK       │       TS SDK                 │
│  WebSocket + 序列化 │  WebSocket + 序列化           │
├─────────────────────────────────────────────────┤
│              Wire 协议（单一契约）                  │
│     agent-browser daemon JSON + session envelope │
└─────────────────────────────────────────────────┘
```

这种双 SDK 不是冗余，而是服务两个生态：
- **Rust SDK** → Rust CLI 二进制，Agent 的主入口（shell 调用零开销）
- **TS SDK** → TS 生态，第三方团队可以直接 import 构建任意风格的 CLI 包装，也可以在 TS 程序中程序化调用

SDK 的通用性要求：agent-browser CLI、opencli、CLI-Anything 三种风格的 CLI 都能在 SDK 基础上复刻，SDK 不假设任何特定的 CLI 模式。

### 8.2 SDK 核心 API（两个实现共享的语义）

```typescript
// TS SDK 示例（Rust SDK 暴露等价 API）
import { createSession } from "@moat-browser/sdk";

const session = await createSession({
  controller: "ws://browser.mouriya.lan:3000",
  profile: "default",
});

// 语义定位器（主路径）
await session.findByRole("button", { name: "Submit" }).click();
await session.findByLabel("Email").fill("user@example.com");
await session.findByPlaceholder("Search...").type("Acme Corp");

// 导航
await session.navigate("https://crm.example.com");
await session.press("Enter");

// Fallback：snapshot + ref
const snap = await session.snapshot();
// snap.aria 包含带 [ref=eN] 的 ARIA 树
await session.click("@e3");

// 收尾
await session.disconnect();
```

API 表面对齐 Playwright locator API，因为 agent-browser 的语义定位器就是 Playwright 的封装。

### 8.3 SDK 职责边界

SDK **负责**：
- WebSocket 连接管理（建连、断连重连、心跳）
- Session 生命周期（connect → active → disconnect）
- 命令序列化 / 响应反序列化（wire 协议编解码）
- 结构化结果返回（`Result | Error` union）

SDK **不负责**：
- 命令解析（CLI 层的职责）
- 输出格式化（CLI 层的职责）
- Exit code（CLI 层的职责）
- REPL（Agent 不能用 REPL，见 Section 9.2）

---

## 9. CLI 设计

### 9.1 设计原则：fork agent-browser，transport 层换成 Rust SDK

moat CLI **是 agent-browser（`github.com/vercel-labs/agent-browser`）的 fork**。upstream 更新时可以直接 merge，只有 transport 层有冲突。

- **保留**（从 agent-browser 不动的）：
  - 命令词汇：`open`、`click`、`fill`、`find role/label/text/placeholder/alt/title/testid`、`snapshot`、`screenshot`、`eval`、`wait`、`press`、`scroll`、`tab`、`batch`、`cookies` 等全部
  - 元素定位：Playwright 语义定位器（主）+ `@eN` 引用（辅）
  - 输出格式：text 模式 + `--json` 模式 + content boundary nonce
  - Exit code 体系
  - `scroll` without `--selector` moves the active window; `scroll ... --selector <css>` moves only the first matching element in the active page/frame and leaves the window unchanged. Successful results expose measured before/after positions, actual delta, maximum position, and boundary clipping; missing targets are `target_not_found`, and an axis with no overflow is `invalid_value`.
  - 配置文件合并规则（user > project > CLI flag）
- **修改**（唯一实质改动）：
  - transport 层：原来直接走本地 Unix socket → 本地 daemon，改为调用 Rust SDK → 远程 WebSocket → Controller
- **新增**（远程容器需要显式 session 管理）：
  - `moat connect` / `moat disconnect` / `moat status`

与旧设计的区别：旧设计是 CLI 自己内联 WebSocket 连接逻辑（改 `connection.rs`）。新设计是 CLI 调用 Rust SDK，SDK 封装 WebSocket + wire 协议。效果一样（CLI fork + 只改 transport），但 transport 实现被抽到 SDK 里，TS 侧可以复用同一抽象。

理由：
1. agent-browser 的设计已被 Agent 实战验证，命令词汇 / 定位器 / 输出格式都是成熟方案，重新发明只会更差
2. Agent 迁移成本为零 —— 会用 agent-browser 的 Agent 直接能用 moat-browser
3. 可以持续跟上游迭代（merge upstream，只有 transport 层冲突）
4. transport 层抽到 SDK 后，TS SDK 复用同一 wire 协议抽象，第三方可用 TS SDK 构建 opencli / CLI-Anything 风格的 CLI 包装

### 9.2 Agent 交互模型：语义意图 → 语义定位器

这是理解整个 CLI 设计的地基。

**Agent 有什么**：先验知识 + 目标驱动的意图。知道登录页有 Email 字段，知道表单有 Submit 按钮，知道搜索框有 placeholder。

**Agent 没有**：连续视觉，所以不能像人一样"看着屏幕操作"。

**错误推论**（我之前犯的）：Agent 看不见 → 必须先获取页面表示 → snapshot 是默认循环。

**正确推论**：Agent 有语义意图 → 直接发语义定位器命令 → Controller 用 Playwright 在服务端解析 → 只有结果跨网络回来。

**主路径（90% 场景）：Playwright 语义定位器**

```bash
# 填登录表单
moat find label "Email" fill "user@example.com"
moat find label "Password" fill "hunter2"
moat find role button --name "Sign in"

# 搜索
moat find placeholder "Search..." type "Acme Corp"
moat press Enter

# 点击表格里的某行
moat find role button --name "Edit" --nth 3
```

每条命令 ~40 token，直接映射到 Playwright 的 `getByRole()` / `getByLabel()` / `getByPlaceholder()` / `getByText()` / `getByAltText()` / `getByTitle()` / `getByTestId()`。服务端定位 + 执行 + 返回结果。

**Fallback 路径：snapshot + `@eN` 引用**

只在以下情况触发：

1. 页面完全陌生，Agent 没有语义先验
2. 语义定位器失败（返回 element not found）

此时 Agent 执行一次 `moat snapshot` 拿到完整 ARIA 树（代价：1000+ token 进 context），树里每个可交互元素带 `[ref=eN]`，Agent 用 `moat click @e3` 操作。用完立刻回到语义定位器主路径。

**token 经济学对比**：

| 策略 | 单次成本 | 何时用 |
|------|---------|--------|
| `find role button --name "Submit"` | ~40 token | 绝大多数情况（有语义先验） |
| `snapshot` + `click @e3` | 1000+ token（整棵树进 context） | 探索陌生页面、语义定位器失败 |

**关于 SKILL.md 的规则**：必须明确写"优先 semantic locators，snapshot 是探索工具"，而不是"ALWAYS snapshot first"（后者是反模式）。

### 9.3 命令参考

CLI 命令词汇完整继承自 agent-browser fork，详见上游文档：`github.com/vercel-labs/agent-browser`。本文档不重复列表，只列出 moat-browser **新增**或**行为有差异**的命令。

**新增命令**（session 生命周期，因为远程容器需要显式管理）：

| 命令 | 说明 |
|------|------|
| `moat connect [--profile <registered-name>]` | 建立 session：Controller 按受信任注册名称解析 profile，拷贝 profile、创建带 owner/session 标签的 agent-chrome 容器、等待 CDP 就绪。`default` 始终指向 `PROFILE_SOURCE`；其他名称必须由 Controller 的 `PROFILE_REGISTRY` 显式注册。绝对路径、相对路径、路径分隔符和未注册名称在创建 session 前返回 `invalid_value`，不会产生容器或 profile 副本。session ID 写入 `~/.moat/session`；已有本地 session 时在远端注册前拒绝，保留原 handle。 |
| `moat disconnect` / `moat destroy` / `moat close-session` / `moat close` | 共享同一清理终态：只有 Controller 确认当前 owner 的容器与 profile 已清理才返回成功并删除 `~/.moat/session`。传输、删除或终态未知时返回非零失败，保留本地 session handle 供重试。 |
| `moat status` | 显示本地 session ID、按本次调用解析的 Controller 配置与 `local_session_config` 视图；不探测远端健康状态 |

`--profile` 只接受 profile 名称，不接受客户端或 Controller 路径。Controller
操作员可通过 JSON 环境变量注册额外名称；来源必须是已挂载的目录并位于
`PROFILE_STORE`（默认 `PROFILES_WORK`）之内：

```bash
PROFILE_STORE=/data/profiles
PROFILE_REGISTRY='{"named-fixture":"/data/profiles/named-fixture"}'
```

`default` 是保留名称，始终使用 `PROFILE_SOURCE`，不能由
`PROFILE_REGISTRY` 覆盖。注册来源不存在或越出受控目录时，该名称会以
`invalid_value` 拒绝；不会按名称推导 `/data/<name>`，也不会自动创建目录。

`PROFILE_REGISTRY` 若不是合法 JSON 对象或包含非法条目，Controller 会在启动时
失败，而不会静默退化为空注册表。

**与 agent-browser 的行为差异**：

| 命令 | agent-browser 行为 | moat 行为 |
|------|---------|----------|
| （所有命令） | 隐式自动启动本地 daemon + 本地 Chrome | 需要先 `moat connect`，返回 exit 77 如未连接 |

**C14 公开契约**：

- `moat window new` 保留同一 BrowserContext 的能力，但创建的是当前共享会话中的新 tab，不是隔离 browser context 或操作系统窗口。
- `moat get cdp-url` 在 moat 架构中不可用，返回 `unsupported_in_moat`；agent-chrome 的 CDP 端口仅供 Controller 在 Docker 内部网络访问，CLI 不返回容器地址。
- `moat click <selector> --new-tab` 会把带非空 HTTP(S) `href` 的链接打开到新的活动 tab，并保留原 tab；没有可打开链接时在导航前返回错误。
- `moat tab close [index]` 在关闭前校验至少保留一个 tab；关闭最后一个 tab 会在页面关闭前返回 `errorType: "invalid_value"` 与稳定文案 `Validation failed: Cannot close the last tab; at least one tab must remain open`，原 tab 与 session 保持可用。需要结束整个 session 时使用 `moat disconnect`（或 `moat close`）。若浏览器侧事件使 context 变成零页面，后续命令返回 `errorType: "target_not_found"`（目标 `page`），不会泄漏引擎错误或让 session 过期。
- `moat network route` 目前只接受 `--abort` 与 `--body <json>`；`--status`、`--delay`、`--headers` 等不支持选项会在安装 route 前返回 `unsupported_in_moat`。
- `find first`、`find last`、`find nth` 只接受已登记的动作名；未知动作、缺少动作值和越界 occurrence 会在页面副作用前失败，`fill ""` 仍表示清空输入。`keydown`/`keyup` 是显式配对的低层操作；未释放 modifier 时，高层输入会在副作用前拒绝并返回当前 held modifiers。

**JavaScript dialog 归属与结算（M23）**：

- `dialog status`、`dialog accept`、`dialog dismiss` 始终作用于当前 active Page 的具体 modal，并返回 `pageId`、当前 tab index、`dialogId` 与 modal 类型/消息；后创建的 tab 不会覆盖先创建的 modal。
- `eval` 触发 modal 后，Controller 最多等待 **3s handler grace**。grace 内显式处理会让原始 `eval` 调用直接返回脚本结果；无人处理时原调用在 grace 到期返回 `pending`，其中的 `operationId` 可交给 `dialog accept|dismiss`，再用 `dialog result <operationId>` 取回原始 `eval` 结果。
- 不自动 accept/dismiss。`prompt` 的 `dialog accept "<text>"` 会把完全相同的文本传回页面。操作在服务端普通命令预算内仍未处理时，`dialog result <operationId>` 返回 `state: "operation"` 与 `_tag: "TimedOutOperation"`，并结构化给出 `phase`、`budget`、`sideEffects: "possible"`、`sessionId`、`operationId`、`dialogId` 和 Page 身份；随后仍可显式处理 modal，session 保持可用。
- 当前 Page 已有未处理 modal 时，后续命令在页面副作用前返回 `errorType: "command_failed"`、`cause: "dialog_pending"`，并在结构化字段中携带原 operation 的 `operationId`、`dialogId` 和 Page 身份 `page`；处理者应按这些身份调用 `dialog accept|dismiss`。
- `get text <selector>` preserves strict single-match behavior. Use
  `get text <selector> --all` for all matching elements in locator order or
  `--nth <index>` for one zero-based match; an unsupported legacy spelling
  returns a real error instead of a successful response without text.
- `get attr <selector> <name>` returns an ADT distinguishing
  `AttributeMissing` from `AttributePresent` with `value: ""`. `get box` and
  `get styles` return `NoLayout` for an unlaid-out element and preserve
  fractional `Box` coordinates and dimensions, including a real zero-sized
  box as a separate variant.
- `is visible` preserves Patchright's layout-visibility behavior. Its result
  includes `semantics: "layout"` and does not claim opacity-adjusted,
  perceptual, unobstructed, interactive, or click-safe visibility.
- `eval` returns raw scalar/object/array values after one serialization.
  `undefined` is an explicit `UndefinedValue` marker, distinct from an empty
  string, empty object, or void success. A non-`Error` throw uses
  `errorType: "command_failed"` with `cause: "cdp"` and a `ThrownValue`
  details object; the CLI summarizes its fields without reducing it to
  `Object`, and unknown detail tags remain opaque JSON.

- `moat --json --help`、`-h`、`help`、`--version` 与 `-V` 都返回单个 JSON 值。错误对象的 `errorType` 是机器判别字段，`error` 只用于展示。

机器错误分类使用结构化 `errorType`，而不是匹配 `error` 文案：

| `errorType` | 语义 |
|-------------|------|
| `unsupported_in_moat` | moat 架构不提供该命令 |
| `missing_arguments` | 必需参数缺失 |
| `invalid_value` | 参数值或形状非法 |
| `target_not_found` | 引用的 session、tab、frame 或元素目标不存在 |
| `command_failed` | 不属于上述类别的基础设施失败或前置拒绝，并带结构化 `cause` |
| `capacity_exceeded` | 会话准入配额已满，可在资源释放后重试 |
| `timeout` | 调用超过服务端预算；命令预算耗尽不代表结果可回滚 |

`command_failed` 的 `cause` 取值：

| `cause` | 语义 |
|---------|------|
| `container_creation` | session 容器或 profile 创建失败 |
| `cdp` | Controller 与浏览器 CDP 通道失败 |
| `cleanup` | session 或资源清理失败 |
| `transport` | CLI/Controller 网络传输失败 |
| `dialog_pending` | 当前 Page 的 modal 尚未处理；同时提供 `operationId`、`dialogId`、`page` 供处理者定位 |

Controller 对普通命令和清理使用默认 25s 服务端预算，`register` 使用 45s。等待命令可用显式 `--timeout <ms>` 覆盖预算，取值必须是整数 `1`–`120000`ms；省略时使用默认 25s。客户端 deadline 始终在服务端预算之外额外保留 5s，用于覆盖 WebSocket 建连、发送、接收和关闭的网络收尾，避免服务端刚耗尽预算时客户端先误报为 `command_failed`/transport。任一预算耗尽都返回 `errorType: "timeout"`，且不带 `cause`；调用方应把结果视为可能已经产生部分副作用，而不是自动重试。

### 9.3.1 远程 Chromium 环境模拟（C8）

`moat device list` 从远程 Chromium runtime 返回非空的 descriptor 名单。名单中的名称、viewport、screen、DPR、UA 和 touch 能力来自实际可用的 Patchright descriptor；把其中一个名称传给 `moat set device <name>`，不要依赖本机 Xcode 或 Appium 的设备列表。

```bash
moat device list
moat set device "iPhone 12"       # 名称以 device list 的实际输出为准
moat set viewport 390 664 3       # 第三个参数是 deviceScaleFactor
```

`set device` 通过同一组 CDP emulation 设置同时应用 descriptor 的 viewport、deviceScaleFactor、UA、UA metadata 和 touch 能力，不再在 CDP 后调用会重置 DPR 的 Playwright `setViewportSize()`。移动页面是否把 layout viewport 缩放到设备宽度仍由页面自己的 viewport meta 控制：没有该 meta 的页面按 Chromium 规范可能显示约 980 CSS 像素；声明 `width=device-width` 的页面才显示 descriptor 的 CSS 宽度。`fixture/device-meta.html` 是带有该声明、用于验证这两个读数的测试页面。

`set viewport <width> <height> [scale]` 同样使用 CDP metrics，`scale` 会作为页面可观察到的 `devicePixelRatio`。设置后的 device/viewport、headers、media 和 offline 状态属于当前 session：已有 tab 与之后创建的 tab 使用同一设置；新 session 从默认状态开始。`moat open --headers <json>` 是一次导航的显式 headers 覆盖，不会把该例外默默变成 session 设置。

`set offline` 只接受 `on`、`off`、`true`、`false`，大小写不敏感。未知 offline token、未知 device 名称和缺少必需参数会在改变浏览器状态前拒绝；机器调用应根据响应的 `errorType` 判别 `invalid_value` 或 `missing_arguments`，不要匹配展示文案。

### 9.4 State 与 cookie scope

`state save` 保存 cookies、origin 级 localStorage/IndexedDB，以及每个打开
tab 的 URL 与 sessionStorage。加载时必须先存在与保存记录匹配的页面；同一 URL
对应多个 tab 或缺少目标页面会返回 `status: "incomplete"`，不会猜测 tab
顺序。IndexedDB 或 sessionStorage 在候选浏览器不支持时返回
`status: "unsupported"`，不能用 `loaded: true` 冒充完整恢复；完整恢复才返回
`status: "complete"` 与 `loaded: true`。

state 文件寻址规则只有一套：

- 单段裸名（`alpha` 或 `alpha.json`）位于 `$HOME/.moat/states/`；
- 绝对路径或多段路径保持显式路径，不会自动加入默认目录；
- `state list` 只列默认命名空间，`state show/load` 可按裸名或显式路径读取；
- `state clear --all` 只管理默认目录内的直接 `.json` 文件。

`state clear --all` 是破坏性操作，必须显式传 `--confirm`（`--yes` 是同义
写法）；缺少确认会立即失败并返回 `errorType: "missing_arguments"`，不读取
stdin、不改文件。非 JSON 文件和显式路径始终不属于该集合。

Cookie 设置只能使用一种 scope：`--url <url>`，或
`--domain <domain>`/`--path <path>`。同时提供 URL 与 domain/path 会在任何
浏览器写入前返回 `errorType: "invalid_value"`；合法的 URL-only 与
domain/path-only 组合保留各自 scope。

### 9.5 C9 诊断与网络详情

- `moat console` 与 `moat errors` 的每条记录都带 `_tag` 类别、`sessionId`、稳定的 `pageId`/`frameId`、事件发生时的 `pageUrl`/`frameUrl` 和 Unix 毫秒 `timestamp`。`ResourceFailureDiagnostic` 表示资源加载失败（含 URL、资源类型和可用的 HTTP 状态或失败原因）；`PolicyBlockedDiagnostic` 表示 CSP/其他安全策略拦截（含被拦截 URL 和策略文本）。这些记录来自远程浏览器本身，不要求页面预先写诊断标记；跨导航和 iframe 记录不会改写成当前页面。
- `moat network request <id>` 的人类输出与 `--json` 使用同一份 Controller detail：URL、method、resource type、status、请求/响应 headers、请求 body，以及 response body 或明确的 `pending`/`absent`/其他 Controller 提供的完整性状态。人类模式不以 `✓ Done` 替代 detail，也不把缺失 body 当作成功正文。
- wire failure 的 `code` 是 Controller/SDK 内部编号；为保持 agent-browser 兼容的 `Response` JSON 形状，CLI 不暴露该字段，也不把它当作进程退出码。机器判别请使用 `errorType`（基础设施失败再读取 `cause`），错误文案只用于展示。

### 9.6 Wire 协议

CLI 和 Controller 之间的协议是 **agent-browser daemon JSON 命令格式 + session envelope**：

```json
{
  "sessionId": "abc123",
  "command": {
    "id": "r456",
    "action": "getbyrole",
    "role": "button",
    "subaction": "click",
    "name": "Submit",
    "exact": false
  }
}
```

`command` 字段的结构就是 agent-browser daemon 的 JSON 格式（见 fork 中 `cli/src/commands.rs` 的 `parse_command`）。两个 SDK（TS + Rust）负责编码这个结构，Controller 实现服务端解码。

响应也同样：

```json
{
  "sessionId": "abc123",
  "response": {
    "success": true,
    "data": { "url": "...", "title": "..." },
    "error": null,
    "_boundary": { "nonce": "...", "origin": "..." }
  }
}
```

### 9.7 Session 管理（moat 新增）

agent-browser 的 daemon 是本地进程，启动即绑定到本地 Chrome，不需要显式 session 管理。moat 因为容器在远程，必须显式管理 session 生命周期。Session 管理由 SDK 层实现，CLI 只是调用 SDK 的 session API：

```
moat connect  (CLI 命令)
    │
    └─ Rust SDK.connect()
         │
         └─ WebSocket → Controller
              │
              ├─ cp -a /data/profile → /data/profiles/<session-id>/
              ├─ docker create agent-chrome（挂载 profile 拷贝）
              ├─ 等待 CDP :9222 就绪
              └─ Patchright connectOverCDP
                   │
                   └─ 返回 session-id
                      │
                      └─ SDK 持有 session-id，CLI 写入 ~/.moat/session
```

后续命令：

```
moat find role button --name "Submit"
    │
    └─ CLI 读 ~/.moat/session → Rust SDK.command(sessionId, ...)
         │
         └─ WebSocket → Controller（带 sessionId）
              │
              └─ 查 Session Registry → 对应 agent-chrome → Patchright 执行
```

收尾（`disconnect`、`destroy`、`close-session`、`close` 共用此路径）：

```
moat disconnect
    │
    └─ Rust SDK.destroy()
         │
         └─ WebSocket → Controller
              │
              ├─ 以 owner + session 关联一次 cleanup
              ├─ 停止并删除该 owner 的容器
              └─ rm -rf 该 owner 的 profile 拷贝
                   │
                   ├─ 终态确认成功 → CLI 清除 ~/.moat/session，exit 0
                   └─ 失败/未知 → CLI 返回非零，保留 ~/.moat/session 供重试
```

**配置**：

```bash
# 单次调用覆盖 Controller，不写入配置或 session
moat --controller "ws://browser.mouriya.lan:3000" init --profile default

# 默认 Controller
export MOAT_CONTROLLER="ws://browser.mouriya.lan:3000"
export MOAT_PROFILE="default"

# 或 ~/.moat/config.json
{ "controller": "ws://browser.mouriya.lan:3000", "profile": "default" }

# 优先级：本次 --controller > 非空 MOAT_CONTROLLER > 配置文件 controller
```

### 9.8 增强（来自 opencli / CLI-Anything）

opencli 和 CLI-Anything 不是主设计参考，是**特定维度的增强借鉴**：

- **opencli 的 exit code 约定**：借 sysexits.h 习惯补齐 session 相关错误码（如 `NO_SESSION = 77`）。
- **CLI-Anything 的 SKILL.md 随包分发**：SKILL.md 文件打进包，装包即自动发现。

因为 SDK 是通用的 RPC 抽象，第三方可以基于 TS SDK 构建任意风格的 CLI 包装（opencli 风格、CLI-Anything 风格等），不需要碰 moat CLI 或 Rust SDK。

### 9.9 SKILL.md

`skills/moat/SKILL.md`，随包分发，Claude Code / Cursor 自动加载：

```markdown
---
name: moat
description: Control a remote Chromium browser via agent-browser CLI. Execute web automation using semantic locators (Playwright-style) first, snapshot as exploration fallback.
allowed-tools: Bash(moat:*)
---

# Interaction Model

moat inherits agent-browser's interaction model. The primary path is semantic
locators that map directly to Playwright's getByRole/getByLabel/getByText/etc.

## Rules

1. **Start any session with `moat connect`**. Without it, all commands fail with exit 77.
2. **Prefer semantic locators over snapshot**. Use `find role button --name "Submit"`,
   `find label "Email" fill "..."`, `find text "Login"` for 90% of interactions.
   These are cheap (~40 tokens) and map to Playwright's semantic API.
3. **Use `moat snapshot` only when**: the page is completely unfamiliar, or a
   semantic locator returned "element not found". Snapshot dumps the full ARIA
   tree (1000+ tokens), so it's an exploration tool, not a per-step observation.
4. **After snapshot, use `@eN` refs** to act on specific elements, then return to
   semantic locators for subsequent steps.
5. **Always `moat disconnect` when done** to free the container and profile copy.

## Primary commands (semantic locators)

moat find role <role> [--name <name>] [action]
moat find label <label> [action] [text]
moat find placeholder <text> [action] [text]
moat find text <text> [action]
moat find testid <id> [action] [text]

Actions: click (default), fill <text>, type <text>, hover, dblclick, focus, select <value>, check, uncheck

For repeated reads, use the getter-level selector options instead of relying
on a strict multi-match locator:

```bash
moat get text "a.column" --all
moat get text "a.column" --nth 0
```

`get text <selector>` is strict and requires exactly one matching element by
default. `--all` returns every text value in locator order as structured data;
`--nth <index>` reads one zero-based match. An out-of-range index is a real
`target_not_found` result, and an unsupported option is a real usage error
rather than a successful response with a missing value.

`get attr <selector> <name>` reports `attribute missing` for an absent
attribute and `""` for an explicitly present empty attribute. `get styles` and
`get box` preserve fractional geometry; an element with no layout has a
distinct no-layout variant rather than a fabricated zero-sized box.

For repeated interaction targets, use `find first`, `find last`, or `find nth`
to select one occurrence. These forms support `click`, `fill`, `type`, `hover`,
`dblclick`, `focus`, `select`, `check`, and `uncheck`; `fill ""` clears the
selected input. Unknown actions, missing values, and out-of-range occurrences
fail before page side effects.

`moat click <selector> --new-tab` opens a non-empty HTTP(S) link in a new
active tab and leaves the original tab unchanged. Elements without an openable
link are rejected before navigation.

`moat tab close [index]` rejects an attempt to close the last remaining tab
before closing the page. It returns `errorType: "invalid_value"` with the stable
message `Validation failed: Cannot close the last tab; at least one tab must remain open`;
the session and tab remain usable. Use `moat disconnect` (or `moat close`) to
destroy the whole session instead. If browser-side events leave no open pages,
a command sent in that state returns `errorType: "target_not_found"` for
`page`; it does not leak an engine error or expire the session.

`moat is visible <selector>` reports layout visibility only. It does not prove
opacity-adjusted or perceptual visibility, freedom from occlusion,
interactivity, or click safety; transparent and fully covered elements can be
`true`, while `visibility:hidden` and `display:none` are `false`.

`moat eval` preserves the JavaScript result type after one serialization:
numbers remain numbers, strings remain bare strings in human output, and
objects/arrays remain directly readable JSON values. `undefined` is an
explicit `UndefinedValue` variant in `--json` and prints as `undefined` in
human output; it is distinct from `""`, `{}`, and a void command result.

If an eval script throws a non-`Error` value, the response remains
`errorType: "command_failed"` with `cause: "cdp"` and includes a structured
`ThrownValue` detail. Human output summarizes scalars, arrays, and nested
objects (for example `code=42, detail=bad`); circular values, symbols,
functions, and DOM nodes are shown as present but not serializable. Unknown
detail tags remain visible as raw JSON.

Network routing accepts only `--abort` and `--body <json>`. Unsupported options

such as `--status`, `--delay`, and `--headers` are rejected before installation.

`keydown` and `keyup` are explicit paired low-level operations. High-level
`type`, `fill`, and `click` actions reject while a modifier is held; use `keyup`
to release it. Key-state results show the currently held modifiers.
## JavaScript dialogs

Dialogs are owned by the real Page that opened them. `dialog status`,
`dialog accept`, and `dialog dismiss` operate on the active Page and report
`pageId`, tab index, `dialogId`, type, message, and prompt default. A modal in
another tab remains independently visible until that Page is selected.

When `eval` opens a dialog, the Controller waits up to a 3s handler grace.
Explicit `accept`/`dismiss` during that grace lets the original eval command
return its script result. If the grace expires first, the eval returns a
pending `operationId`; resolve it with `dialog accept [text]` or
`dialog dismiss`, then retrieve the original result with
`dialog result <operationId>` if it was not included in the handler response.
If the operation reaches its command deadline first, `dialog result` returns
`state: "operation"` with a `TimedOutOperation` containing structured `phase`,
`budget`, `sideEffects`, `sessionId`, `operationId`, `dialogId`, and Page
identity fields. The modal remains explicitly handleable and the session stays
usable. No dialog is accepted or dismissed automatically. Prompt text is
passed to the page unchanged.

If another command reaches a Page while that Page still has the eval-triggered
modal, the command is rejected before page side effects with
`errorType: "command_failed"` and `cause: "dialog_pending"`. The response
includes the original `operationId`, `dialogId`, and `page` identity so the
caller can resolve the correct modal.

## Fallback commands (exploration)

moat snapshot                    — ARIA tree with @eN refs
moat click @eN                   — click by ref
moat fill @eN "text"             — fill by ref

## Other

moat connect / disconnect / status
moat open <url> / back / forward / reload
moat press <key>
moat screenshot [--output file]
moat eval "<js>"
moat batch                       — stdin: [[cmd, args...], ...]

## Exit codes

0=ok, 2=usage, 66=element not found, 69=controller down, 75=timeout,
77=no session, 78=config error
```

---

## 10. ADT 类型系统

### 10.1 Wire 协议：SDK 与 Controller 之间的单一契约

Wire 协议是整个系统的中心契约 —— 两个 SDK（TS + Rust）编码同一个 JSON schema，Controller 解码。命令 schema 对齐 agent-browser daemon 协议格式，加上 session envelope（agent-browser 没有，moat 新增）。

`packages/types` 是 wire 协议的 **canonical 定义**（TypeScript + arktype），Rust SDK 端需要保持等价的 schema。

Session envelope：

```typescript
type WireRequest = {
  readonly sessionId: string;
  readonly command: BrowserCommand;  // 对齐 agent-browser daemon JSON
};

type WireResponse = {
  readonly sessionId: string;
  readonly response: BrowserResponse;  // 对齐 agent-browser 响应 JSON
};
```

`BrowserCommand` / `BrowserResponse` 的字段结构对齐 agent-browser，通过 arktype schema 做运行时验证。TS SDK 和 Controller 直接使用这些类型，Rust SDK 维护等价的 Rust struct + serde 定义。

### 10.2 Controller 内部 ADT

Controller 的内部状态（session 状态机、容器生命周期）仍用本项目的 ADT 建模：

```typescript
type SessionState =
  | { readonly _tag: "Registering" }
  | { readonly _tag: "CreatingContainer"; readonly profileId: string }
  | { readonly _tag: "ConnectingCDP"; readonly containerId: string }
  | { readonly _tag: "Active"; readonly containerId: string; readonly cdpUrl: string }
  | { readonly _tag: "Reconnecting"; readonly since: number }
  | { readonly _tag: "Expired"; readonly reason: string };

type ControllerError =
  | { readonly _tag: "SessionNotFound"; readonly sessionId: string }
  | { readonly _tag: "SessionExpired"; readonly sessionId: string }
  | { readonly _tag: "ContainerCreateFailed"; readonly message: string }
  | { readonly _tag: "CdpUnreachable"; readonly containerId: string }
  | { readonly _tag: "ProfileCopyFailed"; readonly message: string }
  | {
      readonly _tag: "CapacityExceeded";
      readonly current: number;
      readonly limit: number;
      readonly owner: string;
      readonly ownerCurrent: number;
      readonly ownerLimit: number;
      readonly retryCondition: string;
    };
```

ControllerError 在序列化到 wire 时，映射到 agent-browser 响应的 `error` 字段 + 对应的 exit code。

### 10.3 设计约束

- 所有 ADT 字段使用 `readonly`
- 所有 `switch` 必须有 `default: exhaustive(x)` 兜底
- arktype 做运行时验证，TypeScript 类型做编译时检查
- 函数返回 `Result | Error` union，不 throw
- 不使用 `any`、`as` 类型断言（除非与第三方库交互必须）
- 命令/响应 schema 对齐 agent-browser，不重新发明；moat 只加 session envelope 和 Controller 内部 ADT
- `packages/types` 是 wire 协议的 canonical 定义，Rust SDK 保持等价 schema

---

## 11. 已知问题与决策记录

### 11.1 Debian Chromium CDP Session Bug

neko 官方镜像自带的 Debian Chromium 143 有 CDP `Target.setAutoAttach` 缺陷——session 创建后立即失效，所有 Playwright/Patchright/Puppeteer 均复现。Chrome for Testing 同版本号无此问题。

**影响**：agent-chrome 不能使用 neko 官方镜像的 Chromium，必须使用 Chrome for Testing。

**不影响**：user-chrome 的人类登录场景（不依赖 CDP session 的高级功能）。

### 11.2 容器内 Chromium 必须 --no-sandbox

Docker 容器内 zygote 沙箱需要特权，必须加 `--no-sandbox`，否则 `Operation not permitted`。

### 11.3 Profile 目录权限

Chromium 以 neko 用户 (uid 1000) 运行。profile 目录必须 `chown -R 1000:1000`，否则 `Permission denied`。

### 11.4 Patchright 版本匹配

Patchright 版本必须与 Chrome for Testing 版本匹配。Patchright 1.57.0 = Chrome 143.0.7499。版本不匹配会导致 CDP 协议不兼容。

### 11.5 Bun 需要 host CPU

Bun 在 qemu64 CPU 上会 hang。VM 必须使用 `cpu: host`。

### 11.6 Patchright/Playwright 与 Bun 的 CDP 兼容性

多次实操验证，Patchright（Playwright fork）在 Bun 运行时下连接 CDP 存在兼容性问题。Controller 是唯一直接调用 Patchright `connectOverCDP` 的组件，必须使用 Node.js 运行时。其余组件（types、shim、cli、e2e）不直接接触 CDP，继续使用 Bun。

---

## 12. 参考项目

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

### agent-browser（核心 upstream）

- 仓库：`github.com/vercel-labs/agent-browser`
- 许可：Apache-2.0
- 关系：**moat CLI 是这个项目的 fork**。保留命令词汇、语义定位器、`@eN` 引用、输出格式、exit code、batch 等全部代码。唯一实质修改是 transport 层：从本地 Unix socket 改为调用 Rust SDK（远程 WebSocket）。upstream 更新时可直接 merge，只有 transport 层会产生冲突。
- 技术：Rust 原生二进制 + 本地 daemon + Chrome for Testing + CDP 直连

### opencli（增强参考）

- 仓库：`github.com/jackwener/opencli`
- 许可：MIT
- 用途：**不是主设计**。特定维度借鉴：exit code 的 sysexits.h 约定（如 `NO_SESSION = 77`）。第三方可以基于 TS SDK 实现 opencli 风格的 CLI 包装。
- 技术：TypeScript + Node.js/Bun

### CLI-Anything（增强参考）

- 仓库：`github.com/HKUDS/CLI-Anything`
- 许可：MIT
- 用途：**不是主设计**。特定维度借鉴：SKILL.md 随包自动分发的做法。第三方可以基于 TS SDK 实现 CLI-Anything 风格的 CLI 包装。
- 技术：Python + Click

---

## 13. 项目结构

```
moat-browser/
├── cli/                # Rust workspace — fork 自 vercel-labs/agent-browser
│   ├── Cargo.toml      # Rust workspace root
│   ├── sdk/            # Rust SDK crate — RPC 客户端库（moat 新增）
│   │   ├── Cargo.toml
│   │   └── src/
│   │       └── lib.rs     # WebSocket 连接、session 管理、命令编解码
│   ├── src/            # CLI 二进制（fork 自 agent-browser）
│   │   ├── commands.rs    # 来自 upstream，保持同步
│   │   ├── connection.rs  # 唯一实质修改：transport 层改为调用 Rust SDK
│   │   ├── main.rs        # 加 connect/disconnect/status 命令
│   │   └── ...            # 其余文件保持 upstream 同步
│   └── UPSTREAM.md     # 记录与 upstream 的 diff、合并策略
├── packages/           # Bun workspace（TS/Node）
│   ├── types/          # Wire 协议 canonical 定义 + ADT + arktype schema
│   ├── sdk/            # TS SDK — RPC 客户端库
│   ├── controller/     # Node.js — wire 协议服务端
│   └── e2e/            # E2E 测试
├── images/
│   ├── user-chrome/    # User Chrome 镜像 (neko + Chromium)
│   └── agent-chrome/   # Agent Chrome 镜像 (Chrome for Testing + CDP)
├── skills/
│   └── moat/
│       └── SKILL.md    # Agent 可发现性文档，随包分发
├── README.md           # 设计文档
├── CLAUDE.md           # 无人值守开发指南
├── package.json
├── bunfig.toml
└── tsconfig.json
```

**关于 Rust + TS 混合**：`cli/` 是 fork 自 agent-browser 的 Rust workspace，不在 Bun workspace 里。`cli/sdk/` 是 moat 新增的 crate，封装 wire 协议客户端；CLI 二进制的 `connection.rs` 改为调用 SDK 而非本地 Unix socket，其余代码保持 upstream 同步。`packages/types` 是 wire 协议的 canonical 定义，Rust SDK 维护等价的 serde schema。

---

## 14. 交付路线图

| Phase | 内容 | 状态 |
|-------|------|------|
| 1 | Browser VM IaC (Terraform + Ansible) | ✅ 完成 |
| 2 | User Chrome Docker 镜像 (neko + Chromium) | ✅ 完成 |
| 3 | Agent Chrome Docker 镜像 (从零组装，Chrome for Testing + CDP) | ✅ 完成 |
| 4 | Wire 协议定义（`packages/types`：agent-browser daemon JSON + session envelope） | ✅ 完成 |
| 5 | TS SDK（`packages/sdk`：RPC 客户端库，实现 wire 协议） | Open |
| 6 | Controller 服务端实现（`packages/controller`：Node.js + Patchright，wire 协议服务端） | ✅ 完成 |
| 7 | Profile 管理（冻结/拷贝/快照） | ✅ 完成（cp-a 拷贝已在 Phase 6 中实现） |
| 8 | Rust SDK（`cli/sdk`：RPC 客户端库，WebSocket transport + session envelope） | ✅ 完成 |
| 9 | CLI fork（fork agent-browser，`connection.rs` 改为调用 Rust SDK，加 session 管理命令） | ✅ 完成（骨架，待填充 upstream 源码） |
| 10 | E2E 测试框架（覆盖 Rust CLI 和 TS SDK 两条路径） | ✅ 完成（TS Controller E2E，9 tests） |

---

## 15. 资源开销估算

| 容器 | 组件 | 内存 |
|------|------|------|
| user-chrome (人类登录态) | Xorg + openbox + Chromium + neko + GStreamer | ~550-750MB |
| user-chrome (空闲) | Xorg + openbox + Chromium + neko | ~450-550MB |
| agent-chrome | Xorg + openbox + Chrome for Testing | ~350-550MB |
| controller | Node.js + Patchright runtime | ~100-200MB |

每增加一个 Agent 实例 = 一个 agent-chrome 容器 ≈ 350-550MB。
