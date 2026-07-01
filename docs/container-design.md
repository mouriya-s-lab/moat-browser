# 容器设计：user-chrome & agent-chrome

本文档是 `images/user-chrome/` 和 `images/agent-chrome/` 两个 Docker 镜像的设计规格。覆盖基础镜像选择、进程编排、端口暴露、Profile 持久化、容器间协作，以及最终的 docker-compose 编排。

---

## 1. user-chrome

### 1.1 定位

人类通过 neko WebRTC 远程桌面登录 SaaS 系统。常驻运行，是 Profile 的源头。

### 1.2 基础镜像

```
ghcr.io/m1k1o/neko/chromium:latest
```

neko v3 官方 Chromium 镜像。自带完整功能栈，不需要从零组装：

| 组件 | 来自 neko 镜像 |
|------|---------------|
| Xorg + xserver-xorg-video-dummy | 无头 X11 显示 |
| openbox | 窗口管理 |
| GStreamer (ximagesrc + VP8/H264) | 屏幕捕获 + 视频编码 |
| pion WebRTC (Go) | P2P 低延迟流传输 |
| X11 C 绑定 (libXtst) | 鼠标/键盘输入注入 |
| PulseAudio | 音频（登录场景可选） |
| supervisord | 进程编排 |
| neko server (Go 单二进制) | HTTP + WebSocket + WebRTC 信令 |
| Vue.js 客户端 | 浏览器内 WebRTC 播放器 |
| Debian Chromium | 浏览器（人类登录够用，不需要 CDP） |

### 1.3 为什么直接用官方镜像

人类登录场景不依赖 CDP session 高级功能（`Target.setAutoAttach` 等）。Debian Chromium 143 的 CDP session bug（见 README §11.1）**不影响** user-chrome，因为 user-chrome 只做人类交互（WebRTC 桌面流），不做程序化浏览器操控。

自定义 Dockerfile 只做两件事：
1. 挂载 profile 目录卷
2. 注入 Chromium policy 文件（启用 cookie 持久化）

### 1.4 Dockerfile

```dockerfile
FROM ghcr.io/m1k1o/neko/chromium:latest

# Chromium policy: 启用 cookie 持久化 + 会话恢复
COPY policies.json /etc/chromium/policies/managed/policies.json
```

`policies.json`:

```json
{
  "DefaultCookiesSetting": 1,
  "RestoreOnStartup": 1,
  "BlockThirdPartyCookies": false
}
```

这让 Chromium 在容器重启后保留登录状态（前提是 profile 目录通过卷挂载持久化）。

### 1.5 进程编排

由 neko 镜像内置的 supervisord 管理，不需要自定义。启动顺序：

```
supervisord (PID 1, nodaemon)
├── dbus            → 系统消息总线
├── Xorg            → 无头 X11 (dummy driver)
├── openbox         → 窗口管理
├── PulseAudio      → 音频
├── Chromium        → --no-sandbox
└── neko server     → HTTP :8080 + WebRTC 信令
```

### 1.6 端口

| 端口 | 协议 | 用途 |
|------|------|------|
| 8080 | TCP | neko Web UI + WebSocket 信令 |
| 52000-52100 | UDP | WebRTC 媒体流（ICE candidates） |

**WebRTC 端口约束**：UDP 端口必须 1:1 映射（不能 remap），这是 WebRTC ICE 的固有限制。

### 1.7 卷挂载

| 容器路径 | 宿主路径 | 用途 |
|---------|---------|------|
| `/home/neko/.config/chromium` | `/data/profile` | Chromium profile 持久化（Cookie、localStorage、Session） |

neko 容器内以 `neko` 用户 (UID 1000) 运行 Chromium。宿主目录必须：

```bash
chown -R 1000:1000 /data/profile
```

### 1.8 环境变量

| 变量 | 值 | 说明 |
|------|-----|------|
| `NEKO_DESKTOP_SCREEN` | `1920x1080@30` | 分辨率 + 帧率 |
| `NEKO_MEMBER_MULTIUSER_USER_PASSWORD` | `<user-pw>` | 普通用户密码 |
| `NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD` | `<admin-pw>` | 管理员密码（可控制键鼠） |
| `NEKO_WEBRTC_EPR` | `52000-52100` | WebRTC 端口范围 |
| `NEKO_WEBRTC_ICELITE` | `1` | 轻量 ICE agent（同 LAN 无需 STUN/TURN） |
| `NEKO_WEBRTC_NAT1TO1` | `192.168.1.211` | VM 外部 IP（用于 ICE candidate） |

### 1.9 关键约束

| 约束 | 原因 |
|------|------|
| `shm_size: 2gb` | Chromium 使用 /dev/shm 做进程间通信，Docker 默认 64MB 会导致崩溃 |
| `cap_add: SYS_ADMIN` | Chromium sandbox 需要（neko 镜像内 Chromium 已带 `--no-sandbox`，但 SYS_ADMIN 仍推荐） |

---

## 2. agent-chrome

### 2.1 定位

纯浏览器环境，供 Controller 通过 Patchright `connectOverCDP` 操控。按需创建/销毁，每个 Agent session 一个实例。

### 2.2 为什么不用 neko 镜像

两个原因：

1. **CDP session bug**：Debian Chromium 143 的 `Target.setAutoAttach` 创建的 session 立即失效，Playwright/Patchright/Puppeteer 的 `connectOverCDP` 完全不工作。必须使用 Chrome for Testing（同版本号无此问题）。

2. **不需要 neko 功能栈**：agent-chrome 不需要 WebRTC、GStreamer、输入注入、Vue.js 客户端。这些组件只会浪费内存和增加攻击面。

### 2.3 基础镜像

```
debian:bookworm-slim
```

从干净 Debian base 组装，只装必要组件。

### 2.4 组件清单

| 组件 | 来源 | 说明 |
|------|------|------|
| Xorg + xserver-xorg-video-dummy | Debian 包，xorg.conf 参考 neko | 无头 X11 显示（Chrome for Testing 需要） |
| openbox | Debian 包 | 轻量窗口管理 |
| Chrome for Testing | Playwright CDN | 替代 Debian Chromium，CDP 实现正确 |
| supervisord | Debian 包 | 进程编排 |
| fonts-liberation + fonts-noto-cjk | Debian 包 | 西文 + 中日韩字体 |

**不需要**：neko server、GStreamer、WebRTC、PulseAudio、libXtst 输入注入、dbus。

### 2.5 Chrome for Testing 安装

从 Playwright CDN 下载，与 Patchright 版本匹配（见 README §11.4）：

```dockerfile
# Patchright 1.57.0 = Chrome 143.0.7499
ARG CHROME_VERSION=143.0.7499.0

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates unzip \
    # X11 依赖
    xserver-xorg-video-dummy xserver-xorg-core xinit \
    # 窗口管理
    openbox \
    # Chrome 依赖库
    libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 \
    libxss1 libxtst6 libnss3 libnspr4 libatk1.0-0 \
    libatk-bridge2.0-0 libcups2 libdrm2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libdbus-1-3 \
    # 字体
    fonts-liberation fonts-noto-cjk \
    # 进程管理
    supervisor \
    && rm -rf /var/lib/apt/lists/*

# 下载 Chrome for Testing
RUN curl -fsSL "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/linux64/chrome-linux64.zip" \
    -o /tmp/chrome.zip \
    && unzip /tmp/chrome.zip -d /opt/ \
    && mv /opt/chrome-linux64 /opt/chrome \
    && rm /tmp/chrome.zip \
    && ln -s /opt/chrome/chrome /usr/local/bin/chrome
```

### 2.6 非 root 用户

与 neko 保持一致，使用 UID 1000：

```dockerfile
RUN groupadd -g 1000 chrome \
    && useradd -m -u 1000 -g chrome chrome
```

Profile 目录由 Controller 在创建容器时从 user-chrome 拷贝并 `chown -R 1000:1000`。

### 2.7 Xorg 配置

参考 neko 的 xorg.conf，最小化配置：

`xorg.conf`:

```
Section "Device"
    Identifier  "dummy"
    Driver      "dummy"
    VideoRam    256000
EndSection

Section "Screen"
    Identifier  "screen"
    Device      "dummy"
    Monitor     "monitor"
    DefaultDepth 24
    SubSection "Display"
        Depth   24
        Modes   "1920x1080"
    EndSubSection
EndSection

Section "Monitor"
    Identifier  "monitor"
    HorizSync   1-100
    VertRefresh 1-100
EndSection
```

### 2.8 Chrome 启动参数

```bash
chrome \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --remote-debugging-address=0.0.0.0 \
  --remote-debugging-port=9222 \
  --user-data-dir=/data/profile \
  --window-size=1920,1080 \
  --no-first-run \
  --no-default-browser-check \
  --disable-translate \
  --disable-blink-features=AutomationControlled \
  --disable-infobars
```

参数说明：

| 参数 | 原因 |
|------|------|
| `--no-sandbox` | Docker 容器内 zygote 沙箱需要特权（见 README §11.2） |
| `--disable-gpu` | 容器内无 GPU |
| `--disable-dev-shm-usage` | 使用 /tmp 替代 /dev/shm，避免 64MB 限制 |
| `--remote-debugging-address=0.0.0.0` | 允许 Controller 从容器外连接 CDP |
| `--remote-debugging-port=9222` | CDP 端口 |
| `--user-data-dir=/data/profile` | 从 user-chrome 拷贝来的 profile |
| `--no-first-run` | 跳过首次运行向导 |
| `--disable-blink-features=AutomationControlled` | 隐藏 `navigator.webdriver=true`（Patchright 额外加固） |
| `--disable-infobars` | 移除 "Chrome is being controlled" 提示条 |

### 2.9 supervisord 配置

`supervisord.conf`:

```ini
[supervisord]
nodaemon=true
logfile=/var/log/supervisord.log
pidfile=/var/run/supervisord.pid
user=root

[program:xorg]
command=/usr/bin/Xorg :0 -config /etc/X11/xorg.conf
autorestart=true
priority=100
user=root

[program:openbox]
command=/usr/bin/openbox
environment=DISPLAY=":0"
autorestart=true
priority=200
user=chrome

[program:chrome]
command=/usr/local/bin/chrome
    --no-sandbox
    --disable-gpu
    --disable-dev-shm-usage
    --remote-debugging-address=0.0.0.0
    --remote-debugging-port=9222
    --user-data-dir=/data/profile
    --window-size=1920,1080
    --no-first-run
    --no-default-browser-check
    --disable-translate
    --disable-blink-features=AutomationControlled
    --disable-infobars
environment=DISPLAY=":0",HOME="/home/chrome"
autorestart=true
priority=300
user=chrome
```

启动顺序：Xorg (100) → openbox (200) → Chrome (300)。

### 2.10 端口

| 端口 | 协议 | 用途 |
|------|------|------|
| 9222 | TCP | Chrome DevTools Protocol |

不对宿主暴露。Controller 通过 Docker 内部网络直接访问容器 IP:9222。

### 2.11 卷挂载

| 容器路径 | 宿主路径 | 用途 |
|---------|---------|------|
| `/data/profile` | `/data/profiles/agent-<session-id>` | 从 user-chrome 拷贝来的 profile |

由 Controller 在创建容器前准备：

```bash
cp -a /data/profile /data/profiles/agent-<session-id>
chown -R 1000:1000 /data/profiles/agent-<session-id>
```

### 2.12 CDP 就绪检测

Controller 创建容器后，需要轮询 CDP 端口直到就绪：

```
GET http://<container-ip>:9222/json/version
```

返回 200 + JSON（含 `webSocketDebuggerUrl`）即表示 Chrome 已启动并可通过 CDP 操控。Controller 随后调用：

```typescript
patchright.chromium.connectOverCDP(`http://<container-ip>:9222`)
```

### 2.13 完整 Dockerfile

```dockerfile
FROM debian:bookworm-slim

ARG CHROME_VERSION=143.0.7499.0

# 系统依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates unzip \
    xserver-xorg-video-dummy xserver-xorg-core xinit \
    openbox \
    libx11-xcb1 libxcomposite1 libxdamage1 libxrandr2 \
    libxss1 libxtst6 libnss3 libnspr4 libatk1.0-0 \
    libatk-bridge2.0-0 libcups2 libdrm2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libdbus-1-3 \
    fonts-liberation fonts-noto-cjk \
    supervisor \
    && rm -rf /var/lib/apt/lists/*

# Chrome for Testing
RUN curl -fsSL "https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/linux64/chrome-linux64.zip" \
    -o /tmp/chrome.zip \
    && unzip /tmp/chrome.zip -d /opt/ \
    && mv /opt/chrome-linux64 /opt/chrome \
    && rm /tmp/chrome.zip \
    && ln -s /opt/chrome/chrome /usr/local/bin/chrome

# 非 root 用户 (UID 1000，与 neko 一致)
RUN groupadd -g 1000 chrome \
    && useradd -m -u 1000 -g chrome chrome

# Profile 挂载点
RUN mkdir -p /data/profile && chown chrome:chrome /data/profile

# 配置文件
COPY xorg.conf /etc/X11/xorg.conf
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf

EXPOSE 9222

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
```

---

## 3. 容器间协作

### 3.1 Profile 流转

```
user-chrome                       Controller                    agent-chrome
/home/neko/.config/chromium/   →  cp -a → /data/profiles/       → /data/profile/
(宿主: /data/profile)             agent-<id>/                    (容器挂载)
```

详细流程：

1. 人类通过 neko 登录 SaaS → Cookie/Session 写入 user-chrome 的 `/home/neko/.config/chromium/`
2. user-chrome 挂载 `/data/profile` 到宿主，宿主持有完整 profile
3. Agent 请求 `connect` → Controller 执行：
   ```bash
   cp -a /data/profile /data/profiles/agent-<session-id>
   chown -R 1000:1000 /data/profiles/agent-<session-id>
   ```
4. Controller 通过 Docker Engine API 创建 agent-chrome 容器，挂载拷贝
5. Agent 请求 `disconnect` → Controller 停止并删除容器 + `rm -rf /data/profiles/agent-<session-id>`

### 3.2 Profile 路径映射

| 容器 | 容器内路径 | 宿主路径 |
|------|-----------|---------|
| user-chrome | `/home/neko/.config/chromium` | `/data/profile` |
| agent-chrome #1 | `/data/profile` | `/data/profiles/agent-abc123` |
| agent-chrome #2 | `/data/profile` | `/data/profiles/agent-def456` |

user-chrome 容器内 Chromium 以 neko 用户运行，profile 默认在 `/home/neko/.config/chromium`。通过卷挂载，这个路径映射到宿主的 `/data/profile`。

agent-chrome 使用 `--user-data-dir=/data/profile`，容器内路径统一。每个实例挂载各自的宿主目录（拷贝份）。

### 3.3 网络模型

所有容器在同一个 Docker bridge 网络中：

```
                  docker network: moat
                         │
        ┌────────────────┼────────────────┐
        │                │                │
  user-chrome      agent-chrome #1   agent-chrome #2
  172.18.0.2       172.18.0.3        172.18.0.4
  :8080 (neko)     :9222 (CDP)       :9222 (CDP)
```

- Controller 运行在宿主（或另一个容器），通过 Docker 网络访问 agent-chrome 的 CDP 端口
- agent-chrome 的 9222 端口**不对宿主暴露**，只在 Docker 网络内可达
- user-chrome 的 8080 端口**对宿主暴露**（用户浏览器需要直接访问）
- user-chrome 的 52000-52100 UDP 端口**对宿主暴露**（WebRTC 媒体流）

### 3.4 Controller 容器管理 API 调用

Controller 通过 Docker Engine API（fetch + Unix socket）管理 agent-chrome：

**创建容器**：
```
POST /containers/create
{
  "Image": "agent-chrome:latest",
  "ExposedPorts": { "9222/tcp": {} },
  "HostConfig": {
    "Binds": ["/data/profiles/agent-<id>:/data/profile"],
    "NetworkMode": "moat",
    "ShmSize": 2147483648
  }
}
```

**启动容器**：
```
POST /containers/<id>/start
```

**获取容器 IP**：
```
GET /containers/<id>/json
→ .NetworkSettings.Networks.moat.IPAddress
```

**停止 + 删除**：
```
POST /containers/<id>/stop
DELETE /containers/<id>
```

### 3.5 docker-compose（开发/E2E 环境）

```yaml
services:
  user-chrome:
    build: ./images/user-chrome
    shm_size: "2gb"
    cap_add:
      - SYS_ADMIN
    ports:
      - "8080:8080"
      - "52000-52100:52000-52100/udp"
    volumes:
      - profile-data:/home/neko/.config/chromium
    environment:
      NEKO_DESKTOP_SCREEN: "1920x1080@30"
      NEKO_MEMBER_MULTIUSER_USER_PASSWORD: neko
      NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD: admin
      NEKO_WEBRTC_EPR: "52000-52100"
      NEKO_WEBRTC_ICELITE: "1"
      NEKO_WEBRTC_NAT1TO1: "192.168.1.211"
    networks:
      - moat

  controller:
    build: ./packages/controller
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - profile-data:/data/profile:ro
      - profiles-work:/data/profiles
    ports:
      - "3000:3000"
    environment:
      PROFILE_SOURCE: /data/profile
      PROFILES_WORK: /data/profiles
      DOCKER_NETWORK: moat
      AGENT_CHROME_IMAGE: agent-chrome:latest
    depends_on:
      - user-chrome
    networks:
      - moat

networks:
  moat:
    driver: bridge

volumes:
  profile-data:
  profiles-work:
```

注意：
- agent-chrome **不在 compose 中定义**。它由 Controller 通过 Docker Engine API 动态创建/销毁
- Controller 需要挂载 Docker socket 来管理容器
- `profile-data` 卷同时挂载到 user-chrome（读写）和 Controller（只读，用于 `cp -a` 源）
- `profiles-work` 是 Controller 创建 agent-chrome profile 拷贝的工作目录

### 3.6 生命周期总览

```
                    常驻                              按需
              ┌─────────────┐                  ┌─────────────┐
              │ user-chrome │                  │ agent-chrome │
              │             │                  │   ×N 个实例   │
              │ 人类登录 SaaS │                  │              │
              │ profile 写入 │                  │ profile 拷贝  │
              │             │                  │ CDP :9222    │
              └──────┬──────┘                  └──────┬──────┘
                     │                                │
                     │   /data/profile (源)            │  /data/profiles/agent-<id> (拷贝)
                     │                                │
              ┌──────▼────────────────────────────────▼──────┐
              │                 Controller                    │
              │                                              │
              │  1. cp -a profile → profiles/agent-<id>      │
              │  2. docker create agent-chrome (挂载拷贝)     │
              │  3. 轮询 CDP :9222/json/version              │
              │  4. Patchright connectOverCDP                 │
              │  5. 执行命令 → 返回结果                        │
              │  6. disconnect → stop + rm 容器 + rm profile  │
              └──────────────────────────────────────────────┘
```

---

## 4. 已知约束汇总

| 约束 | 影响范围 | 说明 |
|------|---------|------|
| Debian Chromium CDP bug | agent-chrome | 必须用 Chrome for Testing（README §11.1） |
| `--no-sandbox` | 两者 | 容器内 zygote 沙箱不可用（README §11.2） |
| UID 1000 | 两者 | profile 目录 `chown -R 1000:1000`（README §11.3） |
| Patchright 版本匹配 | agent-chrome | Chrome for Testing 版本必须与 Patchright 匹配（README §11.4） |
| shm_size | 两者 | Chromium 需要 ≥ 2GB /dev/shm（或 `--disable-dev-shm-usage`） |
| WebRTC 端口 1:1 映射 | user-chrome | UDP 端口不能 remap |
