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
                           │ shell 命令
                           ▼
         ┌─────────────────────────────────────────────┐
         │                                             │
         │  moat CLI (Rust)          Shim SDK (TS)     │
         │  ← fork 自 agent-browser  ← 独立 TS 库       │
         │  ← 修改 transport 层      ← 程序化调用        │
         │  ← Agent 主入口           ← 第三方 CLI 基座    │
         │                                             │
         └───────────────────┬─────────────────────────┘
                             │ 相同 wire 协议
                             │ (agent-browser daemon JSON + session envelope)
                             ▼
                        WebSocket
                             │
              ┌──────────────▼──────────┐
              │       Controller        │
              │                         │
              │  WebSocket Server       │  ← 实现 agent-browser daemon 协议
              │  Session Registry       │  ← session → 容器映射
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
┌──────────────────┐                ┌──────────────────────────┐
│ moat CLI (Rust)  │   WebSocket    │ Controller (Node.js)     │
│ fork 自          │◄──────────────►│                          │
│ agent-browser    │  agent-browser │  实现 agent-browser       │
│                  │  daemon JSON   │  daemon 协议              │
│ $ moat find role │  + session     │                           │
│     button ...   │  envelope      │  Session Registry         │
│ $ moat find label│                │  → 定位 agent-chrome      │
│     "Email" fill │                │                           │
│ $ moat snapshot  │                │  Patchright               │
│ $ moat screenshot│                │    connectOverCDP(:9222)  │
│                  │                │    getByRole()            │
└──────────────────┘                │    getByLabel()           │
                                    │    click() / fill()       │
                                    │    ariaSnapshot()         │
                                    └──────────────┬───────────┘
                                                   │
                                         ┌─────────▼─────────┐
                                         │ agent-chrome       │
                                         │ Chrome for Testing │
                                         │ CDP :9222          │
                                         └───────────────────┘
```

命令完整路径：

1. Agent 在 shell 中执行 CLI 命令（如 `moat find role button --name "Submit"`）
2. moat CLI（fork 自 agent-browser）解析命令为 agent-browser daemon JSON 格式
3. fork 修改过的 transport 层通过 WebSocket 发送到远程 Controller（而非本地 Unix socket）
4. Controller 实现了 agent-browser daemon 协议的服务端，通过 Session Registry 定位对应 agent-chrome 容器
5. Controller 通过 Patchright `connectOverCDP("http://<container_ip>:9222")` 执行命令，语义定位器直接映射到 Playwright 的 `getByRole()` / `getByLabel()` 等
6. 结果以 agent-browser 相同的 JSON 格式回传 → CLI stdout → Agent

TypeScript 程序也可以绕过 CLI，直接用 Shim SDK（同样实现了客户端协议）调用 Controller。

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

## 8. Shim SDK 设计

### 8.1 定位：独立 TS 库，实现 wire 协议客户端

Shim SDK 是**独立的 TypeScript 库**，实现 Controller 的客户端协议（见 Section 9.4 的 wire 协议）。它和 moat CLI 是**两个并行的客户端实现**：

| 客户端 | 语言 | 消费者 | 来源 |
|--------|------|--------|------|
| moat CLI | Rust | Agent（shell 调用） | fork 自 agent-browser |
| Shim SDK | TypeScript | TS/JS 程序、第三方 CLI 包装 | 独立实现 |

两者说**完全相同的 wire 协议**（agent-browser daemon JSON + session envelope），连到同一个 Controller。CLI 不 wrap SDK，SDK 不 wrap CLI —— 它们是独立实现，共享协议规范。

这种双客户端的重复是刻意的：
- moat CLI 跟上游 agent-browser 的 Rust 代码演进，尽量保持最小 diff
- Shim SDK 服务 TS 生态 —— 其他团队想基于 opencli / CLI-Anything 风格做 CLI 包装，可以直接 import Shim SDK，不需要碰 Rust

### 8.2 API

```typescript
import { createSession } from "@moat-browser/shim";

const session = await createSession({
  controller: "ws://192.168.1.200:3000",
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

API 表面尽量跟 Playwright 的 locator API 对齐，因为 agent-browser 的语义定位器本来就是 Playwright 的封装。TS 消费者可以用熟悉的 `getByRole` / `getByLabel` 心智模型。

### 8.3 连接管理

- `createSession()`：发送 session 建立请求 → Controller 创建容器 + CDP → 返回 session 对象
- WebSocket 断连 → 5s 内自动重连 + session resume
- `disconnect()`：Controller 销毁容器 + 清理 profile 拷贝

### 8.4 Shim SDK 不负责的事

- **不做 CLI 壳**：CLI 是 Rust fork，不走 Shim SDK
- **不做 REPL**：Agent 不能用 REPL（见 Section 9.2 交互模型）
- **不做输出格式化**：SDK 返回结构化对象，格式化是 CLI 壳的职责
- **不做 exit code**：SDK 用异常和结果类型表达错误，exit code 是 CLI 壳的职责

---

## 9. CLI 设计

### 9.1 设计原则：fork agent-browser，只改 transport

moat CLI **不是**重新设计的工具，**不是**从三个项目挑 pattern 拼出来的。

moat CLI **是 agent-browser（`github.com/vercel-labs/agent-browser`）的 fork**，唯一实质修改是 transport 层：

- **保留**（从 agent-browser 不动的）：
  - 命令词汇：`open`、`click`、`fill`、`find role/label/text/placeholder/alt/title/testid`、`snapshot`、`screenshot`、`eval`、`wait`、`press`、`scroll`、`tab`、`batch`、`cookies` 等全部
  - 元素定位：Playwright 语义定位器（主）+ `@eN` 引用（辅）
  - 输出格式：text 模式 + `--json` 模式 + content boundary nonce
  - Exit code 体系
  - 配置文件合并规则（user > project > CLI flag）
- **修改**（只改这里）：
  - `cli/src/connection.rs`：从"Unix socket → 本地 daemon → 本地 Chrome"改为"WebSocket → 远程 Controller → 远程容器 Chrome"
  - 命令 JSON 加一层 session envelope（标识目标 session）
- **新增**：
  - `moat connect` / `moat disconnect` / `moat status`：session 生命周期管理（因为需要远程创建/销毁容器）

理由：
1. agent-browser 的设计已经被 Agent 实战验证，命令词汇 / 定位器 / 输出格式都是成熟方案，重新发明只会更差
2. Agent 迁移成本为零 —— 会用 agent-browser 的 Agent 直接能用 moat-browser
3. 可以持续跟上游迭代
4. 我们真正的独特价值是**把浏览器放到远程容器里**，其他都不是我们的创新空间

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

CLI 命令词汇完整继承自 agent-browser，详见上游文档：`github.com/vercel-labs/agent-browser`。本文档不重复列表，只列出 moat-browser **新增**或**行为有差异**的命令。

**新增命令**（session 生命周期，因为远程容器需要显式管理）：

| 命令 | 说明 |
|------|------|
| `moat connect [--profile <name>]` | 建立 session：Controller 拷贝 profile、创建 agent-chrome 容器、等待 CDP 就绪。session ID 写入 `~/.moat/session` |
| `moat disconnect` | 销毁 session：Controller 停止并删除容器、清理 profile 拷贝。清除 `~/.moat/session` |
| `moat status` | 查询当前 session：容器 IP、CDP 端口、profile 名称、存活时长 |

**行为差异命令**：

| 命令 | 上游行为 | moat 行为 |
|------|---------|----------|
| （所有命令） | 隐式自动启动本地 daemon + 本地 Chrome | 需要先 `moat connect`，返回 exit 77 如未连接 |

### 9.4 Wire 协议

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

`command` 字段的结构完全等同于 agent-browser daemon 收到的 JSON（见 `cli/src/commands.rs` 的 `parse_command` 和 `cli/src/connection.rs` 的 `send_command`）。Controller 实现这个协议的服务端即可。

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

### 9.5 Session 管理（moat 新增）

agent-browser 的 daemon 是本地进程，启动即绑定到本地 Chrome，不需要显式 session 管理。moat 因为容器在远程，必须显式管理 session 生命周期：

```
moat connect
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
                 └─ CLI 写入 ~/.moat/session
```

后续命令：

```
moat find role button --name "Submit"
    │
    └─ 读 ~/.moat/session 拿 session-id
         │
         └─ WebSocket → Controller（带 sessionId）
              │
              └─ 查 Session Registry → 对应 agent-chrome → Patchright 执行
```

收尾：

```
moat disconnect
    │
    └─ WebSocket → Controller
         │
         ├─ 停止并删除容器
         └─ rm -rf /data/profiles/<session-id>/
            │
            └─ CLI 清除 ~/.moat/session
```

**配置**：

```bash
export MOAT_CONTROLLER="ws://192.168.1.200:3000"
export MOAT_PROFILE="default"

# 或 ~/.moat/config.json
{ "controller": "ws://192.168.1.200:3000", "profile": "default" }

# 优先级：CLI flag > 环境变量 > 配置文件
```

### 9.6 增强（来自 opencli / CLI-Anything）

opencli 和 CLI-Anything 不是主设计参考，是**特定维度的增强借鉴**：

- **opencli 的 exit code 约定**：如果 agent-browser 上游没有覆盖某些场景（如 `NO_SESSION = 77`），借 opencli 的 sysexits.h 习惯补齐。
- **CLI-Anything 的 SKILL.md 随包分发**：SKILL.md 文件打进 npm 包，装包即自动发现，不需要额外配置。

第三方（或后续）要做 opencli 风格、CLI-Anything 风格、或任何其他 CLI 包装，直接基于 Shim SDK 实现客户端即可，不需要改 moat CLI。

### 9.7 SKILL.md

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

Actions: click (default), fill <text>, type <text>, check, uncheck, hover

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

### 10.1 Wire 协议命令 schema 对齐 agent-browser

CLI ↔ Controller 之间传输的**命令 schema 不是本项目发明的**，而是 agent-browser daemon 协议的 JSON 格式（见上游 `cli/src/commands.rs` 的 `parse_command`）。本项目的 `packages/types` 只做两件事：

1. **定义 session envelope**（agent-browser 没有，moat 新增，因为多容器多 session）
2. **用 arktype 给 upstream 命令 schema 做运行时验证**（TypeScript 侧解码 Rust CLI 发来的 JSON 时用）

Session envelope：

```typescript
type WireRequest = {
  readonly sessionId: string;
  readonly command: UpstreamCommand;  // agent-browser 的命令 JSON（任何 action）
};

type WireResponse = {
  readonly sessionId: string;
  readonly response: UpstreamResponse;  // agent-browser 的响应 JSON
};
```

`UpstreamCommand` / `UpstreamResponse` 的字段结构跟着上游走，通过 arktype schema 表达，用于 Controller 端解析和 Shim SDK 构造。不重新发明 `BrowserCommand` / `BrowserResult` ADT。

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
  | { readonly _tag: "ProfileCopyFailed"; readonly message: string };
```

ControllerError 在序列化到 wire 时，映射到 agent-browser 响应的 `error` 字段 + 对应的 exit code。

### 10.3 设计约束

- 所有 ADT 字段使用 `readonly`
- 所有 `switch` 必须有 `default: exhaustive(x)` 兜底
- arktype 做运行时验证，TypeScript 类型做编译时检查
- 函数返回 `Result | Error` union，不 throw
- 不使用 `any`、`as` 类型断言（除非与第三方库交互必须）
- **不重新发明 agent-browser 的命令/响应 schema**，只加 session envelope 和 Controller 内部 ADT

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
- 关系：**moat CLI 是这个项目的 fork**。保留命令词汇、语义定位器、`@eN` 引用、输出格式、exit code、batch 等全部设计，唯一实质修改是 `cli/src/connection.rs` 的 transport 层（本地 Unix socket → 远程 WebSocket）。Controller 实现它 daemon 协议的服务端。
- 技术：Rust 原生二进制 + 本地 daemon + Chrome for Testing + CDP 直连

### opencli（增强参考）

- 仓库：`github.com/jackwener/opencli`
- 许可：MIT
- 用途：**不是主设计**。特定维度借鉴：exit code 的 sysexits.h 约定（用于 moat 新增的 session 相关错误码，如 `NO_SESSION = 77`）。第三方可以基于 Shim SDK 实现 opencli 风格的 CLI 包装。
- 技术：TypeScript + Node.js/Bun

### CLI-Anything（增强参考）

- 仓库：`github.com/HKUDS/CLI-Anything`
- 许可：MIT
- 用途：**不是主设计**。特定维度借鉴：SKILL.md 随 npm 包自动分发的做法（`skills/moat/SKILL.md` 打进包里，Claude Code / Cursor 装包即自动发现）。第三方可以基于 Shim SDK 实现 CLI-Anything 风格的 CLI 包装。
- 技术：Python + Click

---

## 13. 项目结构

```
moat-browser/
├── cli/                # Rust crate — fork 自 vercel-labs/agent-browser
│   ├── Cargo.toml      # (其他 TS 包是 Bun workspace，这里是独立 Rust crate)
│   ├── src/
│   │   ├── commands.rs    # 来自 upstream，不修改
│   │   ├── connection.rs  # 唯一实质修改：本地 Unix socket → 远程 WebSocket
│   │   ├── main.rs        # 加 session 管理命令（connect/disconnect/status）
│   │   └── ...            # 其余文件保持 upstream 同步
│   └── UPSTREAM.md     # 记录与 upstream 的 diff、合并策略
├── packages/           # Bun workspace（TS/Node）
│   ├── types/          # 共享 ADT 类型 + arktype schema + wire 协议定义
│   ├── controller/     # Node.js —— 实现 agent-browser daemon 协议服务端
│   ├── shim/           # TS SDK —— 独立客户端，供 TS 程序和第三方 CLI 包装使用
│   └── e2e/            # E2E 测试
├── images/
│   ├── user-chrome/    # User Chrome 镜像 (neko + Chromium)
│   └── agent-chrome/   # Agent Chrome 镜像 (Chrome for Testing + CDP)
├── skills/
│   └── moat/
│       └── SKILL.md    # Agent 可发现性文档，随 CLI 包分发
├── README.md           # 设计文档
├── CLAUDE.md           # 无人值守开发指南
├── package.json
├── bunfig.toml
└── tsconfig.json
```

**关于 Rust + TS 混合**：`cli/` 是独立 Rust crate，不在 Bun workspace 里。构建和测试各自独立。理由：fork 自 Rust upstream，强行改语言会丢失跟上游合并的能力。

---

## 14. 交付路线图

| Phase | 内容 | 状态 |
|-------|------|------|
| 1 | Browser VM IaC (Terraform + Ansible) | ✅ 完成 |
| 2 | User Chrome Docker 镜像 (neko + Chromium) | Open |
| 3 | Agent Chrome Docker 镜像 (从零组装，Chrome for Testing + CDP) | Open |
| 4 | Wire 协议定义（agent-browser daemon JSON + session envelope）+ Controller 服务端实现（Node.js + Patchright） | Open |
| 5 | Profile 管理（冻结/拷贝/快照） | Open |
| 6 | CLI fork：fork `vercel-labs/agent-browser`，修改 `connection.rs` 走 WebSocket，加 `connect`/`disconnect`/`status` 命令，打包 SKILL.md | Open |
| 7 | Shim SDK（独立 TS 库实现同 wire 协议，供 TS 程序和第三方 CLI 包装使用） | Open |
| 8 | E2E 测试框架（覆盖 CLI 和 Shim SDK 两条路径） | Open |

---

## 15. 资源开销估算

| 容器 | 组件 | 内存 |
|------|------|------|
| user-chrome (人类登录态) | Xorg + openbox + Chromium + neko + GStreamer | ~550-750MB |
| user-chrome (空闲) | Xorg + openbox + Chromium + neko | ~450-550MB |
| agent-chrome | Xorg + openbox + Chrome for Testing | ~350-550MB |
| controller | Node.js + Patchright runtime | ~100-200MB |

每增加一个 Agent 实例 = 一个 agent-chrome 容器 ≈ 350-550MB。
