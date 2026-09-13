# Ops 架构：能力与扩展点映射

本文件说明运维能力挂在 harness 的哪些扩展点上、为什么这样挂，以及哪些扩展点**不能**用。落地范围与顺序见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 一句话定位

Harness 继续做通用工程 Agent（编码、文件、终端、Web、推理、会话），运维能力作为**新增插件包**挂上去；不改任何核心包，因此可以持续从上游同步。

## 复用的扩展点

| 扩展点 | 它负责什么 | 运维能力怎么用 |
|---|---|---|
| `ctx.tools` | 工具注册与受保护的执行流水线 | 所有面向模型的运维工具都在这里注册，拿到统一的调用、结果、展示与取消语义 |
| `tools/pre-execute` waterfall | 逐次调用的策略决策点 | 判定本次调用的风险等级，返回放行、拒绝或询问；这是风险控制的**唯一**执行点 |
| `ctx.approval` | 一次性人工审批（`ask` → answerer） | 有变更的调用在这里拿授权；**缺失 answerer 时 fail-closed**，绝不降级执行 |
| `ctx.spillStore` + `spill-policy` | 超大工具输出落盘并返回检索定位符 | 远端命令输出超过阈值时自动落盘，模型只看到有界预览与取回方式 |
| `ctx.systemPrompt` | 动态上下文注入（且可由会话日志重建） | 注入当前 target、环境、约束、审批策略等运维上下文 |
| `ctx.storage` | 非会话存储枢纽 | 后续用于持久化资产清单；第一阶段清单来自部署配置 |
| `ctx.skills` | 技能提供方注册 | 后续承载 nginx-502、K8s CrashLoop 等诊断套路 |
| `ctx.workflowEngine` | 可重复的多步流程引擎 | 后续承载诊断/修复流程编排 |
| `ctx.credentials` + `ctx.authorization` | 凭据引用与人工授权流 | 后续把 `keyRef` 从文件路径升级为凭据引用解析 |
| `ctx.jobs` | 后台任务登记与查询 | 后续：超过前台时限的运维操作登记为作业 |

## 不复用的扩展点，以及原因

`ctx.subprocess`、`ctx.shell`、`ctx.fs` **不用于运维执行**。

原因是它们是**单 provider** 的能力：每个组合只能挂一个实现（`ctx.subprocess` 的 README 明确写着"每个组合配置一个 subprocess 实现……加载第二个提供方会快速失败"）。它们服务的是 **Agent 自身的执行环境**——把整个 agent 放到本地、E2B 沙箱或某台远端机器上运行。而运维能力要同时面对多台被管机器，不能把所有执行都搬到一个环境里，因此必须自带传输层（系统 OpenSSH）。

结论写成一句：**「Agent 在哪运行」用 harness 的 seam；「Agent 去管哪些机器」用自己的运维传输。**

## 数据流

```text
模型
  ↓ 工具调用（server_list / server_facts / …）
ctx.tools 受保护执行流水线
  ↓ tools/pre-execute：判定风险等级
  ├─ L0 只读 → 放行
  └─ L1+ 变更 → ctx.approval 询问
        ├─ 批准 → 继续
        └─ 拒绝 / 无 answerer → 终止（fail-closed）
  ↓ 运维传输层（系统 OpenSSH：目标、超时、取消）
  ↓ 结果规范化（exitCode / stdout / stderr / durationMs / truncated）
  ↓ 大输出经 ctx.spillStore 落盘并替换为有界预览
  ↓ 写入 session event
  ↓ 模型可见内容可回放重建
```

## 必须遵守的仓库约束

这些来自上游根 `AGENTS.md`、`packages/AGENTS.md`、`docs/AGENTS.md`：

- **注册即 effect**：所有贡献经 `ctx.effect()` / `ctx.on()`，`register()` 返回 disposer，卸载时撤销。
- **模型可见即已记录**：任何进入模型请求的内容必须能从会话日志重建；新增模型可见输入必须配一条 session event。
- **不改内核**：新行为只能挂在文档化扩展点；`agent-loop` 不在修改范围内。
- **能力 seam 是三角**：Service Definition / Service Provider / Consumer 三者齐备。
- **配置化**：部署相关参数必须是经校验的 `Config` 字段，不能硬编码 `DEFAULT_*`。
- **显式优于隐式**：默认值在拥有者实现的 `resolve(request): Spec` 阶段显式发生。
- **不透明 id 要 branded**：跨边界 id 用 `Branded<B>`，不用裸 `string`。
- **真实组合测试**：产品可见插件必须有走 Loader 的真实组合测试。
- **把变更判定放在做决定的那一步**：schema 省略、prompt 过滤、包装层都不是强制手段；拒绝必须能在执行器里被验证。
- **非 trivial 改动带 Agent Note**，文档与源码同批更新。

## 与上游同步的关系

因为只新增 `packages/ops/*` 与 `ops/*`，并只在上游的注册点（`tsconfig.host.json` 的 `references`、`tsconfig.base.json` 的源别名、`packages/README.md` 分组表、`scripts/verify-subsystem-pages.ts` 的分组白名单）做必要登记，所以同步上游的代价被限制在"重新登记一次"，而不需要理解或合并核心逻辑改动。升级门禁见 [DEVELOPMENT.md](DEVELOPMENT.md) 第 5.3 节。
