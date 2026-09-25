# CLAUDE.md — moat-browser

## Project Context

- **Project**: moat-browser — 企业级浏览器 RPC 系统。AI Agent 通过 CDP 操作远程 Chromium，用户通过 neko WebRTC 完成 SaaS 登录
- **This repo's role**: 应用代码（SDK + Controller + CLI + Docker 镜像 + E2E 测试）
- **Design doc**: `README.md`
- **Core idea**: 有状态登录 + 无状态执行。人类负责登录（neko WebRTC），Agent 负责执行（Patchright CDP），Profile 在中间桥接
- **SDK 策略**: SDK 是 RPC 抽象层，TS 和 Rust 各一个实现，共享同一 wire 协议。CLI 是 agent-browser 的 fork，transport 层改为调用 Rust SDK（而非本地 Unix socket），其余保持 upstream 同步

## Related Repos

| Repo | Role | Relationship |
|---|---|---|
| homelab-tf (`~/work/homelab-tf`) | IaC (OpenTofu + Ansible + Komodo) | Browser VM 104 (`browser.hb.lan`, 192.168.1.221) 的 Komodo Stack 与 CI/CD 部署入口 |

## Issues

- Tracked in: `moat-lab/moat-browser`（`Mouriya-Emma/moat-browser` 是 transfer 前的旧名，仅靠 GitHub redirect 可达，不要再用）
- 当前 open 树：umbrella #237（dogfood 审计 51 项交互可信度缺陷）+ child #238–#252；umbrella #224 + child #225–#228（CLI 与 upstream 对齐）

## Tech Stack

- **Rust SDK + CLI**: Rust workspace（`cli/sdk` + CLI fork），不在 Bun workspace 里
- **Controller**: Node.js + TypeScript（Patchright 与 Bun 有 CDP 兼容性问题）
- **TS SDK / types / e2e**: Bun + TypeScript
- **Wire 协议**: agent-browser daemon JSON + session envelope（详见 README Section 10.1）
- **WebSocket**: 原生 ws（不用 socket.io）
- **Browser automation**: patchright（反检测 Playwright fork）
- **Runtime validation**: arktype
- **Container management**: Docker Engine API via fetch + Unix socket（不用 dockerode）
- **Type system**: discriminated union ADT (`_tag` field) + exhaustive switch

## Directory Structure

```
moat-browser/
├── cli/                # Rust workspace — fork 自 vercel-labs/agent-browser
│   ├── Cargo.toml      # Rust workspace root，不在 Bun workspace 里
│   ├── sdk/            # Rust SDK crate — WebSocket transport + session 管理
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs      # MoatClient: connect/resume/command/disconnect
│   │       ├── wire.rs     # WireRequest/WireResponse serde 定义
│   │       ├── session.rs  # ~/.moat/session 文件读写
│   │       └── error.rs    # SDK error types
│   ├── moat-cli/       # CLI 二进制（fork，connection.rs 改为调用 SDK）
│   │   └── src/
│   │       ├── main.rs         # connect/disconnect/status + 命令 passthrough
│   │       └── connection.rs   # 替换 upstream: Unix socket → moat-sdk WebSocket
│   └── UPSTREAM.md     # 记录与 upstream 的 diff、合并策略
├── packages/           # Bun workspace (TS/Node)
│   ├── types/          # Wire 协议 canonical 定义 + ADT + arktype schema
│   ├── sdk/            # TS SDK — RPC 客户端库
│   ├── controller/     # Node.js — wire 协议服务端
│   └── e2e/            # E2E 测试
├── images/
│   ├── user-chrome/    # User Chrome 镜像 (neko base + Chrome for Testing)
│   └── agent-chrome/   # Agent Chrome 镜像 (Chrome for Testing + CDP)
├── skills/
│   └── moat/
│       └── SKILL.md    # Agent 可发现性文档，随包分发
├── README.md           # 设计文档
├── CLAUDE.md
├── package.json
├── bunfig.toml
└── tsconfig.json
```

## Code Conventions

- ADT: 所有 union 类型使用 `_tag` discriminant + `readonly` fields
- Switch: `default: exhaustive(x)` 兜底，不允许 fall-through
- Error handling: 返回 `Result | Error` union，不 throw
- Types: 不使用 `any`、`as` 类型断言（第三方库交互除外）
- Container API: fetch + Docker Engine Unix socket，不用 dockerode
- Validation: arktype 做运行时验证，TypeScript 做编译时检查

## Verification Commands

- TS 包 typecheck: `bun run build` (per package under `packages/`)
- TS 单元测试: `bun test packages/sdk/` or `bun test packages/controller/`
- E2E 测试: `bun test packages/e2e/`
- Rust 构建: `cd cli && cargo build --release`
- Rust 测试: `cd cli && cargo test`
- 与 upstream agent-browser 同步: `cd cli && git fetch upstream && git merge upstream/main`（仅 `connection.rs` 和新增 session 命令会产生冲突）
- Docker: 构建与部署由 `v*` tag 触发 `.github/workflows/deploy.yml`（self-hosted runner 构建并推送 controller / user-chrome / agent-chrome 镜像，再经 Komodo API 执行 `moat-browser` stack 的 UpdateStack + DeployStack），不手动 docker build/compose 上线
  - user-chrome 与 agent-chrome 都必须以仓库根目录为 context 构建：`docker build --platform linux/amd64 -f images/<user-chrome|agent-chrome>/Dockerfile .`（Chrome 版本从 Patchright 锚派生，见 README §11.4）；部署前三方版本校验：`.github/scripts/verify-chrome-versions.sh <controller 镜像> <user 镜像> <agent 镜像>`

## Target Environment

- VM 104 at `browser.hb.lan` (192.168.1.221; Browser server, Komodo managed)
- Docker ready, Bun installed
- CPU: host (Bun hangs on qemu64)

## Commit Format

```
<type>: <description>

via [HAPI](https://hapi.run)

Co-Authored-By: HAPI <noreply@hapi.run>
```

Types: `init`, `feat`, `fix`, `refactor`, `test`, `docs`, `chore`
