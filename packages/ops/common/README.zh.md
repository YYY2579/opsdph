---
description: "DeepSeek Harness 运维能力共享的领域类型：目标标识、环境、风险等级与结果载体，供能力作者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-ops-common

[English](README.md) | 中文

## 概述

`dsh-ops-common` 保存所有运维能力共享的词汇：一个被管目标用什么标识、属于哪个环境、一次操作有多危险、以及操作如何报告成功与失败。它不拥有任何服务、工具或状态；各能力包依赖它，使服务器、容器与数据库目标说同一种语言。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在运维能力包中依赖本包。用 `brandServerId` 构造目标标识，使服务器 id 不会被误传到需要其他 id 的位置；用 `ENVIRONMENTS` 与 `RISK_LEVELS` 收敛配置取值；每次操作都返回一个 `OpsResult`，让调用方统一处理失败。

<a id="model-experience"></a>
## 模型体验

### 清单与风险词汇

#### 模型看到什么

不直接看到任何内容。`ServerId`、`Environment`、`RiskLevel` 与 `OpsResult` 这套词汇塑造能力包发布的工具 schema 与结果载体；只有当某个能力包把这些字段包含进去时，模型才会看到它们。

#### Token 影响

无直接影响。

#### KV Cache 影响

无直接影响。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **缺少容器、集群与数据库标识** —— 目前只有 `ServerId`；后续能力在本包补充各自的 branded id，而不是每个包各造一个。
- 不发布运行时 invariant 伴生包：本包只声明共享类型与一个 branding helper，不拥有可校验的运行时关系。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：未决问题与尚未决定的方向。它明确不具权威性——已交付行为、限制与既定理由以上文和包代码为准。

这里的词汇只在第二个能力也需要同一个词时才增加。容器、集群与数据库的工作会决定下一批新增项；本包不会预先声明还没有消费者的标识。

</details>
