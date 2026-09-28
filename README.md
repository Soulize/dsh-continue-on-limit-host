# dsh-continue-on-limit-host

DeepSeek Harness / DSH 的 Host 侧全局 max-tokens 自动续写插件。

## 模式

插件提供两个严格互斥的实现：

### Follow-up（默认）

```text
provider finish=max-tokens
        ↓
AgentLoop 正常记录 max-tokens
        ↓
agent/turn-stopping
        ↓
agent.followup("继续")
        ↓
下一 Turn
```

Follow-up 保留 DSH 原生语义：

- Assistant stream 中仍是 `finish=max-tokens`
- 当前 Turn 仍是 `turn/end(max-tokens)`
- “继续”进入 `next-turn`

### Steer（透明同 Turn）

0.4.0 起，Steer 不再等 max-tokens 进入 AgentLoop 后补救，而是在官方 `llm/stream` waterfall 直接截获终止 chunk：

```text
Provider
finish=max-tokens
        ↓
dsh-continue-on-limit-host
        ↓
max-tokens 仅作为插件内部触发信号
        ↓
需要时 agent.steer("继续") -> next-step
        ↓
对 AgentLoop 输出 finish=stop
        ↓
AgentLoop 从未进入 sticky max-tokens 状态
```

如果截断前已经形成完整 `tool-call` block，则插件不额外发送“继续”，而是把终止原因映射成 `tool-calls`，让 DSH 原生工具循环继续：

```text
Provider finish=max-tokens
+ complete tool-call
        ↓
插件对外输出 finish=tool-calls
        ↓
执行工具
        ↓
tool result -> 原生 next-step
        ↓
继续 AgentLoop
```

因此 Steer 模式下：

- AgentLoop 不会看到 `FinishReason { kind: "max-tokens" }`
- 持久化 `assistant/message.stream` 中不会记录 `max-tokens`
- 不会触发 DSH 的 sticky `turnEnds=max-tokens`
- 不需要修改 `Session.append()`
- 不需要改写 `turn/end`
- 不需要 tool-loop bridge
- 正常结束由 DSH 原生写成 `turn/end(completed)`

对 shipped pi-ai adapter，插件还会把 replay metadata 中的原生 `stopReason: "length"` 同步改为 `stop` 或 `toolUse`；DeepSeek Messages 的 replay metadata 本身不保存 stop reason。

## 配置

```yaml
enabled: true
continuationMode: followup   # followup | steer
continueText: 继续
maxConsecutive: 3
minIntervalMs: 0
includeSubagents: true
debugLogging: false
```

字段说明：

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `enabled` | `true` | 总开关 |
| `continuationMode` | `followup` | Follow-up 或透明 Steer |
| `continueText` | `继续` | 自动 Steer / Follow-up 的文本 |
| `maxConsecutive` | `3` | 最多连续注入多少次续写；`0` 不限 |
| `minIntervalMs` | `0` | 自动注入之间的最小间隔 |
| `includeSubagents` | `true` | 是否处理 Subagent |
| `debugLogging` | `false` | 详细日志 |

Steer 模式中，`maxConsecutive` 限制的是插件主动注入的 `agent.steer()` 次数。若截断响应已经包含完整工具调用，后续由 DSH 原生工具循环驱动，不额外消耗一次 Steer 计数。

配置为 volatile，可在 Plugins 页面热更新；模式切换会清空上一模式的连续计数和已处理状态。

## Steer 为什么要在 llm/stream 做

DSH AgentLoop 对 max-tokens 有 sticky 语义：

```ts
const stepEnd = await this.step(decision)

if (turnEnds === null || turnEnds.kind !== 'max-tokens') {
  turnEnds = stepEnd
}
```

一旦某个 Step 把 `turnEnds` 设成 `max-tokens`，后面的正常 `tool-calls` / `completed` 都不能覆盖它。

所以 Steer 0.4.0 的策略是：**不让这个标识进入 AgentLoop。**

插件只在 `llm/stream` 内部看到真实 max-tokens，然后立即把对外终止原因替换为普通 `stop` / `tool-calls`。这样后续 Step、工具调用和 Turn 收尾全部回到 DSH 原生状态机。

## Follow-up 检测

Follow-up 仍在 `agent/turn-stopping` 读取最新 Assistant settlement：

```text
latest assistant/message | assistant/attempt
        ↓
lastAssistantStreamChunk(stream, "finish")
        ↓
finish.reason.kind === "max-tokens"
```

然后调用 `agent.followup()`。

## 队列处理

自动注入前会检查：

```text
agent.inbox.nextTurn
agent.inbox.nextStep
```

已有待处理工作时不再重复插入。

Steer 已截获的 max-tokens 即使因为 inbox、次数上限或运行中配置变化而没有再注入，也不会重新暴露给 AgentLoop。

## Subagent

`includeSubagents=true` 时，live Subagent 与主 Agent 使用同一策略。

- Follow-up：max-tokens Turn 结束前排入 next-turn
- Steer：max-tokens 在模型流边界被隐藏，同 Turn 按原生 Step/tool loop 继续

Steer 模式最终正常完成时，Subagent 看到的是普通 `completed` Turn，而不是 max-tokens settlement。

## 日志

日志：

```text
$DSH_HOME/logs/dsh-continue-on-limit-host.log
```

Windows 通常为：

```text
%USERPROFILE%\.dsh\logs\dsh-continue-on-limit-host.log
```

Follow-up 重点标记：

```text
MAX_TOKENS_PRESTOP_CAPTURED
FOLLOWUP_MAX_TOKENS_CAPTURED
FOLLOWUP_QUEUED
```

Steer 重点标记：

```text
STEER_MAX_TOKENS_INTERCEPTED
STEER_QUEUED
STEER_SEND_SKIPPED reason=native-tool-loop
TURN_END_CAPTURED ... reason=completed
```

## 安装

```powershell
dsh plugin --profile web add github:Soulize/dsh-continue-on-limit-host
```

更新时建议固定到最新 commit：

```powershell
dsh plugin --profile web add github:Soulize/dsh-continue-on-limit-host#<commit-sha>
```

## 自检

```powershell
npm test
```

Smoke test 覆盖：

- Follow-up 保留 max-tokens
- Steer 将 max-tokens 映射为 stop
- 完整工具调用映射为 tool-calls
- pi-ai replay `length` 同步隐藏
- Steer 次数上限下仍不向 AgentLoop 暴露 max-tokens
- Follow-up / Steer 热切换隔离
- Plugins 配置页注册

## 兼容性

- DSH：`>=0.1.7-rc.1`
- 不设置最高 DSH 版本上限
- Node.js：`>=20`

关键接口：

- `llm/stream`
- `isAgentLoopRequest()`
- `agent/turn-stopping`
- `Agent.followup()`
- `Agent.steer()`
- `Agent.inbox`
- `session/event`
- volatile Config
- `plugins.row.config`

## License

MIT
