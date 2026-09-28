# CLAUDE.md — moat-browser

## Project Context

- **目的**：解决两件事：多个 agent 抢同一个浏览器；人的登录态（user-data）如何交给 agent。与任何特定业务无关。
- **核心设计**：一份由人维护的源 profile，每个 agent session 一份 `cp -a` 拷贝，每个 session 一个独立的 agent-chrome 容器。拷贝不回写，session 结束即删除。生命周期由 Controller 持有。
- **载体**：neko 是人的登录入口（WebRTC 远程桌面），agent-browser 是 agent 的命令词汇（`moat` CLI 是它的 fork）。两者都是可替换的现成实现，不是核心。
- **This repo's role**：开源应用代码（Controller、Rust CLI + SDK、wire 类型、两个浏览器镜像、E2E）和从源码自行构建的 `compose.yaml`。不含 CI、私有镜像引用、生产 compose 或任何 secret。
- **设计文档**：`README.md`（问题、设计、生命周期、部署、已知约束）；模块细节在 `docs/`；面向 agent 的 CLI 契约在 `skills/moat/SKILL.md`。

## Related Repos

|Repo|Role|Relationship|
|---|---|---|
|moat-browser-deploy（`mouriya-s-lab/moat-browser-deploy`，私有）|CI/CD + 生产部署声明|全部 workflow（镜像构建推送与部署、CLI 发布、Komodo 同步）、Komodo stack 声明、生产 compose、GitHub Actions secrets。发版在该仓库打 tag，它 checkout 本仓库同名 ref 构建|
|homelab-tf (`~/work/homelab-tf`)|IaC (OpenTofu + Ansible + Komodo)|生产主机与 Komodo Core/Periphery、ResourceSync 对象|

## Issues

- Tracked in `mouriya-s-lab/moat-browser`（`Mouriya-Emma/moat-browser`、`moat-lab/moat-browser` 是 transfer 前的旧名，只靠 GitHub redirect 可达，不再使用）。
- 查当前 open issue 用 `issue://mouriya-s-lab/moat-browser?state=open`，不在本文件维护清单。

## Tech Stack

- **Controller**：Node.js + TypeScript（Patchright 在 Bun 下连接 CDP 有兼容性问题，README §11.6）
- **wire 类型 / E2E**：Bun + TypeScript（`packages/types`、`packages/e2e`）
- **CLI + SDK**：Rust workspace `cli/`（`moat-cli` 产出二进制 `moat`，`sdk` 即 `moat-sdk`），不在 Bun workspace 里
- **Wire 协议**：沿用 agent-browser daemon 的命令 JSON 形状（SDK 规范化后发送）+ session envelope；请求只有 `register`、`deregister`、`command`（README §10）
- **WebSocket**：原生 `ws`（不用 socket.io）；CLI 每个发往 Controller 的请求新开一个连接
- **Browser automation**：patchright（反检测 Playwright fork）经 `connectOverCDP` 连接 agent-chrome
- **浏览器**：两侧都是由 Patchright 版本锚派生的同版本 Chrome for Testing（README §11.4）
- **Runtime validation**：arktype
- **Container management**：Docker Engine API via fetch + Unix socket（不用 dockerode）
- **Type system**：discriminated union ADT（`_tag` field）+ exhaustive switch

## Directory Structure

|路径|内容|
|---|---|
|`cli/moat-cli/`|`moat` CLI，agent-browser 的 fork；fork 专属代码在 `src/fork_features/`|
|`cli/sdk/`|Rust SDK：WebSocket transport、命名 session 槽位（`$HOME/.moat/sessions/<name>`）、wire 编解码（`wire.rs`）|
|`cli/UPSTREAM.md`|与 upstream agent-browser 的差异和同步记录|
|`packages/types/`|wire 协议与 ADT 的 TypeScript 定义 + arktype schema|
|`packages/controller/`|Controller：`ws-server.ts`、`session-registry.ts`、`session-admission.ts`、`container-manager.ts`、`cdp-bridge.ts`、`browser-anchor.ts`|
|`packages/e2e/`|E2E 测试、`profile-guard.ts`、测试用 `docker-compose.test.yml`|
|`images/user-chrome/`|neko base + Chrome for Testing，人的登录入口|
|`images/agent-chrome/`|Debian + Xorg + openbox + Chrome for Testing + socat CDP 转发|
|`images/chrome-anchor.mjs`|从 Patchright 派生 Chrome 版本|
|`compose.yaml`|从源码本地构建并运行全部服务（README §9）|
|`scripts/`|`verify-chrome-versions.sh`（三镜像版本校验）、`cli-command-contract.py`、`install.sh`（从 moat-browser-deploy 的 release 下载 CLI）|
|`skills/moat/SKILL.md`|面向 agent 的 CLI 使用说明，随仓库分发|
|`docs/`|容器、Controller、Rust SDK 设计，E2E 方案，spike 历史报告|

## Code Conventions

- ADT：所有 union 类型使用 `_tag` discriminant + `readonly` fields
- Switch：`default: exhaustive(x)` 兜底，不允许 fall-through
- Error handling：返回 `Result | Error` union，不 throw
- Types：不使用 `any`、`as` 类型断言（第三方库交互除外）
- Validation：arktype 做运行时验证，TypeScript 做编译时检查
- wire 协议改动必须同时改 `packages/types` 与 `cli/sdk/src/wire.rs`，两边没有机械一致性校验（README §11.9）
- CLI 的 fork 改动遵循 `cli/UPSTREAM.md` 与 `cli/moat-cli/src/fork_features/trunk-patches.md` 的记录方式

## Verification Commands

- TS typecheck：`bun run build`（在 `packages/controller` 或 `packages/types` 下）
- TS 单元测试：`bun test packages/controller/`、`bun test packages/types/`
- E2E：`bun test packages/e2e/`（本地环境用 `packages/e2e` 的 `compose:up` / `compose:down`）
- Rust：`cd cli && cargo build --release`、`cd cli && cargo test`
- Profile 护栏（推进 Patchright 锚或发布前必跑）：`MOAT=cli/target/release/moat bun run packages/e2e/profile-guard.ts --controller-image <c> --user-image <u> --agent-image <a>`（README §11.4）
- 浏览器镜像以仓库根目录为 context 构建：`docker build --platform linux/amd64 -f images/<user-chrome|agent-chrome>/Dockerfile .`；三方版本校验：`scripts/verify-chrome-versions.sh <controller 镜像> <user 镜像> <agent 镜像>`
- 本地整套运行：`docker compose up -d --build`（需要的环境变量见 `compose.yaml` 顶部注释与 README §9）
- 发布与生产部署不在本仓库：见 moat-browser-deploy。本仓库不得加入 workflow、私有 registry 镜像引用或 secret 文件

## 运行约束

- 只推荐在 x86_64（amd64）Linux 上部署；两个浏览器镜像只有 `linux/amd64`，没有适配 Apple Silicon，不推荐在 macOS 上运行（README §9）
- 运行 Bun 的 VM 必须用 host CPU（Bun 在 qemu64 上会 hang，README §11.5）

## Commit Format

```
<type>: <description>

via [HAPI](https://hapi.run)

Co-Authored-By: HAPI <noreply@hapi.run>
```

Types：`init`、`feat`、`fix`、`refactor`、`test`、`docs`、`chore`
