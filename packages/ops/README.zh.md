---
description: "ops 组地图：DeepSeek Harness fork 的被管目标清单与面向模型的运维工具，供浏览本组的用户与维护者阅读。"
kind: "package-group"
---

# packages/ops

[English](README.md) | 中文

## 概述

ops 组为 harness 增加运维能力：一份被管目标清单（先做服务器，后续扩展到容器、集群与数据库），以及作用于这些目标的面向模型的工具，并带有明确的风险分级与审批。目标是部署配置，每次操作都按稳定 id 指定唯一目标，模型不会去猜自己动的是哪台机器。本组只新增能力包，不改动任何核心包。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx key |
|---|---|---|
| [`common`](common/README.zh.md) | 共享运维领域类型：目标标识、环境、风险等级与结果载体 | — |
| [`server`](server/README.zh.md) | 被管服务器清单与面向模型的 `server_list` 工具 | 注册在 `ctx.tools` |

-----

<a id="related-documentation"></a>
## 相关文档

- [Ops 开发文档](../../ops/DEVELOPMENT.md) —— 版本冻结、仓库约束、开发顺序与验收标准。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>面向维护者的工作背景——点击展开</summary>

本组是 fork 本地新增内容，不属于上游 DeepSeek Harness。

</details>
