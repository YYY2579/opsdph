# Ops 能力路线图与验收标准

原则：**一次做完一个完整能力**——每个能力都必须带工具、风险分级、测试、文档与验收，做完再开下一个。不预建空包。

第一阶段（Server/资产）正在实现中，详见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 1. Server / 资产（第一阶段）

**目标**：让 agent 认识本部署管理的服务器，并做只读诊断与受控变更。

**工具清单**：`server_list`、`server_facts`、`server_file_read`、`server_exec`。

**风险要点**：`server_list` / `server_facts` / `server_file_read` 为 L0 自动放行；`server_exec` 按命令判定，凡可能改变目标状态的默认 L1+，走审批。

**前置依赖**：无（当前能力）。

**验收标准**：
- [ ] `server_list` 返回配置清单，且不暴露凭据引用
- [ ] `server_facts` 在真实 Linux 主机上取回 OS、uptime、内存、磁盘、负载
- [ ] `server_file_read` 只读读取指定文件，带行数与字节上限
- [ ] `server_exec` 对 L1+ 触发审批，拒绝时不执行
- [ ] 输出超限时落盘并显式告知模型被截断
- [ ] 超时与取消都能真正终止远端命令

## 2. Docker

**目标**：从"主机"深入"主机上的容器"，支撑容器化服务的故障定位。

**工具清单**：`docker_list`、`docker_inspect`、`docker_logs`、`docker_stats`，之后才是 `docker_exec`、`docker_restart`、`docker_stop`。

**风险要点**：`list/inspect/logs/stats` 为 L0；`exec` 按命令判定；`restart`/`stop` 默认 L2，必须审批。

**前置依赖**：Server 能力稳定（目标解析、传输、审批链路可复用）。

**验收标准**：
- [ ] 列出容器并带状态、镜像、端口
- [ ] 日志查询支持时间窗口与行数上限
- [ ] 容器 inspect 只回传诊断需要的字段，不返回原始大 JSON
- [ ] 重启前展示精确目标与预期影响，批准后执行并复验

## 3. Kubernetes

**目标**：从主机与容器进一步进入集群工作负载诊断。

**工具清单**：`k8s_cluster_list`、`k8s_namespace_list`、`k8s_pod_list`、`k8s_pod_get`、`k8s_pod_logs`、`k8s_pod_describe`、`k8s_deployment_list`、`k8s_deployment_get`、`k8s_service_list`、`k8s_event_list`、`k8s_rollout_status`；第二轮 `k8s_pod_exec`、`k8s_rollout_restart`、`k8s_scale`；第三轮 `k8s_apply`、`k8s_patch`、`k8s_delete`。

**风险要点**：查询类 L0；`exec` L1/L2；`delete pod` / `rollout restart` L2；`scale` L2/L3；`patch` / `apply` L3；删除工作负载 L4。

**前置依赖**：Server 能力；集群凭据引用机制。

**验收标准**：
- [ ] 任何操作都必须显式带 `clusterId` 与 `namespace`，不允许模型猜
- [ ] CrashLoopBackOff / ImagePullBackOff / 就绪探针失败三类场景能给出基于证据的结论
- [ ] 所有变更走审批，批准后执行并复验

## 4. MySQL / Redis

**目标**：只读诊断数据库与缓存，写操作最后做。

**工具清单**：MySQL —— `mysql_status`、`mysql_databases`、`mysql_tables`、`mysql_describe_table`、`mysql_query_readonly`、`mysql_processlist`、`mysql_innodb_status`；Redis —— `redis_info`、`redis_dbsize`、`redis_get`、`redis_ttl`、`redis_type`、`redis_memory`、`redis_clients`。

**风险要点**：默认只读；`DROP`/`TRUNCATE`/`UPDATE`/`DELETE`/`FLUSHDB`/`CONFIG SET` 默认不开放；禁止默认执行 `KEYS *`，改用受限 `SCAN`。

**前置依赖**：Server 能力；凭据引用机制。

**验收标准**：
- [ ] 只读查询在**工具层**强制，而不是靠提示词约束
- [ ] 查询有行数与时间上限，超限显式告知
- [ ] 数据库口令永不出现在模型可见结果中

## 5. Prometheus / 日志

**目标**：把指标与日志纳入证据链，支撑"过去 15 分钟变慢了"这类问题。

**工具清单**：`metrics_query`、`metrics_query_range`、`metrics_labels`、`metrics_series`、`metrics_targets`；日志统一抽象 `LogQuery { source, target, start, end, query?, limit }`，先接 systemd、Docker、K8s，再接 Loki。

**风险要点**：全部只读（L0）；重点在**限额**而不是授权。

**前置依赖**：Server、Docker、K8s 能力中的至少两条（用于交叉验证）。

**验收标准**：
- [ ] 指标查询有 series 数上限，日志查询有时间窗与行数上限
- [ ] 模型收到的是整理后的结论性指标，而不是大段原始 JSON
- [ ] 能把指标异常与日志异常在时间线上对齐

## 6. 诊断技能（Skills）

**目标**：把"怎么查"沉淀为可复用技能，而不是塞进巨型 system prompt。

**工具清单**：不是工具，是技能包：`nginx-502-diagnosis`、`linux-disk-full`、`kubernetes-crashloop`、`kubernetes-imagepullbackoff`、`mysql-slow-query`、`redis-memory-pressure`。

**风险要点**：技能只描述诊断目标、常见证据、建议工具顺序、停止条件与危险操作。

**前置依赖**：Server / Docker / K8s / DB 能力可用。

**验收标准**：
- [ ] 每个技能能被模型按名加载，且内容不重复 tool 描述
- [ ] 技能给出的工具顺序在真实故障场景里可复现
- [ ] 技能明确写出停止条件，避免无休止深挖

## 7. 安全修复（Repair）

**目标**：从"会诊断"走到"能受控地修"。

**工具清单**：第一批 —— 重启服务、重启容器、`k8s rollout restart`、扩容/缩容；暂缓 —— 防火墙、DNS、数据库写入、集群级变更。

**风险要点**：不允许无限制自动修复；固定链路为 诊断 → 变更提案 → 用户批准 → 执行 → 复验 → 成功或回滚建议。

**前置依赖**：审批链路稳定；端到端只读诊断已经跑通。

**验收标准**：
- [ ] 变更提案包含精确目标、精确动作、预期影响与风险等级
- [ ] 批准前不执行；执行后必须有复验与结论
- [ ] 失败路径给出回滚建议

## 8. 运维 UI 面板（后置）

**目标**：把资产、风险与审批状态呈现出来，但不改变"Chat 是主交互"的定位。

**工具清单**：不是工具，是 UI 扩展：左侧 Servers / Databases / Kubernetes / Monitoring，右侧 Target / Environment / Risk / Tool Calls / Approval State。

**风险要点**：UI 通过正式 Client/Slot/Remote 通道取数，不直接访问 Host 内部状态。

**前置依赖**：后端能力稳定（先有数据，再谈呈现）。

**验收标准**：
- [ ] 不重写上游 Web Client 壳
- [ ] 资产与审批状态来自持久事件，刷新后一致

## 9. 桌面打包与更新（后置）

**目标**：产出可自更新的 Windows 桌面应用，且更新不破坏已安装的运维插件。

**工具清单**：不是工具，是发布链路：`package:desktop:win:x64`、自建更新源、代码签名。

**风险要点**：插件必须声明 peerDependencies（版本范围），桌面端升级时据此判定兼容；破坏性升级前必须先让插件通过验证。

**前置依赖**：运维能力在开发模式下稳定可用。

**验收标准**：
- [ ] 未签名安装包能在本机安装并启动，且加载 ops 插件
- [ ] 模拟兼容升级：插件文件、配置、版本保留，启动正常加载
- [ ] 模拟 peer 不匹配：插件停用并报错，不静默降级
