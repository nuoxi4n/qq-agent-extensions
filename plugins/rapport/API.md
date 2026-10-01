# rapport.v1：通用好感度事件 API

由好感度养成 **1.2.1** 提供，兼容 1.2.0 的通用 v1 接口。适用于任务奖励、小游戏、签到、投喂等外部扩展；核心只管理好感度、额度和事件回执，不包含食物、货币或支付流程。当前未发布接口直接定稿为 `rapport.v1`，客户端 `apiVersion` 为 **1**。

## 接入与授权

使用宿主公共能力接口同步获取客户端，不是 HTTP 服务：

```js
const rapport = api.capability('rapport.v1', { consumer: 'quest' });
if (rapport?.apiVersion !== 1) throw new Error('请安装并启用好感度养成 1.2.0');
```

消费方清单按需声明 `requires: ["rapport.v1"]`；缺少它仍能工作的扩展可以只使用软依赖。`consumer` 使用自身扩展 ID，允许 1～64 位字母、数字、点、下划线或连字符，首位须为字母或数字，不能为 `rapport`。每次业务操作重新获取客户端；停用、重启、热重载后旧对象失效。

好感度控制台的「扩展接入权限」对应 `integrationPermissions`，默认 `{}`。按需**合并**授权，保留已有条目：

```json
{
  "quest": ["recordEvent", "rateEvent", "bindMessage"],
  "feeding": ["recordEvent", "rateEvent", "bindMessage"]
}
```

固定任务奖励只需要 `recordEvent`。需要 AI 评分再授予 `rateEvent`；需要关联后续恢复消息再授予 `bindMessage`。允许负向固定分值或负向 AI 评分，还须额外授予 `decrease`；投喂无需此权限。查询无须这些授权；`getState` 会结算日期和衰减并写盘，不能当作零写入的查询。权限每次调用重新读取，已获取的客户端也受撤权限制；权限不能通过聊天调参工具修改。

宿主不认证调用方传入的 `consumer`，因此这是受信任扩展之间的配置与隔离机制，不能防范恶意扩展冒充身份。消费方负责核验真实用户、业务权限和事件成立条件，不应将此客户端原样暴露为任意用户可调分的模型工具。

## 方法

每个方法同步返回 `{ok:true,...}` 或 `{ok:false,code,message}`，均不调用模型、不发送 QQ 消息。所有参数对象拒绝未知字段。

| 方法 | 参数 | 成功结果与用途 |
| --- | --- | --- |
| `getState` | `scope,userId` | 当前 `mode,score,level,protectedOwner,remainingGain,remainingLoss,aiMaxGain,aiMaxLoss,minScore,permissions`；结算当天额度与衰减，但不更新最近真实互动时间 |
| `recordEvent` | 下述事件参数 | `{event}`，一次性登记固定分值或待 AI 评分事件；业务条件不满足时也保存永久 `rejected` 回执 |
| `getEvent` | `scope,userId,eventId` | `{event}`，只读本来源、会话、成员的事件；缺失为 `NOT_FOUND` |
| `bindMessage` | `scope,userId,eventId,messageId` | `{event}`，将已登记事件关联到恢复消息；同一编号重复绑定无副作用 |
| `rateEvent` | `scope,userId,eventId,delta,reason` | `{event}`，为原 AI 事件提交一次评分；允许 0，实际变化由额度和边界裁剪 |

`scope` 为 `group:群号` 或 `private:用户QQ号`，`userId` 为目标 QQ 号字符串（5～12 位数字，首位非零）。私聊 scope 必须与目标用户一致。群内事件由消费方验证目标成员。

### 事件参数

| 字段 | 必填 | 约束与含义 |
| --- | --- | --- |
| `scope,userId` | 是 | 会话与目标成员 |
| `eventId` | 是 | 1～160 字稳定业务编号，如 `quest:42:10001`；不要求哈希，也不要求对应聊天消息 |
| `at` | 是 | 消费方持久化该事件的创建时间，Unix 毫秒整数；不能晚于当前时间超过 60 秒 |
| `occurredAt` | 否 | 原业务发生时间，默认 `at`，不能晚于 `at` 超过 60 秒；用于重置边界判断 |
| `messageId` | 否 | 真实 QQ 消息编号字符串（可为负）或 `local:正整数`；默认 null，支持无聊天消息的业务事件 |
| `mode` | 是 | `normal` 或 `ai`，创建前从 `getState` 读取并保存，重试不能改 |
| `fixedDelta` | 否 | 普通模式固定变化，默认 0，范围 -10～10，最多两位小数；负数需 `decrease` |
| `maxGain` | 否 | AI 正向评分上限，默认 10，范围 0～10，最多两位小数；0 禁止正向评分 |
| `maxLoss` | 否 | AI 负向评分上限，默认 0，范围 0～10，最多两位小数；大于 0 需 `decrease` |
| `reason` | 是 | 1～200 字事实说明，无首尾空白、控制字符，不是给模型的指令 |

`consumer` 自动来自客户端，不能放入参数。`eventId` 同样不允许首尾空白和控制字符。两个时间必须为非负整数。`fixedDelta` 只用于普通模式；`maxGain/maxLoss` 只用于 AI 模式。

客户端按 **consumer + scope + eventId** 去重，目标成员包含在不可修改的输入中。同一业务编号需要发给多人时，应将用户编号纳入 `eventId`。不同来源或会话可以使用相同编号；同一来源在同一会话不能换用户、时间、模式、分值或原因重放。参数顺序不影响去重，省略默认值和显式提供同一默认值等价。

### 回执与评分

`event` 包含内部 `id`、规范化 `input`（含 consumer 和全部默认值）、已关联 `messages`、`status`：

- `rejected`：事件未应用，`reason` 说明原因，重试永久返回同一拒绝结果。
- `pending`：AI 事件已登记，等待消费方提供评分。
- `rated`：评分完成，额外有 `requested,applied,score,level,reason,ratedAt`。`score/level` 是当时快照；当前状态使用 `getState`。

普通事件完整应用 `fixedDelta`，额度不足不截断、整单拒绝。AI 登记不应用固定分值；指定方向都没有剩余额度时拒绝登记（`maxGain=maxLoss=0` 的纯 0 分事件除外）。主人固定满分保护拒绝新事件。

`rateEvent.delta` 为 -10～10、最多两位小数，`reason` 为 1～200 字事实理由。评分受事件方向上限、当前 AI 单次上限、当前每日正负额度、总分 ±100 和当前最低分共同限制。负向评分同时检查 `decrease` 权限。加分与日常累计共享 `dailyCap`；扣分与日常 AI 评分共享 `aiDailyLossCap` 和 `aiMinScore`，包括普通模式的外部固定扣分。扣分不会返还加分额度。

外部事件不使用日常聊天的调分冷却、消息时效与证据列表；**来源扩展负责业务次数、冷却、证据和评分是否可信**。提供 `messageId` 时，会与日常 AI 评分及其他来源事件进行消息去重；不提供消息编号则仅按业务 ID 去重。普通模式的按发言自动奖励仍独立执行，外部固定分值是额外变化。

相同 `recordEvent` 重试返回原回执，不再次计分；已完成 AI 评分只能用同一 delta/reason 重放，不可重评，包括 0 分。普通事件不能调用 `rateEvent`。重试仍需对应写权限；仅核对历史可使用 `getEvent`。

`bindMessage` 不能绑定被其他事件占用的消息；待评事件也不能绑定已按日常 AI 规则评分的消息。已完成事件可以关联已被日常评分的恢复消息用于展示历史，但不会再次评分。绑定不修改原始输入。登记、绑定后的消息不能再使用 `rapport__adjust` 重复计分，消费方的提示词应指导模型先完成该玩法，再用自己的工具评分。

## 最小示例

以下输入须由来源扩展在第一次登记前保存；重试读取同一份输入，不重新生成时间和模式：

```js
const state = rapport.getState({ scope: 'group:12345', userId: '10001' });
if (!state.ok) throw new Error(state.message);
const input = {
  scope: 'group:12345', userId: '10001', eventId: 'quest:42:10001',
  at: Date.now(), mode: state.mode, fixedDelta: 0.1,
  maxGain: 0.3, maxLoss: 0, reason: '完成每日任务'
};
// 来源扩展先持久化 input，再调用；重试必须读取已保存的 input。
const result = rapport.recordEvent(input);
if (!result.ok) throw new Error(result.message);
if (result.event.status === 'pending') {
  // 主会话模型通过来源扩展的工具提交 delta/reason；0 也须提交。
  // 此处不直接请求模型，也不将 maxGain 当作建议评分。
}
```

可复用的调用示例见 [examples/quest.js](examples/quest.js)。它只是示例文件，不注册新技能或工具。

## 错误与恢复

常见错误为 `INVALID_ARGUMENT`（参数错误）、`FORBIDDEN`（权限不足）、`INVALID_CONFIG`（权限配置错误）、`NOT_FOUND`（本来源回执不存在）、`IDEMPOTENCY_CONFLICT`（同一业务输入或评分改变）、`ALREADY_RATED`（消息已占用）、`INVALID_MODE/INVALID_EVENT`（事件状态不支持操作）、`CLOCK_ROLLBACK`（日期回退）、`rapport-cancelled`（旧客户端失效），以及文件系统错误码或 `STORAGE_ERROR`。任何 `ok:false` 都不能解释为已经成功；额度、模式、保护或消息冲突的登记拒绝则是 `ok:true,event.status='rejected'`，必须检查状态。

本 API 不管理货币、物品、交易或模型调用。收费扩展自行保存订单、预扣并核对支付回执。投喂采用“预扣 → 登记事件 → 成功结算 → AI 评分”；仅明确 rejected 才取消预扣，pending/rated 需继续结算。未知结果保留订单并查询原回执，不能因超时或回复发送失败直接退款。调用方还应核对回执 input，防止错误关联业务订单。跨插件不是单一原子事务。

已登记事件保持原模式；切换配置不会将待评 AI 事件转换为固定奖励。跨日评分消耗评分当天额度。重置成员/会话保留永久回执：旧固定奖励重放不恢复分数；旧待评事件再次评分时以 0 关闭。未登记但发生于重置之前的事件会被拒绝，调用方不能换时间规避。

## 数据与安装

回执位于 `rapport.json` 的 `integrationEvents`，沿用原百分制数据格式 version=2（这是存档格式，能力与客户端版本均为 1）。本地试用版 `feedingEvents` 经校验后自动迁移到 consumer=`feeding`，保留事件状态、绑定消息和评分结果，不重新加分；冲突或损坏时停止加载并保留原文件。没有旧业务方法的兼容层。

写入持有独占 `rapport.json.lock`，配套 `.lock.owner-<PID>-<UUID>` 归属文件隔离并发启动与遗留锁回收；同步事务失败回滚内存，原子替换保护文件。正常停用或进程退出时尝试保存待写数据并释放锁；强制结束后，下次启用自动回收 PID 已确定退出的锁，兼容旧版 `{pid,token}`。活进程或归属无法确认时保留锁并报错，不接管宿主信号。多个实例同时启动可能相互退让，稍后重试；仍报错则确认所有实例已退出再排查锁与归属文件。

数据目录需位于支持同目录硬链接的本机文件系统（如 NTFS），以原子发布完整锁内容。遵循 `QQ_AGENT_DATA_DIR` 与数字 `QQ_AGENT_PROFILE`。旧版数据落在默认 data、现改用 PROFILE 时，管理员应先备份并移动到对应 data-N。

清理失败时停止当前实例写入，并仅保留原路径与归属令牌供后续启用、释放或进程退出重试，热重载也可恢复。待清理记录不保存业务回调、不补写已停用实例的数据；重试核对主锁令牌，清理完成后移除清理监听。

升级前停用相关扩展并共同备份业务与好感度存档，更新子模块后重启宿主。不要删除历史事件或仅回滚一个参与交易的文件。当前账本随事件数量增长、每次完整写盘，适用于单机中小规模玩法。
