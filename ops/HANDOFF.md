# 交接提示词

把下面整段直接发给接手的 AI 编码工具（或人）。它假设**在现有目录继续开发，不重新克隆**。

-----

你现在接手一个已经在进行中的项目，**在现有目录继续开发，不要重新克隆仓库**。

项目根目录：`C:\Users\25791\Desktop\agent\deepseek-harness`
当前分支：`feature/ops`（跟踪 `origin/main`，私有远端 `https://github.com/YYY2579/opsdph`）
上游：`https://github.com/deepseek-ai/deepseek-harness`，冻结在 commit `c291e7961a515f6d7af9304e7fd1d257929aef26`，不要追更。

开工前按顺序读完这五份：

1. `ops/SETUP.md` —— 环境、代理、凭据用法、已知问题
2. `ops/DEVELOPMENT.md` —— 版本冻结、仓库约束、开发顺序、验收标准
3. `ops/TASKS.md` —— 全部开发点与当前进度
4. `ops/ARCHITECTURE.md` —— 能力挂在哪些扩展点上，以及哪些不能用
5. `packages/ops/AGENTS.md` —— 改动本组代码时必须遵守的硬规则

当前状态：

- 已完成：`packages/ops` 分组（`common` + `server`）、`server_list` 与 `server_facts` 工具、系统 OpenSSH 传输层（参数构造、输出字节上限、超时、取消）、13 项测试通过、`pnpm run constraints` 与 `pnpm run typecheck` 通过。
- 下一步按序做 D 组：风险分级 L0–L4 判定 → `tools/pre-execute` 风险门禁 → `ctx.approval` 审批接入（缺失 answerer 时 fail-closed）→ `server_file_read` / `server_exec` 工具 → 审批三态测试（批准执行、拒绝不执行、缺失拒绝）。

硬规则，违反即返工：

- 只新增或修改 `packages/ops/*` 与 `ops/*`。不改上游任何包：`core`、`shell`、`fs`、`subprocess`、`interaction`、`client`、`apps`。
- 不要用 `ctx.subprocess`、`ctx.shell`、`ctx.fs` 去执行运维命令。它们是单 provider seam，服务的是 agent 自身在哪里运行，不是它去管哪些机器；运维传输用本组自己的实现。
- 风险分级固定为 L0 只读（自动放行）、L1 及以上（必须审批）。审批服务缺失或异常一律 fail-closed，绝不降级执行。
- 决策必须落在做决定的那一步。schema 省略、工具描述、提示词都不是强制手段；一次拒绝要能在执行器里被验证。
- 凭据只存引用。私钥、密码、token 不得进入配置值、工具结果、会话事件或日志；面向目标的模型可见投影要省略凭据引用。
- 所有输出都必须有上限（字节、行、条数、时间），被截断时必须在给模型的结果里明确说明。
- 部署相关参数必须是经校验的 `Config` 字段，不能硬编码常量。
- 任何进入模型请求的内容都必须能从会话日志重建。

改动后按序验证，并且只报告真正跑过的检查：

```sh
pnpm run constraints
pnpm exec vitest run packages/ops
pnpm run typecheck
```

产品可见的插件必须有走真实 Loader 的组合测试（启动 `cordis.yml`），手搓 `ctx.plugin()` 的测试不算。

提交与推送：

- 提交信息用 `feat(ops): …`、`fix(ops): …` 或 `docs(ops): …`。
- git 不会自动读 Windows 系统代理，本仓库已配好 `http.proxy=http://127.0.0.1:7897`（Clash）。若报 `Failed to connect to github.com:443` 而 `curl` 能访问 `api.github.com`，就是代理掉了。
- 推送用一次性请求头，绝不把 token 写进任何会被提交的文件，也不用第三方加速镜像：

```powershell
$tok = (Get-Content '<token 文件路径>' -Raw).Trim()
$b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$tok"))
git -c "http.extraHeader=Authorization: Basic $b64" push --no-verify origin feature/ops:main
```

- 加 `--no-verify` 是因为 lefthook 的 pre-push 钩子在 Git bash 里找不到 pnpm。这属于环境问题，不是检查失败；所以推送前必须自己手动跑过上面那三条验证。

现在先读完文档，然后用几句话复述你理解的任务范围与第一个要改的文件，确认无误后再动手。
