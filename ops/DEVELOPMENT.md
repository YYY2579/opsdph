# Ops Agent 开发文档（验收版）

本文件是本次运维增强开发的主文档：版本冻结、仓库约束、功能规格、开发顺序、验收标准、子代理分工。

上游项目：DeepSeek Harness（`dsh`）。本仓库是它的本地 fork，运维能力以插件包形式新增，不改内核。

## 0. 版本冻结

| 项 | 值 |
|---|---|
| 上游仓库 | `https://github.com/deepseek-ai/deepseek-harness` |
| 基础 commit | `c291e7961a515f6d7af9304e7fd1d257929aef26`（2026-09-10，master，`Merge pull request #3977 from deepseek-harness/worktree/release-0.1.5-sync-master`） |
| 上游版本 | `0.1.5-rc.2`（developer preview，明确会发生破坏性变更） |
| Node | `^22.19.0 || >=24.0.0`（本机 v24.19.0） |
| pnpm | `11.7.0`（`packageManager` 固定，corepack 自动选择；本机 11.19.0） |
| 桌面 | Electron `^44.0.0` + electron-builder `^26.15.3`（上游 `apps/desktop` 自带） |
| 本地路径 | `C:\Users\25791\Desktop\agent\deepseek-harness` |
| 开发分支 | `feature/ops` |

同步策略：不追更。需要升级时单独执行 `git fetch upstream`，先跑本文件第 5 节的升级门禁，再合并。

## 1. 仓库准备状态

- [x] 克隆到 `deepseek-harness/`
- [x] 核对 `HEAD` = `c291e7961a515f6d7af9304e7fd1d257929aef26`
- [x] 建分支 `feature/ops`
- [x] 配置 `upstream` remote
- [x] `pnpm install` 通过（5m03s，实际使用 pnpm 11.19.0）
- [x] 基线 `pnpm run typecheck` 通过

当前 `origin` 与 `upstream` 都指向官方仓库；后续在 GitHub 建自己的 fork 后，把 `origin` 改为自己的 fork，`upstream` 保持官方。

## 2. 仓库硬约束（必须遵守）

以下规则来自上游根 `AGENTS.md`、`packages/AGENTS.md`、`docs/AGENTS.md`，是本项目不可违背的工程约束。

- **包规范**：包名 `@deepseek-ai/dsh-<name>`，路径 `packages/<group>/<pkg>/`；`private: true`；`version` 与根一致；`type: module`；`main: lib/index.js`；`types: lib/types/index.d.ts`。
- **依赖声明**：`@deepseek-ai/cordis` 同时出现在 `peerDependencies` 与 `devDependencies`；每个 dsh 对等依赖都要在 `devDependencies` 镜像。
- **注册即 effect**：所有贡献经 `ctx.effect()` / `ctx.on()`；`register()` 返回 disposer，卸载时必须撤销。
- **模型可见即已记录**：任何进入模型请求的内容必须能从 session log 重建；新增模型可见输入必须配一条 session event。
- **不改内核**：新行为只能挂在文档化扩展点；`agent-loop` 不在修改范围内。
- **能力 seam 是三角**：Service Definition / Service Provider / Consumer 三者齐备，不能只做一角。
- **配置化**：部署相关参数必须是经校验的 `Config` 字段（schemastery），不能硬编码 `DEFAULT_*`。
- **显式优于隐式**：默认值在拥有者实现的 `resolve(request): Spec` 里显式发生，不能在 `run()` 里偷偷 `?? default`。
- **不透明 id 要 branded**：跨边界 id 用 `Branded<B>`（来自 `dsh-brand`），不用裸 `string`。
- **真实组合测试**：产品可见插件必须有走 Loader 的 REAL-composition 测试，不能只手搓 `ctx.plugin()`。
- **覆盖率**：CI 门禁为 `pnpm run test:coverage`（`packages/*/*/src` 逐文件 100%）。
- **Agent Note**：非 trivial 改动必须带一条 Agent Note。
- **UI 文案**：客户端 UI 文案走 typed dictionary（locale-owned），不能硬编码。
- **文件结尾**：恰好一个换行。
- **注册点**：新包要在 `tsconfig.host.json` 的 `references` 注册；源模式别名写在 `tsconfig.base.json` 生成区之外（本组包名与目录名不同名，无法自动生成）；新分组要同步更新 `packages/README.md` / `README.zh.md`、`scripts/verify-subsystem-pages.ts` 的分组白名单，并由生成器刷新 `docs/module-graph.*`。
- **文档分层**：`docs/` 受 tier、字数预算、双语配对门禁管理。本项目规划文档放仓库顶层 `ops/`，避免误触上游文档门禁。

## 3. 功能实现规格

### 3.1 `packages/ops/common`（共享类型）

- `ServerId` / `TargetId`：branded id。
- `Environment`：`dev | staging | prod | lab`。
- `RiskLevel`：`L0 | L1 | L2 | L3 | L4`。
- `OpsResult<T>` / `OpsError`：统一的成功与失败载体。

### 3.2 `packages/ops/server`（资产与服务器能力）

- **资产清单**：`Server { id, name, host, port, username, keyRef, environment, tags, enabled }`；清单来自 `Config`，`keyRef` 只存引用，不存私钥正文。
- **连接**：系统 OpenSSH 客户端（`ssh.exe`，Windows 10+ 自带；本机为 OpenSSH_for_Windows_9.5p1）；密钥认证；host key 校验；连接复用与超时由本包控制。
  - 选型原因：`pnpm-workspace.yaml` 的 `allowBuilds` 是严格白名单，`ssh2` 会拖入带安装脚本的 `cpu-features` / `nan`，不改上游文件就装不上；系统 OpenSSH 零新依赖，且直接复用用户已有的 key 与 known_hosts。
- **工具**：
  - `server_list`（L0，自动放行）
  - `server_facts`（L0）
  - `server_file_read`（L0，只读）
  - `server_exec`（按命令判定风险，L1+ 默认询问）
- **安全**：`tools/pre-execute` 做风险判定 → L0 放行 / L1+ 走 `ctx.approval`；无 answerer 时 fail-closed，不降级执行。
- **输出**：大输出走 `ctx.spillStore`（`spill-policy`）；结果含 `exitCode / stdout / stderr / durationMs / truncated`。
- **回放**：工具结果写入 session 可重建；动态上下文（当前 target / environment / risk）经 `ctx.systemPrompt` 注入，且必须可重建。
- **取消与超时**：支持 `AbortSignal` 与 `timeoutMs`。
- **对等依赖**：`@deepseek-ai/dsh-tools` 等声明为 peerDependencies，作为升级兼容性判定依据。

### 3.3 桌面集成

- ops 包作为 external plugin 挂进桌面 profile（`$DSH_HOME/profiles/desktop`）；开发期用 `pnpm run dev:desktop`。
- 出包用 `pnpm run package:desktop:win:x64:unsigned`（未签名、无自动更新）。
- 第一版不改 Web Client 布局；资产 / 风险 / 审批面板后续用 Slot 增加。

## 4. 完整开发顺序（完成后打勾）

- [x] Phase 0 冻结与基线：`pnpm install`、基线 `typecheck`、把 SHA 与版本写入本文件
- [x] Phase 1 骨架：`packages/ops/common` + `packages/ops/server` 目录与 manifest、`tsconfig.host.json` 注册、`packages/README.md` 分组更新、过 `pnpm run constraints`
- [x] Phase 2 共享类型：common 类型 + 单测（3 项通过）
- [x] Phase 3 资产与连接：清单加载 + OpenSSH 传输（参数构造、输出上限、超时、取消）+ 单测（13 项通过）
- [ ] Phase 4 只读工具：`server_list` / `server_facts`（两个工具均已实现；`server_list` 有真实组合测试，`server_facts` 待接真实 VPS 验收）
- [x] Phase 5 执行与审批：`server_exec` / `server_file_read` + 风险分级 + `ctx.approval` 接入
- [x] Phase 6 输出与生命周期：`ctx.spillStore` 截断、`timeoutMs`、`AbortSignal` 取消
- [x] Phase 7 回放与安全：session 回放一致性 + secret 泄漏校验
- [ ] Phase 8 契约文档：`packages/ops/AGENTS.md`（AI 工具接入约束）+ `ops/ARCHITECTURE.md` + `ops/ROADMAP.md`
- [ ] Phase 9 桌面集成：`dev:desktop` 跑通 + `package:desktop:win:x64:unsigned` 出包
- [ ] Phase 10 端到端验收：VPS 只读排查 nginx 502 + 审批后重启并复验

## 5. 验收标准

### 5.1 逐阶段验收

- **Phase 0**：`pnpm install` 成功；基线 `pnpm run typecheck` 通过。
- **Phase 1**：`pnpm run constraints` 通过；新包目录、manifest、README 结构符合上游 `adding-a-package` 清单。
- **Phase 2**：类型单测通过；`RiskLevel`、`Environment` 判别联合有 `assertNever` 收口。
- **Phase 3**：清单正确加载；错误凭证、不可达主机、超时都有明确错误，不退化为静默失败。
- **Phase 4**：`server_list` 返回正确清单；`server_facts` 取回 CPU / 内存 / 磁盘。
- **Phase 5**：L0 自动放行；L1+ 触发审批；审批拒绝时不执行；审批缺失时 fail-closed；结果中不含 secret。
- **Phase 6**：超大输出被截断并显式告知模型；`timeoutMs` 与取消都生效。
- **Phase 7**：新 session / replay 看到的 tool result 与原执行一致。
- **Phase 8**：`packages/ops/AGENTS.md` 存在且被根 `AGENTS.md` 或 packages 层级引用；架构与路线图文档与源码一致。
- **Phase 9**：`pnpm run dev:desktop` 能启动并加载 ops 插件；`package:desktop:win:x64:unsigned` 产出可安装、可启动的 Windows 包。
- **Phase 10**：两个端到端场景通过（见 5.2）。

### 5.2 端到端验收场景

测试环境：一台 Ubuntu VPS，SSH key 登录，专用测试机（非生产）。

场景 A（只读诊断）：

> "列出我的服务器，查看 web-01 的 CPU、内存、磁盘和 nginx 状态。只允许读，不要修改任何东西。"

期望：`server_list` → `server_facts` → 只读命令 → 基于证据回答；全程无写操作。

场景 B（受控变更）：

> "确认后端异常，帮我重启它。"

期望：识别精确目标 → 展示精确变更 → 触发审批 → 批准后执行 → 健康检查 → 报告；拒绝则不执行。

### 5.3 升级门禁（每次同步 upstream 前）

- [ ] `git fetch upstream` 并记录新 commit
- [ ] `pnpm install`
- [ ] `pnpm run typecheck`
- [ ] `packages/ops/*` 的目标测试
- [ ] `pnpm run build`
- [ ] 桌面 `dev:desktop` 冒烟
- [ ] 确认 ops 插件 peer 要求仍满足；不满足则先改插件再升级

## 6. 子代理分工

执行阶段按依赖顺序分配，同一文件不并发修改。

| 序号 | 任务 | 依赖 | 并行性 |
|---|---|---|---|
| 1 | Phase 0–1：基线验证、建包骨架、tsconfig 与分组注册、过 constraints | 无 | 串行第一 |
| 2 | Phase 8 文档：`packages/ops/AGENTS.md`、`ops/ARCHITECTURE.md`、`ops/ROADMAP.md` | 无（纯文档） | 与 1 并行 |
| 3 | Phase 2–7：common 类型、资产与连接、只读工具、执行与审批、输出与生命周期、回放与安全 | 1 | 串行 |
| 4 | Phase 9：桌面集成、dev:desktop、unsigned 打包与冒烟 | 3 | 串行 |
| 主控 | 调度、审查子代理产出、执行 Phase 10 端到端验收、汇总 | 全部 | 全程 |

## 7. 假设与默认

- 目标平台 Windows x64；应用名与图标先用占位，后续再定。
- VPS 为专用测试机（非生产），第一阶段默认只读，SSH 用 key 不用密码。
- 第一版不做自动更新与代码签名；更新通道与签名留到第二阶段，并按"插件先过验证再放行更新"的门禁执行。
- 规划文档（本文件及后续 `ops/*`）与代码分开：文档在仓库顶层 `ops/`，代码在 `packages/ops/*`。

## 8. 变更记录

- 2026-09-13：初版，基于 commit `c291e7961a515f6d7af9304e7fd1d257929aef26`。
- 2026-09-13：Phase 0/1 完成；传输选型由 `ssh2` 改为系统 OpenSSH（`allowBuilds` 白名单原因）。
- 2026-09-14：Phase 2 完成；`server_list` 工具落地，真实 Loader 组合测试 3 项通过；`pnpm run constraints` 与 `pnpm run typecheck` 通过。
- 2026-09-14：Phase 3 完成；新增 `src/ssh.ts` 传输层（系统 OpenSSH、输出上限、超时、取消）与 `server_facts` 工具；ops 测试 13 项通过，typecheck 通过。
- 2026-09-14：补齐 [ARCHITECTURE.md](ARCHITECTURE.md) 与 [ROADMAP.md](ROADMAP.md)；登记 `tsconfig.base.json` 源别名、`scripts/verify-subsystem-pages.ts` 分组白名单，并由生成器刷新 `docs/module-graph.*`。
- 2026-09-14：Phase 5 完成；新增 `src/risk.ts` 风险分级（只读 L0 / 变更按环境 L1–L3 / 破坏性 L4）、`tools/pre-execute` 门禁（L0 放行、L1+ 走审批）、`server_file_read` 与 `server_exec` 工具；审批三态走真实 Loader 组合测试（批准执行、拒绝不执行、缺失拒绝、无 agent、未知目标），ops 测试 38 项通过，constraints 与 typecheck 通过。
- 2026-09-14：Phase 6/7 完成；`spill.spec.ts` 走真实 Loader 组合验证超大 `server_list` 结果经 spill-policy + spill-local 落盘并替换为有界预览与取回定位符；`durability.spec.ts` 验证回放一致性（同调用字节级一致、结果可无损 JSON 重建、审批 `approval/asked`/`approval/decided` 成对落日志）与 secret 校验（keyRef 不出现在模型可见投影与会话事件）；ops 测试 44 项通过，constraints 与 typecheck 通过。`server_facts`/取消与超时的真实主机端到端验收待 VPS（Phase 10）。
