# Alook Community 是否应改用 Matrix

日期：2026-09-13。性质：架构调研与决策建议，不是迁移实现。

## 建议

**当前不建议整体替换。保留 Community 通讯底层，完成已确认的正确性修复，并测量收发链路。** Matrix 值得作为协议设计参考；只有当外部 Matrix 互通、客户自托管或端到端加密成为明确产品目标时，才值得投入替换验证。

理由不是“自研一定更快”，而是这次替换能省掉的通用通讯工作，与仍须保留的 Alook 产品规则不重合。现在用 Matrix 解决几个事务和重试缺陷，会同时引入身份映射、权限映射、历史迁移及独立服务运维。没有实测证据证明这些代价能换来更低延迟或更低总成本。

这里按“用 Matrix 替换 Alook 自有 IM 底层”理解需求。Matrix 是协议；Synapse 是本文评估的一个实际 homeserver 实现，Element 是客户端及相关产品生态。部署 Synapse 不等于必须换成 Element 界面，也不等于必须向公网开放 federation。[Matrix 组件说明](https://matrix.org/docs/matrix-concepts/elements-of-matrix/)、[Synapse 项目](https://github.com/element-hq/synapse)、[联邦范围配置](https://element-hq.github.io/synapse/latest/usage/configuration/config_documentation.html#federation_domain_whitelist)。

## 证据范围

- Alook 代码固定在 `71677ac8d2c99078a0ffff4f7cb8cded23fbf27d`，仅评估 Community；旧 workspace/conversation 不纳入成本判断。
- Matrix 查阅当日稳定规范入口（页面标示 v1.19）、官方概念文档、Application Service API 和 Synapse 运维文档。`latest` 文档会继续变化；协议版本依据见 [v1.19](https://spec.matrix.org/v1.19/)。
- [PR #781](https://github.com/alookai/alook/pull/781) 正在修复收发正确性，后续还会变化；本文不把基线缺陷描述为修复后的事实，也不独立认证该 PR。
- 已完成静态代码与规范对照；未部署 Synapse、迁移历史、压测或检查生产故障率。下文成本是分析模型，不是账单或基准测试结果。

## 当前已经有什么

Community 的核心已是 user、channel、message 和成员关系，无需为了获得这几个抽象而迁移。

| 代码事实 | 固定基线证据 |
| --- | --- |
| human 与 bot 都是 user；bot 额外有 `isBot`、`ownerUserId` | [schema.ts](https://github.com/alookai/alook/blob/71677ac8d2c99078a0ffff4f7cb8cded23fbf27d/src/shared/src/db/schema.ts#L29) |
| text/forum/thread/dm 共用 channel；thread 用 parentChannelId、parentMessageId 关联父频道与 opener | [community-schema.ts](https://github.com/alookai/alook/blob/71677ac8d2c99078a0ffff4f7cb8cded23fbf27d/src/shared/src/db/community-schema.ts#L74) |
| access 与 notify 是不同关系；内容接收集合与提醒集合分别计算 | [成员 schema](https://github.com/alookai/alook/blob/71677ac8d2c99078a0ffff4f7cb8cded23fbf27d/src/shared/src/db/community-schema.ts#L122)、[接收者 resolver](https://github.com/alookai/alook/blob/71677ac8d2c99078a0ffff4f7cb8cded23fbf27d/src/shared/src/db/queries/community/members-resolver.ts#L50) |
| 消息使用每频道 seq 和独立 issued counter；nonce 按作者去重 | [消息 schema](https://github.com/alookai/alook/blob/71677ac8d2c99078a0ffff4f7cb8cded23fbf27d/src/shared/src/db/community-schema.ts#L158)、[写入](https://github.com/alookai/alook/blob/71677ac8d2c99078a0ffff4f7cb8cded23fbf27d/src/shared/src/db/queries/community/message.ts#L152) |
| 提交后的分发器还计算权限、提醒资格、bot wake；这不是单纯广播消息 | [message-dispatcher.ts](https://github.com/alookai/alook/blob/71677ac8d2c99078a0ffff4f7cb8cded23fbf27d/src/web/src/lib/community/message-dispatcher.ts#L53) |
| 当前部署绑定是 D1、R2、Durable Objects；检查 workspace manifests 和 lockfile 未发现 Matrix/Synapse 依赖 | [Web 配置](https://github.com/alookai/alook/blob/71677ac8d2c99078a0ffff4f7cb8cded23fbf27d/src/web/wrangler.toml#L34)、[WS 配置](https://github.com/alookai/alook/blob/71677ac8d2c99078a0ffff4f7cb8cded23fbf27d/src/ws-do/wrangler.toml#L32) |

## 模型匹配与必须保留的产品逻辑

以下 Matrix 事实均以对应规范为准；“迁移后仍需做什么”是基于两边模型的工程推论。

| Alook 对象/约束 | Matrix 对应 | 迁移判断 |
| --- | --- | --- |
| server 下组织频道 | [Space](https://spec.matrix.org/latest/client-server-api/#spaces) 组织 rooms | 组织结构可对应；Alook 的 server 成员、公开频道访问、离开后的撤权不能仅靠父子列表表达，须逐项映射并验收。 |
| text、message | room、event | 通用聊天契合。Matrix 的事件图不是 Alook 的频道数字 seq；旧引用与游标须另处理。[事件模型](https://spec.matrix.org/latest/#architecture) |
| thread 是子 channel，访问继承、提醒按参与者 | [m.thread](https://spec.matrix.org/latest/client-server-api/#threading) 是同 room 内指向根事件的关系 | 可实现相似 UI；保留独立 thread ref、notify 集合、退订与 bot 唤醒规则需要适配。若每个 thread 改建 room，又要维护跨 room 权限一致性。 |
| forum post 是 opener＋thread，另有 tags/archive | 同上，加自定义数据 | forum 浏览、标签筛选、归档规则仍由 Alook 实现。协议扩展能表达数据，不等于标准客户端会呈现这些产品行为。 |
| 每对用户一个 DM | [m.direct](https://spec.matrix.org/latest/client-server-api/#direct-messaging) 可记录多个 room | 不自动解决唯一 DM；Alook 仍要保证并发创建时只有一个权威映射。 |
| 作者 nonce 重试 | [txnId](https://spec.matrix.org/latest/client-server-api/#transaction-identifiers) 按 device/endpoint 去重 | 可借鉴；作用域不同。跨设备或重登录的重试策略、Alook 附属状态完整性仍须定义。 |
| 数字水线和完整收件 | [sync](https://spec.matrix.org/latest/client-server-api/#syncing) 使用 token，可能返回 limited timeline | 不可把 token 当 seq，也不可仅处理最新一页。bot 需要补齐缺口，再确认具体批次消费。 |
| 用户已读与线程提醒 | [threaded receipts](https://spec.matrix.org/latest/client-server-api/#threaded-read-receipts) | 有现成功能，但读回执不代表模型已收到上下文，也不代表任务已完成。 |

Alook 的 server 是共享空间，Matrix homeserver 是服务部署与身份域，**两者不要一对一命名映射**。一个 homeserver 可以承载多个 Alook server 对应的空间；为每个 Alook server 部署 homeserver 会无端放大运维与联邦成本。这是本文建议的部署映射，不是迁移已经发生。

### Bot 是采用 Matrix 的机会，也是不能省略的一层

Application Service 可以管理命名空间内的用户并接收事件批次；homeserver 为投递维护事务队列，失败重试保持同一事务内容。这对大量 agent 身份、桥接和断线恢复有价值。[Application Service API](https://spec.matrix.org/latest/application-service-api/#pushing-events)。普通 bot 也可以作为客户端运行，并非必须使用 Application Service。[组件说明](https://matrix.org/docs/matrix-concepts/elements-of-matrix/#appservice-bridges-and-some-bots)。

但 Alook 还要决定：谁拥有 bot、哪些频道能读、哪些通知能唤醒、用哪个运行实例处理、如何审批好友请求、如何记录 sent/handled、怎样恢复任务标记。现有 [bot 及活动 schema](https://github.com/alookai/alook/blob/71677ac8d2c99078a0ffff4f7cb8cded23fbf27d/src/shared/src/db/community-schema.ts#L582) 和 dispatcher 不会因换协议全部消失。

特别是：Application Service 的 HTTP 成功、消息被服务接收，与消息进入模型上下文是两次交付。Alook 基线 [CLI pull](https://github.com/alookai/alook/blob/71677ac8d2c99078a0ffff4f7cb8cded23fbf27d/src/daemon/src/cli/index.ts#L601) 在返回前 ACK，[daemon](https://github.com/alookai/alook/blob/71677ac8d2c99078a0ffff4f7cb8cded23fbf27d/src/daemon/src/daemon/createDaemon.ts#L560) 据此更新 modelSeen。单纯改用 Matrix 不会证明后面这次交付成功。若适配层收到批次就确认、之后才交模型，同类窗口仍然存在。这是边界推论，不是新做的故障复现。

### 加密不能当成免费附带项

Matrix 提供端到端加密体系，客户端要管理设备、密钥及密钥共享。[官方实现指南](https://matrix.org/docs/matrix-concepts/end-to-end-encryption/)。

工程推论：若 Alook 启用 E2EE，bot 必须作为有权解密的端点，或采用经过明确设计的解密服务；现有服务端正文处理、搜索、审核和附件处理要重新划定边界。不能既让服务器透明读取全部内容，又宣称消息对服务器端到端保密。本文不主张为评估 Matrix 而立即启用或关闭加密，应先确定产品要保护的对象与支持的功能。

## 能替换掉哪些工作

| 方案 | 收益 | 主要代价与结论 |
| --- | --- | --- |
| 保留自有 IM，修明确缺陷 | 不迁移数据；约束继续由现有数据库和代码承担 | 仍需维护同步、重试、权限和通知；当前建议。避免把“保留”理解为问题已解决。 |
| 整体改为 Matrix/Synapse | 可复用成熟 room/event 同步、生态互通及加密能力 | 重写客户端收发适配、迁移身份和历史、独立运维；产品规则仍在。当前没有足够收益支持。 |
| 自有核心＋可选 Matrix 桥接 | 若出现外部协作需求，可先验证互通价值 | 双系统重复/循环投递、身份和撤权复杂；仅在互通成为明确需求后考虑，不作为现在的默认过渡层。 |
| 只采用设计原则 | 借鉴稳定重试标识、同步缺口处理、接收确认边界 | 最小投入；不用先安装 SDK 或引入第二套消息事实。 |

若真正替换，应明确 Matrix 是消息与房间的唯一权威，Alook 数据库只保存无法替代的产品数据/投影。D1 与 homeserver 是两个提交边界；“向 Matrix 写消息，同时向 D1 写 thread、计数、标记”不能假装成一笔本地事务。必须选择幂等可重建投影或调整模型，避免把本轮要修的半成品问题搬到跨服务链路。

## 100 人频道：成本与延迟怎么判断

以下假设用于比较：100 个成员、每人一个在线设备、每天 1,000 条纯文本消息，每条正文 1 KiB；另测 100 人 @everyone 和 5 人订阅线程。它不是 Alook 实际流量预测。

- 正文每日约 **0.98 MiB**，30 日约 **29.3 MiB**，不含索引、元数据、附件或备份。
- 同一正文送给其他 99 人，理论正文载荷每日约 **96.7 MiB**。这是应用层副本量，非网络账单；连接、协议封装、发送者回显与多设备会改变实际值。换协议不会消掉这些接收端数据需求。
- 当前普通消息不需要为 100 人各存一份正文；`createMessage` 写共享消息及少数状态。@everyone 的 mention 记录可能随人数增长，提醒资格查询和 fanout 也会随受众增长。[mention 写入](https://github.com/alookai/alook/blob/71677ac8d2c99078a0ffff4f7cb8cded23fbf27d/src/shared/src/db/queries/community/mention.ts#L16)、[分发器](https://github.com/alookai/alook/blob/71677ac8d2c99078a0ffff4f7cb8cded23fbf27d/src/web/src/lib/community/message-dispatcher.ts#L53)。
- 5 人 thread 的提醒只应面向订阅者；当前内容接收集合可能更大。不能把提醒人数当成全部 WS 接收人数，更不能推断 Matrix 支持 thread 就会自动减少所有网络发送。
- Matrix 单 homeserver 不需要 100 份联邦历史副本；若 100 人分布在 H 个 homeserver，同一 room 的参与服务器维护本地副本。跨服务器历史、同步与状态处理会增加工作，但不能用 H 推出精确物理存储倍数。[Rooms & Events](https://matrix.org/docs/matrix-concepts/rooms_and_events/#local-copies)。

Synapse 官方生产安装建议 PostgreSQL；SQLite 仅适合测试。最小实例不强制多 worker；采用 worker 扩展时需安排 Redis、复制通信与反向代理。[安装](https://element-hq.github.io/synapse/latest/setup/installation.html#using-postgresql)、[workers](https://element-hq.github.io/synapse/latest/workers.html)。因此本次评估的 Synapse 方案不是在现有 Worker 上换一个库，而是新增运行服务、数据库、备份、升级和监控责任。托管能转移部分操作工作，不能省去 Alook 的语义适配。

Synapse 项目提供 AGPL 或商业许可；这与 Matrix 协议本身不是同一件事。采购或修改实现时应按实际所选版本和使用方式检查许可，本文不估算价格，也不作许可义务的法律结论。[项目许可说明](https://github.com/element-hq/synapse#copyright-and-licensing)。

### 公平的验证方案（尚未执行）

比较修复后的 Alook 与单 homeserver Synapse；同地区、同客户端数量、同正文/附件大小，记录硬件和缓存状态。加密与 federation 单独成组，不能用“无加密单服”对比“加密跨服”得出协议优劣。

| 场景 | 观测与通过条件 |
| --- | --- |
| 100 人房间连续发送及突发 | 分别记录发送者本地显示、持久化确认、接收者显示的 p50/p95/p99；发送失败率、CPU/RAM、数据库读写、网络字节。不得只有 HTTP 响应耗时。 |
| @everyone、5 人线程、频繁切换 20 个频道 | 提醒对象正确；无权限者无法读历史；测每次发送/切换的查询数和数据量，保留冷启动与热缓存结果。 |
| 100 客户端断线后同时恢复 | 验证历史补齐、去重、读取位置；量化恢复峰值资源与首屏时间。 |
| 并发唯一 DM、同请求重试、删除后继续发送 | DM 不分叉，消息不重复，旧引用仍可解析，新消息不因旧游标被漏掉。 |
| 接收服务在确认前/后崩溃，通知投递失败 | 已持久化消息保留；检查重投与消费证据。将“模型未收到”和“已收到但尚未处理”分别注入。 |

没有运行这些实验前，不报告 Matrix 比 Alook 快/慢多少、能省多少费用，或迁移需要精确几天。

## 如果产品目标改变，迁移要过哪些门槛

1. **收益门槛**：明确至少一个当前自有链路难以经济提供的目标，例如客户必须接入已有 Matrix 房间，或必须自托管并使用兼容客户端。只为减少几个 if/else 不够。
2. **模型门槛**：先做可丢弃的隔离样例：一组 human/bot、公开/私有频道、forum、thread、DM。验父级撤权、线程退订、opener 删除、标签归档、重试及 bot 唤醒。选择原生 thread 或子 room 后固定规则，不同时维护两套权威。
3. **历史门槛**：列出 user→MXID、channel→room、message→event 和旧 seq 引用的映射；保留作者、附件权限、回复关系、时间与已读位置。定义不能等价导入的历史如何只读呈现，不能把新发出的导入事件冒充原始历史身份/顺序。
4. **切换门槛**：对测试副本执行停写、导出、导入、校验、切换单一写入口。旧系统只读保留；若切换后已有新写入，回退必须先核对并迁回新增数据，不能只切 DNS 丢下新消息。本次不实施双写或生产迁移。
5. **运行门槛**：完成上述 100 人实验、备份恢复和升级演练；按 Alook 实际部署和流量填成本表，再决定是否采用。协议先进不代替这一步。

## 本次交付边界

本 PR 只加入这份决策材料，无依赖、运行代码、数据库或部署变更。建议保留自有 IM 是当前证据下的决策，不是永久排除 Matrix。下一步最有价值的证据是：修复后的真实收发延迟，以及是否确有 Matrix 互通/自托管/加密需求。
