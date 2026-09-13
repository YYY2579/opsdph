# 本地环境与交接说明

换客户端或换机器继续开发时，照着这份把环境重建即可。仓库里的代码与文档是唯一事实来源；本地环境不进仓库。

## 版本

| 项 | 值 |
|---|---|
| 上游 commit | `c291e7961a515f6d7af9304e7fd1d257929aef26` |
| 上游版本 | `0.1.5-rc.2` |
| Node | `^22.19.0 || >=24.0.0`（验证时用 v24.19.0） |
| pnpm | `11.7.0`（`packageManager` 固定；验证时实际用 11.19.0） |
| git | 2.55.0 |

## 首次搭建

```sh
git clone https://github.com/YYY2579/opsdph.git deepseek-harness
cd deepseek-harness
git remote add upstream https://github.com/deepseek-ai/deepseek-harness.git
pnpm install --fetch-timeout 600000
```

`--fetch-timeout` 不是可有可无：默认超时会在拉取子代理依赖（`@openai/codex`、`@anthropic-ai/claude-agent-sdk`）时中断整次安装。

## 网络

本机用 Clash 系统代理（`127.0.0.1:7897`）。git 不会自动读取 Windows 系统代理，因此需要按仓库配置：

```sh
git config --local http.proxy http://127.0.0.1:7897
git config --local https.proxy http://127.0.0.1:7897
```

症状对照：`curl` 能访问 `api.github.com` 但 `git` 报 `Failed to connect to github.com:443`，就是漏了这一步。

## 凭据

推送需要一个对 `YYY2579/opsdph` 有写权限的 GitHub token。**不要把 token 写进仓库、`.git/config`、脚本或任何会被提交的文件**；也不要用第三方加速镜像推送，那等于把 token 交给对方。

推荐用 fine-grained token，只授权这一个仓库、只给 `Contents: Read and write`。推送时用一次性请求头，不落盘：

```sh
# PowerShell：token 从本地文件读入变量，不进入命令历史
$tok = (Get-Content '<token 文件路径>' -Raw).Trim()
$b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$tok"))
git -c "http.extraHeader=Authorization: Basic $b64" push --no-verify origin feature/ops:main
```

## 已知环境问题

lefthook 的 `pre-push` 钩子会用 Git 的 bash 运行 `pnpm run typecheck`，而那个 bash 的 `PATH` 里没有 pnpm，于是报 `pnpm: command not found` 并阻断推送。这不是检查失败。两个选择：推送时加 `--no-verify`（当前做法，推送前手动跑过检查），或者把 pnpm 目录加进钩子的 `PATH`。

## 常用命令

```sh
pnpm run constraints              # 工作区包不变式
pnpm exec vitest run packages/ops # 本组测试
pnpm run typecheck                # 全仓类型检查与 host 构建
pnpm run dev:desktop              # 桌面端开发（尚未接入 ops 插件）
```

## 从哪读起

1. [`DEVELOPMENT.md`](DEVELOPMENT.md) —— 版本冻结、仓库约束、开发顺序、验收标准
2. [`TASKS.md`](TASKS.md) —— 全部开发点与当前进度
3. [`ARCHITECTURE.md`](ARCHITECTURE.md) —— 能力挂在哪些扩展点上，以及不采用的项及其原因
4. [`ROADMAP.md`](ROADMAP.md) —— 后续能力与各自验收标准
5. [`../packages/ops/AGENTS.md`](../packages/ops/AGENTS.md) —— 改动本组代码时必须遵守的规则
