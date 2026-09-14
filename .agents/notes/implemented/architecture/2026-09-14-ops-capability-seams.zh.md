# Agent Note: 运维能力使用 harness 的 seam，而非单 provider 传输层

Status: implemented

[English](2026-09-14-ops-capability-seams.md) | 中文

## Problem

本分支为 DeepSeek Harness 增加运维能力：一批受管服务器，agent 从中读取数据，并在审批后执行变更。两条架构张力并存。harness 提供了 `ctx.subprocess`、`ctx.shell`、`ctx.fs` 这些单 provider seam；一种直觉是把远端执行挂在它们上面。但每个 seam 都是单 provider——每个组合只能挂一个实现，加载第二个会快速失败——而且它们描述的是 *agent 自身在哪里运行*，不是 *它去管哪些机器*。运维要同时面对多个目标，不能把所有执行都搬进一个运行时。

风险策略必须真实，而非表面功夫。任务约束"任何变更都要询问，缺失审批绝不执行"除非拒绝能被执行器证明，否则没有分量；schema 省略、工具描述、提示词都不是强制手段。

## Decision

运维能力放在新增的 fork 本地包 `packages/ops/common` 与 `packages/ops/server`，只注册在文档化的 harness 扩展点上：`ctx.tools` 注册面向模型的工具，`tools/pre-execute` 做风险判定，`ctx.approval` 做一次性授权，`ctx.spillStore` + `spill-policy` 处理超大输出，`ctx.systemPrompt` 与会话事件承载可重建的模型可见上下文。不改任何上游包，只碰注册点。

远端执行不使用 `ctx.subprocess`、`ctx.shell`、`ctx.fs`。server 包自带传输层，走宿主机 OpenSSH 客户端（`ssh.exe`）：参数构造受 `BatchMode=yes` 约束、保留输出有字节上限、硬 `timeoutMs`、`AbortSignal` 取消。"agent 在哪儿运行"留给 harness 的 seam；"agent 去管哪些机器"由本组的自己的传输层负责。凭据只存引用：清单携带 `keyRef` 路径，绝不携带密钥正文，模型可见投影省略它们。

风险分级是纯函数 `classifyCommandRisk(command, environment)`（`packages/ops/server/src/risk.ts`）：可证明只读的命令为 `L0`；变更按环境升级（`dev`/`lab` `L1`、`staging` `L2`、`prod` `L3`）；破坏性模式恒为 `L4`。server 插件里的 `tools/pre-execute` listener 是唯一的强制点：非运维工具经 `next()` 放行，`server_list` / `server_facts` / `server_file_read` 直接通过，未知运维工具拒绝，对 `server_exec` 除非命令判为 `L0` 否则返回 `{ kind: 'ask', reason }`。工具运行时的 `serviceAsk` 会把该 `ask` 变成拒绝，除非审批服务返回 `allowed-once`；审批服务、answerer 或 agent 缺失时同样拒绝——fail-closed 是 registry 的行为，不是本插件的兜底。

每个结果都有上界。传输层按 `maxOutputBytes` 截断保留的 stdout 并置 `truncated: true`；超大结果经组合内的 `dsh-spill-policy` + `dsh-spill-local` 落盘，模型只看到有界预览加定位符。`server_exec` 在执行前再判子类，被否决不执行。

## 测试

套件通过真实 Loader 从 `cordis.yml` 启动插件——不手搓 `ctx.plugin()`。覆盖：清单列举不泄露凭据、L0–L4 分级器、审批三态（批准执行、拒绝不执行、缺失 answerer fail-closed）外加无 agent 与未知目标路径、超大结果落盘、session 回放一致性与 `approval/asked`/`approval/decided` 配对、模型可见输出不含凭据引用。可选 `tests/e2e-vps.spec.ts` 在设置 `OPS_E2E_HOST` 时对真实主机跑同一套面。

## Alternatives considered

**把远端执行挂在 `ctx.subprocess` / `ctx.shell` / `ctx.fs` 上。** 这些是单 provider seam：每个组合只加载一个实现，第二个快速失败。它们回答"agent 自身在哪里运行"——本地、E2B、某台远端机——而非"这份部署去管哪些机器"，后者必须同时面对多个目标。把运维走这几个 seam 会collapse把所有受管执行压进 agent 自己的运行时，并破坏多目标清单。任务因此禁止把它们用于运维执行。

**使用 JS 版 SSH 依赖（`ssh2`）。** `ssh2` 会拖入带安装脚本的 `cpu-features` / `nan`，而 `pnpm-workspace.yaml` 的严格 `allowBuilds` 白名单不改上游文件就装不上。系统 OpenSSH 零新依赖，并直接复用用户已有的 identity 与 `known_hosts`。

**用 schema、工具描述、提示词来执行风险。** 三者都不能被"执行该工具"证明：schema 省略某个字段，但直接调用仍会到达 execute；提示词只是建议。`tools/pre-execute` listener 返回的决策由 registry 强制，因此拒绝在执行器里可见。

**在插件里自己实现 fail-closed 而不依赖 registry。** 返回 `ask`、由工具运行时解析，保持单一强制点。插件若重写拒绝逻辑，就要复刻审批词汇，并可能偏离 registry 的取消/失败契约。

## Consequences

面向模型的工具获得可证明性：被用户拒绝的变更 `server_exec` 会如实返回错误；没有审批服务或 answerer 的组合会拒绝而非运行。代价是传输层由仓库自持：参数构造、上限、超时、取消都是本组的代码，而非某个被维护 seam 的，改动必须过本组测试。

从自由文本读取风险是启发式边界：分级器把任何无法证明只读的命令当作变更，让环境把无害用例交给人工检查，而不是冒一次未察觉写入的风险。这一偏向让 L4 与破坏性模式先行 fail-closed，并在 `ops/ARCHITECTURE.md` 记录该边界。

新增一个面向模型的运维工具，现在必须三处同动：在 `ctx.tools` 注册、在 `tools/pre-execute` listener 里分类其风险贡献、投影其输出且不带凭据引用。这正是文档化"模型可见 ⟺ 已记录"规则在新 seam 产物上的体现。