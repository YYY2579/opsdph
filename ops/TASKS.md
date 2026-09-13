# 开发任务总清单

本文是全部开发点的汇总勾选表；范围与顺序的权威说明在 [DEVELOPMENT.md](DEVELOPMENT.md)，后续能力的目标与验收在 [ROADMAP.md](ROADMAP.md)。

更新于 2026-09-14，对应当前提交。

## A. 基础设施

- [x] 冻结上游 commit（`c291e7961a515f6d7af9304e7fd1d257929aef26`）并记录 SHA
- [x] 克隆仓库、建分支 `feature/ops`、配置 `upstream`
- [x] `pnpm install`（5m03s，pnpm 11.19.0）
- [x] 基线 `pnpm run typecheck` 通过
- [x] 建 `packages/ops` 分组与 `common` / `server` 两个包骨架
- [x] 注册 `tsconfig.host.json` references 与 `tsconfig.base.json` 源别名
- [x] 更新 `packages/README.md` / `README.zh.md` 分组表与子系统页白名单
- [x] `pnpm run constraints` 通过
- [x] 推送自己的仓库 `YYY2579/opsdph`（默认分支 `main`）

## B. common（共享类型）

- [x] `Environment` / `RiskLevel` / `ServerId` / `OpsServer` 类型
- [x] `OpsResult` / `OpsError` 结果载体
- [x] `brandServerId` 标识构造
- [x] `ENVIRONMENTS` / `RISK_LEVELS` 运行时集合与单测

## C. server 资产与只读工具

- [x] 资产清单配置（id / name / host / port / username / keyRef / environment / tags）
- [x] `server_list` 工具
- [x] `server_list` 真实 Loader 组合测试（清单、环境过滤、缺配置加载失败、不泄露凭据引用）
- [x] OpenSSH 传输层（参数构造、输出字节上限、超时、取消）
- [x] 传输层单测（参数、截断、超时、取消）
- [x] `server_facts` 工具实现
- [ ] `server_facts` 接真实 VPS 端到端验收
- [ ] `server_file_read` 工具（只读、行数与字节上限）
- [ ] `server_exec` 工具（按命令判定风险）

## D. 安全与生命周期

- [ ] 风险分级 L0–L4 判定规则
- [ ] `tools/pre-execute` 风险门禁
- [ ] `ctx.approval` 审批接入（缺失 answerer 时 fail-closed）
- [ ] 审批三态测试：批准执行、拒绝不执行、缺失拒绝
- [ ] `ctx.spillStore` 大输出落盘对接
- [ ] session 回放一致性测试
- [ ] secret 不出现在模型可见结果的校验
- [ ] 取消与超时的端到端验证（真实主机）

## E. 契约与文档

- [x] `ops/DEVELOPMENT.md`（版本冻结、约束、顺序、验收）
- [x] `ops/ARCHITECTURE.md`（扩展点映射与不采用项的原因）
- [x] `ops/ROADMAP.md`（后续能力槽位与验收）
- [x] `ops/TASKS.md`（本清单）
- [x] `packages/ops/AGENTS.md`（给后续 AI 编码工具的接入约束）
- [x] `ops/SETUP.md`（本地环境、代理、凭据与已知问题，供换客户端或换机器时重建）
- [x] `ops/HANDOFF.md`（交给其他人或其他 AI 工具直接上手的提示词）
- [ ] 包 README 通过上游 Model Experience 与 limitations 门禁
- [ ] 非 trivial 改动补 Agent Note

## F. 桌面与交付

- [ ] 把 ops 包挂进桌面 profile（external plugin）
- [ ] `pnpm run dev:desktop` 跑通并加载 ops 插件
- [ ] `pnpm run package:desktop:win:x64:unsigned` 出安装包
- [ ] 应用名与图标替换为最终品牌
- [ ] 自建更新源与代码签名（第二阶段）

## G. 端到端验收

- [ ] 场景 A：只读排查"web-01 的 nginx 502"，全程无写入
- [ ] 场景 B：审批后重启后端并复验
- [ ] 升级门禁演练：兼容升级插件保留、peer 不匹配时停用并报错

## H. 后续能力（见 ROADMAP.md）

- [ ] Docker 能力
- [ ] Kubernetes 能力
- [ ] MySQL / Redis 能力
- [ ] Prometheus 与日志能力
- [ ] 诊断技能（nginx-502 / crashloop / 慢查询等）
- [ ] 安全修复（受控变更链路）
- [ ] 运维 UI 面板
- [ ] 桌面自动更新与签名
