# DeepSeek Harness — Ops Fork（运维二开版）

[English](README.md) | 中文

本仓库是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的私有二开分支。

它冻结在上游提交 `c291e7961a515f6d7af9304e7fd1d257929aef26`（`0.1.5-rc.2`），不追更上游；任何升级都是经过门禁的刻意动作（见 [ops/DEVELOPMENT.md](ops/DEVELOPMENT.md)）。

## 本分支新增内容

本分支以新增插件包的形式挂载运维能力，全部位于 `packages/ops`，不改任何上游包：

- `packages/ops/common` — 共享运维类型：目标标识、环境、风险等级、结果载体。
- `packages/ops/server` — 受管服务器清单与面向模型的工具：
  - `server_list` / `server_facts` / `server_file_read` — 只读，自动放行。
  - `server_exec` — 按风险分级：L0 只读命令自动放行；L1 及以上走审批 seam，审批缺失时 fail-closed。
- 远端传输使用宿主机 OpenSSH 客户端；凭据只存引用，绝不存值。

## 文档

- [ops/SETUP.md](ops/SETUP.md) — 本地环境、代理、凭据、已知问题
- [ops/DEVELOPMENT.md](ops/DEVELOPMENT.md) — 版本冻结、仓库约束、开发顺序、验收标准
- [ops/TASKS.md](ops/TASKS.md) — 全部开发点与当前进度
- [ops/ARCHITECTURE.md](ops/ARCHITECTURE.md) — 运维能力使用的 harness 扩展点，以及不采用的项
- [ops/ROADMAP.md](ops/ROADMAP.md) — 后续能力与各自验收
- [packages/ops/AGENTS.md](packages/ops/AGENTS.md) — 改动本组代码必须遵守的硬规则

上游 harness 文档仍保留在 `docs/` 供参考。

## 从源码运行

```sh
git clone https://github.com/YYY2579/opsdph.git deepseek-harness
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` 会准备仓库产物。`pnpm dsh web` 会直接使用这些已构建产物，不会重新构建。

## 开发

请先阅读 [ops/DEVELOPMENT.md](ops/DEVELOPMENT.md) 与 [ops/ARCHITECTURE.md](ops/ARCHITECTURE.md)。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
