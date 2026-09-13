---
description: "DeepSeek Harness 运维能力中的被管服务器清单与面向模型的 server_list 工具，供用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-ops-server

[English](README.md) | 中文

## 概述

`dsh-ops-server` 给 agent 一份本部署所管理服务器的具名清单，让操作按稳定 id 寻址，而不是按模型猜出来的主机名。清单就是部署配置：每条声明服务器在哪、用哪个账号登录、解析哪个凭据引用、属于哪个环境。本包只提供只读工具；任何会改变目标的操作都在后续加入，并且必须经过审批。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

带上要管理的服务器挂载本插件，工具注册表就会暴露 `server_list`。

```yaml
- name: '@deepseek-ai/dsh-ops-server'
  config:
    servers:
      - id: prod-web-01
        name: Production web 01
        host: 203.0.113.10
        username: deploy
        keyRef: prod-web-01-key
        environment: prod
        tags: [nginx, edge]
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `servers` | 必填 | 本部署暴露的被管服务器 |
| `servers[].port` | `22` | SSH 端口 |
| `servers[].keyRef` | 必填 | 连接时解析的凭据引用，绝不是密钥正文 |
| `servers[].tags` | `[]` | 自由分组标签 |

<a id="model-experience"></a>
## 模型体验

### `server_list` 结果

#### 模型看到什么

工具 schema 与全部结果字段由本包提供：每台被管服务器的 `id`、`name`、`host`、`port`、`username`、`environment`、`tags`。凭据引用不出现在面向模型的投影中。

#### Token 影响

直接影响，与结果中被管服务器数量成正比。

#### KV Cache 影响

独立：工具描述是稳定前缀，结果进入请求历史。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- **只有只读清单** —— 连接服务器、读取 facts、读文件与执行命令随传输包一起加入。
- **清单不持久化** —— 清单来自组合配置；等出现第二个消费者再考虑存储。
- 不发布运行时 invariant 伴生包：清单是激活时解析一次的组合配置，本包不拥有可变状态，也没有可校验的跨事件关系。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：未决问题与尚未决定的方向。它明确不具权威性——已交付行为、限制与既定理由以上文和包代码为准。

远程传输走宿主机的 OpenSSH 客户端，而不是 JavaScript 的 SSH 实现：本工作区拒绝未经审查的依赖构建脚本，且宿主客户端已经持有用户的身份和 `known_hosts`。变更类工具只在审批链路就位之后才加入。

</details>
