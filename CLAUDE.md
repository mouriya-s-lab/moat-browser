# CLAUDE.md — moat-browser 无人值守开发指南

## 项目概述

moat-browser 是企业级浏览器 RPC 系统，让 AI Agent 通过 CDP 操作远程 Chromium，用户通过 neko WebRTC 完成 SaaS 登录。核心理念：有状态登录 + 无状态执行。

- **仓库**: Mouriya-Emma/moat-browser
- **技术栈**: Bun + TypeScript, Docker, Socket.IO, arktype, ADT (discriminated union)
- **设计文档**: `browser-rpc.md`（架构参考，不要修改）

## Phase 路线图

按 issue 编号顺序交付，每个 Phase 有明确的验收标准：

| Phase | Issue | 内容 | 依赖 |
|-------|-------|------|------|
| 1 | #1 | Browser VM IaC (Terraform + Ansible) | 无 |
| 2 | #2 | User Chrome Docker 镜像 (neko + Chromium) | Phase 1 |
| 3 | #3 | Agent Chrome Docker 镜像 (Patchright + CDP) | Phase 1, 2 |
| 4 | #4 | Docker Controller (容器生命周期) | Phase 2, 3 |
| 5 | #5 | WebSocket Gateway (Socket.IO API 网关) | Phase 4 |
| 6 | #6 | User Profile 管理 (冻结/拷贝/快照) | Phase 4 |
| 7 | #7 | Agent 注册系统 (认证 + 实例隔离) | Phase 5 |
| 8 | #8 | RPC Shim (客户端 SDK/二进制) | Phase 5 |
| 9 | #9 | E2E 测试框架 | Phase 5, 8 |

---

## Loop 工作流

每次 loop 迭代执行以下流程。严格按顺序执行，不要跳步。

### Step 0: 状态感知

```bash
# 1. 当前正在进行的任务
gh issue list --state open --label "in-progress" --limit 5

# 2. 所有 open issue（含子任务）
gh issue list --state open --limit 50

# 3. 检查某个 Phase issue 是否有子任务（按需对每个候选 issue 执行）
gh api repos/Mouriya-Emma/moat-browser/issues/<N>/sub_issues \
  -H "X-GitHub-Api-Version: 2026-03-10" --jq '.[].number'

# 4. 代码状态
git branch -a
git status
gh pr list --state open
```

**Issue 标签体系：**

| 标签 | 含义 |
|------|------|
| `phase-N` | 属于 Phase N |
| `in-progress` | 正在实现中 |
| `review` | 实现完成，等待人工 review |
| `blocked` | 被问题阻塞 |
| `bug` | 实现过程中发现的 bug |

> 注意：不需要 `sub-task` 或 `decomposed` 标签。父子关系通过 GitHub 原生 sub-issue 功能管理，在 issue 的 Development 区域可视化展示。

**任务选择优先级（从高到低）：**

1. 有 `in-progress` 标签的 issue → 继续
2. 有 open PR 收到了 review 意见 → 修改 PR
3. 有子任务的 Phase issue → 找其中依赖已满足的最小编号 open 子任务 → 领取
4. 无子任务、依赖已完成的最小编号 open Phase issue → 进入 Step 1 评估拆分
5. 无可做任务 → 结束本次 loop

### Step 1: 任务拆分评估

**Issue 是绝对的任务来源。不在 issue 中的工作不做。**

拿到一个 Phase issue 后，先通读完整内容，评估是否需要拆分：

```
gh issue view <N>
```

**拆分判断标准：**

| 信号 | 判断 |
|------|------|
| issue 中有 2+ 个独立的技术模块（如 Dockerfile + supervisord 配置 + entrypoint 脚本） | 应拆分 |
| issue 中有明确分层（如类型定义 → 核心实现 → API 层 → 测试） | 应拆分 |
| 预估实现需要 3+ 个不同目录的文件变更 | 应拆分 |
| issue 内容简单，单次 loop 可完成 | 不拆分 |
| issue 已经是子任务 | 不再拆分 |

**拆分执行（使用 GitHub 原生 sub-issue）：**

```bash
OWNER="Mouriya-Emma"
REPO="moat-browser"
PARENT=<N>

# 1. 创建子任务 issue
CHILD_URL=$(gh issue create \
  --title "Phase <N>.<seq>: <子任务标题>" \
  --body "$(cat <<'EOF'
## 目标
<从父 issue 中提取该子任务的具体目标>

## 技术方案
<从父 issue 中提取相关部分，必要时细化>

## 验收标准
- [ ] <具体的、可验证的标准>
- [ ] <对应的 E2E 测试用例通过>

## 依赖
- <列出依赖的其他子任务或 Phase>
EOF
)" \
  --label "phase-<N>")

# 2. 获取子 issue 的内部 ID，挂载为 sub-issue
CHILD_NUMBER=$(echo "$CHILD_URL" | grep -o '[0-9]*$')
CHILD_ID=$(gh api "repos/$OWNER/$REPO/issues/$CHILD_NUMBER" --jq .id)
gh api "repos/$OWNER/$REPO/issues/$PARENT/sub_issues" \
  -X POST \
  -H "X-GitHub-Api-Version: 2026-03-10" \
  -F sub_issue_id="$CHILD_ID"

# 对每个子任务重复步骤 1-2
```

**拆分完成后，在父 issue 回复说明拆分情况：**

```bash
gh issue comment $PARENT --body "🤖 已将此 Phase 拆分为子任务，见 Development 区域的 sub-issues 列表。按顺序执行，全部完成后关闭本 issue。"
```

**拆分完成后，当前 loop 回到 Step 0 重新选任务**（选第一个可做的子任务）。

**拆分粒度原则：**
- 每个子任务应在单次 loop 内可完成
- 每个子任务有独立的验收标准和 E2E 测试点
- 子任务之间的依赖关系必须明确
- 类型定义（`packages/types/`）通常单独一个子任务，因为后续子任务都依赖它
- E2E 测试通常单独一个子任务，放在该 Phase 最后

**典型拆分模式：**

```
Phase N（父 issue）
├── Phase N-1: ADT 类型定义 + arktype schema
├── Phase N-2: 核心实现 A（如 Dockerfile）
├── Phase N-3: 核心实现 B（如 entrypoint + supervisord）
├── Phase N-4: 核心实现 C（如 API/接口层）
└── Phase N-5: E2E 测试
```

### Step 2: 领取任务

确定要做的 issue（父 issue 或子任务 issue）后：

```
gh issue edit <N> --add-label "in-progress"
gh issue comment <N> --body "🤖 开始自动化实现。分支: phase-<N>"
```

对于子任务，分支名使用 `phase-<parent>-<sub>`（如 `phase-2-1`）。

### Step 3: 分支管理

```
git checkout main && git pull origin main
git checkout -b phase-<N>
```

如果分支已存在（上次 loop 的中间状态）：
```
git checkout phase-<N>
git pull origin phase-<N> 2>/dev/null || true
```

子任务分支基于父 Phase 分支（如果已存在）或 main：
```
# 优先基于已有的父分支
git checkout phase-<parent> 2>/dev/null || git checkout main
git pull
git checkout -b phase-<parent>-<sub>
```

### Step 4: 实现

阅读对应 issue 的完整内容（`gh issue view <N>`），按照 issue 中的技术方案和验收标准实现。

**实现原则：**
- 严格按 issue 中的目录结构和文件命名
- ADT 类型定义放在 `packages/types/`，先写类型再写实现
- **测试策略：E2E 优先**（详见下方「测试策略」章节）
- 使用 arktype 做运行时验证，不要用 zod
- 所有状态机必须有穷尽性检查（`exhaustive` helper）
- Dockerfile 遵循多阶段构建，最小化镜像体积

### Step 5: 验证

对照 issue 中的验收标准逐项检查：
- **E2E 测试必须通过** — `bun test packages/e2e/`（如果该 Phase 有对应 E2E 用例）
- 单元测试通过 — `bun test packages/<pkg>/`
- 能 lint 的 lint（`bun run lint` 或类似）
- 能构建的构建（`docker build` / `bun build`）
- 不能在本机验证的（如 Proxmox API、Docker daemon），在 issue 中注明
- **如果 E2E 测试失败，不允许创建 PR**。修复后重试，3 次修不好则创建 issue 记录

### Step 6: 提交与推送

**Commit 规范：**
```
<type>(phase-<N>): <简要描述>

<详细说明，如果需要>

Refs: #<N>
```

type 取值：`feat`, `fix`, `refactor`, `test`, `docs`, `chore`

**提交粒度：**
- 类型定义单独一个 commit
- 核心实现一个 commit
- E2E 测试 + 单元测试一个 commit（测试和实现紧密关联时可合并）
- Dockerfile / 配置一个 commit

```
git add <具体文件>
git commit -m "feat(phase-N): ..."
git push origin phase-<N>
```

### Step 7: 创建 / 更新 PR

首次推送时创建 PR：
```
gh pr create --title "Phase N: <标题>" --body "..." --base main --label "phase-N"
```

PR body 模板：
```markdown
## Summary
Closes #<N>

## Changes
- ...

## Checklist (from issue acceptance criteria)
- [ ] 验收标准 1
- [ ] 验收标准 2
- ...

## Notes
<任何无法自动验证的事项、已知限制、需要人工确认的决策>
```

### Step 8: 收尾

**情况 A — 任务完成：**

```bash
gh issue comment <N> --body "🤖 实现完成，PR: #<pr-number>。等待人工 review。"
gh issue edit <N> --remove-label "in-progress" --add-label "review"
```

如果完成的是子任务，检查父 issue 的所有子任务状态：

```bash
OWNER="Mouriya-Emma"
REPO="moat-browser"

# 获取父 issue 编号
PARENT=$(gh api "repos/$OWNER/$REPO/issues/<N>/parent" \
  -H "X-GitHub-Api-Version: 2026-03-10" --jq .number 2>/dev/null)

if [ -n "$PARENT" ]; then
  # 列出所有子任务的状态
  OPEN_COUNT=$(gh api "repos/$OWNER/$REPO/issues/$PARENT/sub_issues" \
    -H "X-GitHub-Api-Version: 2026-03-10" \
    --jq '[.[] | select(.state == "open")] | length')

  if [ "$OPEN_COUNT" -eq 0 ]; then
    gh issue comment "$PARENT" --body "🤖 所有子任务已完成。Phase 交付完毕。"
    gh issue edit "$PARENT" --add-label "review"
  fi
fi
```

**情况 B — 遇到阻塞：**

```bash
# 直接在当前 issue 中记录问题（坑、发现、阻塞原因）
gh issue comment <N> --body "🤖 遇到阻塞:

**问题**: <问题描述>
**原因**: <分析>
**影响**: <对当前任务的影响>
**可能的解决方案**: <如果有>

暂停此任务，标记为 blocked。"

gh issue edit <N> --remove-label "in-progress" --add-label "blocked"
```

仅当问题需要独立跟踪修复时（如 bug 影响多个 Phase），才创建单独的 bug issue：

```bash
gh issue create --title "Bug: <描述>" --body "..." --label "bug,phase-<N>"
# 在当前 issue 中引用
gh issue comment <N> --body "🤖 已创建 #<M> 跟踪此问题。"
```

**情况 C — 单次 loop 时间不够，中间状态：**

```bash
# 提交已完成的部分，push 到远程保存进度
git add <已完成的文件>
git commit -m "wip(phase-<N>): <已完成的部分描述>

Refs: #<N>"
git push origin <branch>

# 在当前 issue 中记录进度和上下文
gh issue comment <N> --body "🤖 本次 loop 进度：
- [x] 已完成: <内容>
- [ ] 待完成: <内容>

分支: \`<branch>\`
下次 loop 继续。"
# 保留 in-progress 标签，下次 loop 会自动续接
```

---

## 信息记录原则

**所有过程信息直接回复到当前正在处理的 issue 上。** Issue comment 是唯一的信息沉淀途径。

应该记录到当前 issue comment 的内容：

| 场景 | 记录什么 |
|------|---------|
| 踩坑 / 踩雷 | 问题现象、根因分析、解决方案 |
| 技术决策 | 为什么选 A 不选 B，trade-off 分析 |
| 发现 issue 描述有误或遗漏 | 指出差异，说明实际采用的方案 |
| 依赖版本问题 | 具体版本号、兼容性说明 |
| 环境差异 | 本地 vs CI vs 生产的区别 |
| 中间进度 | 已完成 / 待完成清单 |
| 阻塞原因 | 被什么阻塞、需要什么才能继续 |

**不要** 创建新 issue 来记录这些。只有当问题需要独立跟踪修复（如 bug 影响多个 Phase）时，才创建新 issue。

---

## 问题处理机制

### 遇到问题时的决策树

```
问题是否可以在当前 loop 内解决？
├── 是 → 直接修复，在当前 issue 中记录踩坑经过，继续
└── 否 →
    ├── 问题只影响当前任务 → 在当前 issue 中记录，标记 blocked
    └── 问题影响多个 Phase / 需要独立修复 → 创建 bug issue，当前 issue 中引用

```

### 何时创建新 issue（而非 comment）

仅在以下情况创建独立的 bug issue：
- bug 影响多个 Phase 或多个子任务
- 需要独立分配和跟踪的修复工作
- 需要阻塞其他任务的依赖项

```bash
# 创建 bug issue
gh issue create \
  --title "Bug: <简要描述>" \
  --body "..." \
  --label "bug,phase-<N>"

# 在当前工作 issue 中引用
gh issue comment <current-N> --body "🤖 发现问题，已创建 #<M> 独立跟踪。"
```

### 常见问题处理

| 问题 | 处理方式 |
|------|---------|
| 依赖的 Phase 未完成 | 跳过，做其他可做的 Phase |
| Docker 构建失败 | 检查 Dockerfile，修复后重试。3 次失败后在 issue 中记录详情 |
| 类型冲突 | 优先修改新代码适配已有类型。记录冲突原因到 issue |
| 测试失败 | 先确认是测试写错还是实现有 bug，修复后重试。在 issue 中记录失败原因和修复方式 |
| 外部依赖不可用 | 在 issue 中记录，mock 掉继续。在 PR 中注明 |
| 验收标准不明确 | 在 issue 中 comment 提出疑问，按最合理的理解实现 |

---

## 代码规范

### 项目结构

```
moat-browser/
├── packages/
│   ├── types/          # 共享 ADT 类型 + arktype schema
│   ├── controller/     # Docker Controller (Phase 4)
│   ├── gateway/        # Socket.IO Gateway (Phase 5)
│   ├── profile/        # Profile 管理 (Phase 6)
│   ├── shim/           # RPC Shim SDK (Phase 8)
│   └── e2e/            # E2E 测试 (Phase 9)
├── images/
│   ├── user-chrome/    # User Chrome 镜像 (Phase 2)
│   └── agent-chrome/   # Agent Chrome 镜像 (Phase 3)
├── infra/              # IaC (Phase 1)
│   ├── terraform/
│   └── ansible/
├── browser-rpc.md      # 架构设计文档（只读参考）
├── package.json        # Workspace root
├── bunfig.toml
└── tsconfig.json
```

### TypeScript 规范

- 使用 `readonly` 修饰所有 ADT 字段
- 使用 discriminated union (`_tag` 字段) 建模所有状态/请求/响应/错误
- 所有 `switch` 必须有 `default: exhaustive(x)` 兜底
- arktype 做运行时验证，TypeScript 类型做编译时检查
- 不使用 `any`、`as` 类型断言（除非与第三方库交互必须）
- 函数返回 `Result | Error` union，不 throw

### exhaustive helper

```typescript
export function exhaustive(x: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(x)}`);
}
```

---

## 测试策略：E2E 优先

**核心原则：每个 Phase 交付时必须附带 E2E 测试，证明该 Phase 的功能在真实环境中可用。单元测试是补充，不是替代。**

### 测试金字塔（本项目倒置）

```
┌─────────────────────────────┐
│        E2E 测试（主力）       │  ← 真实容器、真实网络、真实浏览器
│   集成测试（Docker Compose）  │
├─────────────────────────────┤
│     单元测试（纯逻辑补充）     │  ← ADT 状态机转移、schema 验证、工具函数
└─────────────────────────────┘
```

### 各 Phase 的 E2E 测试要求

| Phase | E2E 测试内容 | 测试方式 |
|-------|-------------|---------|
| 1 | IaC `terraform plan` 无错误，Ansible playbook dry-run 通过 | `terraform plan` + `ansible-playbook --check` |
| 2 | user-chrome 容器启动 → neko 端口响应 → HTTP 200 → profile 目录写入 | Docker 启动容器 + HTTP 请求验证 |
| 3 | agent-chrome 容器启动 → CDP 9222 响应 → Unix socket 可用 → 执行 navigate 命令成功 | Docker 启动容器 + socket 命令验证 |
| 4 | Controller API → 创建容器 → 容器运行中 → 销毁容器 → 容器不存在 | 调用 Controller 接口验证完整生命周期 |
| 5 | Socket.IO 连接 → 发送 Command → 收到 CommandResult → 断开重连 | Socket.IO client 端到端 |
| 6 | 创建 profile → 人类登录（mock）→ 冻结 → agent 拷贝 → 验证 Cookies 存在 → 清理 | 完整 profile 生命周期 |
| 7 | 注册 agent → 获得 session → 发送命令 → idle 超时 → session 过期 | 完整注册-过期流程 |
| 8 | Shim SDK `connect()` → `navigate()` → `snapshot()` → `disconnect()` | SDK 集成测试打真实 Gateway |
| 9 | 全链路: shim → gateway → controller → agent-chrome → 浏览器操作 → 结果返回 | Docker Compose 全栈 |

### E2E 测试基础设施

所有 E2E 测试统一放在 `packages/e2e/` 下，按 Phase 组织：

```
packages/e2e/
├── src/
│   ├── helpers.ts              # 共享工具：assertResult, createTestClient, waitForPort
│   ├── setup.ts                # 全局 setup/teardown (docker compose up/down)
│   ├── phase2.test.ts          # Phase 2 E2E
│   ├── phase3.test.ts          # Phase 3 E2E
│   ├── phase4.test.ts          # Phase 4 E2E
│   ├── phase5.test.ts          # Phase 5 E2E
│   ├── phase6.test.ts          # Phase 6 E2E
│   ├── phase7.test.ts          # Phase 7 E2E
│   ├── phase8.test.ts          # Phase 8 E2E
│   └── full-chain.test.ts      # Phase 9 全链路
├── docker-compose.test.yml     # 测试用 Docker Compose
├── fixtures/
│   ├── webapp/                 # 测试用静态网站 (nginx)
│   │   └── index.html          # 包含表单、按钮、链接的测试页
│   └── profiles/
│       └── seed/               # 预置 profile (有 cookie 的)
├── package.json
└── tsconfig.json
```

### Docker Compose 测试环境

`packages/e2e/docker-compose.test.yml` 按需递增——每完成一个 Phase 就把该 Phase 的服务加入：

```yaml
# Phase 2 完成后：
services:
  test-webapp:
    image: nginx:alpine
    volumes: ["./fixtures/webapp:/usr/share/nginx/html:ro"]
    ports: ["8888:80"]

  user-chrome:
    build: ../../images/user-chrome
    environment:
      NEKO_PASSWORD: "test"
      NEKO_PASSWORD_ADMIN: "test"
      NEKO_SCREEN: "1280x720@24"
    ports: ["8080:8080", "8081:8081"]
    volumes: ["test-profiles:/data/profile"]

# Phase 3 追加:
  agent-chrome:
    build: ../../images/agent-chrome
    volumes: ["test-profiles:/data/profile"]

# Phase 4 追加:
  controller:
    build: ../../packages/controller
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - test-profiles:/data/profiles

# Phase 5 追加:
  gateway:
    build: ../../packages/gateway
    ports: ["9800:9800"]
    depends_on: [controller]
    environment:
      MOAT_BROWSER_JWT_SECRET: "test-secret-do-not-use-in-prod"

volumes:
  test-profiles:
```

### E2E 测试编写规范

```typescript
// 所有 E2E 测试遵循 Arrange-Act-Assert + ADT 断言

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { assertResult, waitForPort, DockerHelper } from "./helpers";

describe("Phase N: <名称>", () => {
  let docker: DockerHelper;

  beforeAll(async () => {
    docker = await DockerHelper.up("docker-compose.test.yml", ["service-name"]);
    await waitForPort(8080, { timeout: 30_000 });
  });

  afterAll(async () => {
    await docker.down();
  });

  test("完整场景描述", async () => {
    // Arrange
    const client = createTestClient({ ... });

    // Act
    const result = await client.navigate("http://test-webapp:8888");

    // Assert — 使用 ADT _tag 断言，不要用 toEqual 匹配整个对象
    assertResult(result, "NavigateResult");
    expect(result.url).toContain("8888");
  });
});
```

### E2E Helper 工具

`packages/e2e/src/helpers.ts` 必须在首次编写 E2E 时创建，包含：

```typescript
// 1. ADT 断言
export function assertResult<Tag extends BrowserResult["_tag"]>(
  result: BrowserResult, tag: Tag
): Extract<BrowserResult, { _tag: Tag }>;

export function assertError<Tag extends GatewayError["_tag"]>(
  error: GatewayError, tag: Tag
): Extract<GatewayError, { _tag: Tag }>;

// 2. 端口等待
export async function waitForPort(port: number, opts?: { host?: string; timeout?: number }): Promise<void>;

// 3. HTTP 健康检查
export async function waitForHealth(url: string, opts?: { timeout?: number; interval?: number }): Promise<void>;

// 4. Docker Compose 管理
export class DockerHelper {
  static async up(composePath: string, services?: string[]): Promise<DockerHelper>;
  async down(): Promise<void>;
  async logs(service: string): Promise<string>;
  async exec(service: string, cmd: string[]): Promise<string>;
}

// 5. 测试 profile 工厂
export async function seedProfile(name: string): Promise<string>;  // 返回 profile 路径
export async function cleanProfiles(): Promise<void>;
```

### 何时写单元测试（而非 E2E）

仅在以下场景写单元测试作为 E2E 的补充：
- **ADT 状态机转移函数** — 穷尽性测试所有 state × action 组合
- **arktype schema 验证** — 边界值、畸形输入
- **纯计算函数** — 无副作用的数据变换
- **错误路径** — E2E 中难以触发的异常分支

单元测试放在各自 package 的 `__tests__/` 或 `src/*.test.ts` 中，不放 `packages/e2e/`。

### CI 中的测试执行顺序

```bash
# 1. 类型检查
bun run typecheck

# 2. 单元测试（快，秒级）
bun test --filter "packages/types"
bun test --filter "packages/controller"
bun test --filter "packages/gateway"
# ...

# 3. E2E 测试（慢，分钟级，需要 Docker）
cd packages/e2e && docker compose -f docker-compose.test.yml up -d --build --wait
bun test packages/e2e/
cd packages/e2e && docker compose -f docker-compose.test.yml down -v
```

---

### Git 规范

- **不要直接 push 到 main**
- 每个 Phase 一个分支 `phase-<N>`
- PR merge 到 main 后删除分支
- Commit message 必须引用 issue: `Refs: #<N>`
- 不要 force push
- 不要 amend 已经 push 的 commit

---

## Monorepo 配置

首次 loop 应确保以下基础配置存在（如果不存在则创建）：

### package.json (root)

```json
{
  "name": "moat-browser",
  "private": true,
  "workspaces": ["packages/*"]
}
```

### tsconfig.json (root)

```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src"
  }
}
```

---

## Loop 执行频率与超时

- 每次 loop 聚焦一个 Phase 或一个 PR 修复
- 如果单次 loop 工作量太大，在合理的断点提交中间进度，下次 loop 继续
- 遇到需要人工介入的事项，创建 issue 后立即结束当前 loop 迭代

## 安全注意事项

- 不要在代码中硬编码密码、token、secret
- JWT secret、neko 密码等使用环境变量
- Docker socket 挂载时注意权限
- Profile 目录包含用户凭据，确保权限设置正确 (0700)
