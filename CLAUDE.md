# CLAUDE.md — moat-browser

## Project Context

- **Project**: moat-browser — 企业级浏览器 RPC 系统。AI Agent 通过 CDP 操作远程 Chromium，用户通过 neko WebRTC 完成 SaaS 登录
- **This repo's role**: 应用代码（Controller + Shim SDK + Docker 镜像 + E2E 测试）
- **Design doc**: `README.md`
- **Core idea**: 有状态登录 + 无状态执行。人类负责登录（neko WebRTC），Agent 负责执行（Patchright CDP），Profile 在中间桥接

## Related Repos

| Repo | Role | Relationship |
|---|---|---|
| arch_lxc (`/root/work/arch_lxc`) | IaC (Terraform + Ansible) | Browser VM 104 (192.168.1.200) 的基础设施，Phase 1 已完成 |

## Issues

- Tracked in: `Mouriya-Emma/moat-browser`
- Spike A (#77): neko 镜像可行性验证
- Spike B (#78): Chrome for Testing CDP 可达性验证
- Phase 2 (#71): User Chrome Docker 镜像
- Phase 3 (#72): Agent Chrome Docker 镜像
- Phase 4 (#73): Controller
- Phase 5 (#74): Profile 管理
- Phase 6 (#75): Shim SDK
- Phase 7 (#76): E2E 测试框架

## Tech Stack

- **Runtime**: Bun + TypeScript
- **WebSocket API**: socket.io / socket.io-client
- **Browser automation**: patchright (反检测 Playwright fork)
- **Runtime validation**: arktype
- **Container management**: Docker Engine API via fetch + Unix socket (不用 dockerode)
- **Type system**: discriminated union ADT (`_tag` field) + exhaustive switch

## Directory Structure

```
moat-browser/
├── packages/
│   ├── types/          # 共享 ADT 类型 + arktype schema
│   ├── controller/     # Controller（容器管理 + Socket.IO + CDP Bridge）
│   ├── shim/           # Shim SDK（Agent 端客户端库）
│   └── e2e/            # E2E 测试
├── images/
│   ├── user-chrome/    # User Chrome 镜像 (neko + Chromium)
│   └── agent-chrome/   # Agent Chrome 镜像 (Chrome for Testing + CDP)
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

- Typecheck: `bun run build` (per package)
- Test (unit): `bun test packages/controller/` or `bun test packages/shim/`
- Test (e2e): `bun test packages/e2e/`
- Docker build: `docker build -t <name> images/<name>/`
- Docker compose: `docker compose -f packages/e2e/docker-compose.test.yml up -d`

## Target Environment

- VM 104 at 192.168.1.200
- Docker ready, Bun installed
- CPU: host (Bun hangs on qemu64)

## Commit Format

```
<type>: <description>

via [HAPI](https://hapi.run)

Co-Authored-By: HAPI <noreply@hapi.run>
```

Types: `init`, `feat`, `fix`, `refactor`, `test`, `docs`, `chore`
