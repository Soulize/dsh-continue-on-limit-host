# dsh-continue-on-limit-host

面向 **DeepSeek Harness / DSH 0.1.7-rc.2** 的 Host 侧全局自动续写插件。

模型命中单次输出上限时，Harness 会把 provider 的 `length` / `max_tokens` 归一化为：

```text
FinishReason { kind: "max-tokens" }
```

插件在 Host 的 `agent/turn-stopping` 终止检查点读取当前 Turn 最新的 Assistant stream，并在最新 provider finish 为 `max-tokens` 时自动续写。它不依赖当前浏览器正在显示哪个会话，因此后台 live 主会话和 live Subagent 都能工作。

## 两种续写实现

0.3.0 起提供两个**严格互斥**的实现，通过 `continuationMode` 二选一。默认保持原有 Follow-up 路径。

### Follow-up：新 Turn（默认）

```text
Step N -> max-tokens
        ↓
agent/turn-stopping
        ↓
agent.followup("继续")
        ↓
nextTurn = 1
        ↓
turn/end(max-tokens)
        ↓
同一个 driver 直接进入下一 Turn
```

特点：

- 使用 DSH 官方 `Agent.followup()`。
- “继续”进入 `next-turn`，恢复发生在新的 Turn。
- 当前 Turn 真实保留 `turn/end(max-tokens)`。
- 下一 Turn 正常结束后可得到独立的 `turn/end(completed)`。
- 不修改任何 Session 事件，是默认、保守实现。
- Follow-up 在 `turn/end` **之前**排队，因此 continuable Subagent 不会在两个 Turn 之间先进入 idle settlement。

### Steer：同 Turn 插话（实验）

```text
Step 1 -> max-tokens
        ↓
agent/turn-stopping
        ↓
agent.steer("继续")
        ↓
nextStep = 1
        ↓
Step 2
```

如果 Step 2 又是 `max-tokens`，插件会再次 Steer；如果最终最新 provider finish 为正常 `stop`，插件允许 Turn 结束。

DSH 0.1.7-rc.2 的 AgentLoop 有意把 Turn 级 `max-tokens` 设为 sticky：同一 Turn 中任何 Step 命中过一次 `max-tokens`，后续正常 Step 也不会自动把最终 `turn/end` 降级回 `completed`。

因此 Steer 模式在插件内部额外做一个**仅当前 Session、仅当前恢复 Turn、一次性**的 `session.append` 包装：

```text
provider-level history:
Step 1 finish=max-tokens   <- 永久保留
Step 2 finish=max-tokens   <- 永久保留
Step 3 finish=stop         <- 永久保留

turn-level outcome:
原生将写 turn/end(max-tokens)
        ↓
插件确认：
- 当前模式仍是 steer
- 当前 Turn 是插件自己启动的恢复链
- 最新 provider finish 是 stop
        ↓
仅把这一个 turn/end 写为 completed
```

这条路径：

- 不修改 DSH core 包。
- 不改全局 `Session.prototype`。
- 不篡改任何 Assistant stream 中真实的 provider `max-tokens`。
- 只在插件自己发起的 Steer 恢复链最终正常 stop 时，把 sticky 的 Turn 级结果从 `max-tokens` 归一化成 `completed`。
- 如果恢复再次截断、达到续写上限、发生错误/取消、用户/其他插件抢占，Turn 仍保留原生结果。
- 对 Subagent 来说，整个恢复过程留在同一个 Turn/driver 内，不会在中间进入 idle settlement。

## 两种实现不会重复执行

运行时只有一个分支：

```text
agent/turn-stopping
      |
      +-- continuationMode=followup -> followup implementation -> return
      |
      +-- continuationMode=steer    -> steer implementation    -> return
```

模式热切换会先清空上一实现的计数和临时状态，并撤销尚未使用的一次性 Steer append 包装。不会同时发送 `followup()` 和 `steer()`。

## 配置

DSH 0.1.7 Plugins 页面：

```text
侧栏 -> Plugins / 插件 -> Installed / 已安装
-> dsh-continue-on-limit-host
-> continue-on-limit-host -> Configure / 配置
```

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `enabled` | `true` | 总开关 |
| `continuationMode` | `followup` | `followup` 或 `steer`，严格二选一 |
| `continueText` | `继续` | 自动发送的续写提示词 |
| `maxConsecutive` | `3` | 连续自动续写次数；`0` 表示不限 |
| `minIntervalMs` | `0` | 在 `agent/turn-stopping` 内等待的最小发送间隔 |
| `includeSubagents` | `true` | 是否同时处理 Subagent |
| `debugLogging` | `false` | 开启详细诊断日志 |

Bundle 默认：

```yaml
- insert:
    - id: continue-on-limit-host
      name: dsh-continue-on-limit-host
      config:
        enabled: true
        continuationMode: 'followup'
        continueText: '继续'
        maxConsecutive: 3
        minIntervalMs: 0
        includeSubagents: true
        debugLogging: false
```

## 检测规则

插件不统计 token，也不解析 UI 文案。它读取当前 Turn 最新的 `assistant/message` / `assistant/attempt` 内嵌 stream，并检查最后一个 `finish`：

```text
latest Assistant settlement
        ↓
lastAssistantStreamChunk(stream, "finish")
        ↓
finish.reason.kind === "max-tokens"
```

只看**最新 Step**，不会因为同一 Turn 中更早的旧 `max-tokens` 而重复发送。

## 安全保护

### 已有工作时不抢队列

发送前检查：

```text
agent.inbox.nextTurn
agent.inbox.nextStep
```

任意一个已有内容时，本次自动续写跳过。

### 连续次数上限

默认最多连续 3 次；`0` 表示不限。真人新消息或正常完成会重置计数。

### 模式隔离

每个 Session 的运行状态绑定当前 `continuationMode`。热切换模式会：

- 归零连续计数；
- 清除上一模式的已处理标记；
- 清除 Steer 恢复 Turn；
- 恢复可能存在的 Session append 临时包装。

### Steer 的 Turn-end 改写边界

Steer 模式只在以下条件全部成立时把最终 Turn 结果归一化为 `completed`：

1. 插件当前仍启用；
2. 当前仍选择 `steer`；
3. 这个 Turn 确实由本插件在 `max-tokens` 后发起过 Steer 恢复；
4. DSH 原本将写 `turn/end(max-tokens)`；
5. 当前 Turn 最新 provider finish 是正常 `stop`。

Step 级 `max-tokens` 永远不会被清除，因此 replay、usage、截断工具调用处理仍保留真实 provider 事实。

## 为什么不在 turn/end 后发送

`session/event` 在 `Session.append('turn/end', ...)` 的同步发布栈内触发，而 `followup()` / `steer()` 都会通过 Inbox 再触发新的 Session append。直接在 listener 内发送会报：

```text
Error: session append cannot reenter while another append is being published
```

在 `turn/end` 后再用 microtask 发送也可能错过当前 driver 的 `inbox.hasPending` 判断。

所以两个实现都在官方的 `agent/turn-stopping` checkpoint 工作。

## Subagent

`includeSubagents=true` 默认开启。

官方 continuable Subagent 的“continuation”是后续消息/冷恢复能力，不代表 child 命中 `max-tokens` 后会自动再请求一次模型。

- Follow-up 模式：在 child 的 `turn/end` 之前先把 next-turn 排好，使同一 driver 连续进入下一 Turn。
- Steer 模式：直接把“继续”放入 next-step，使当前 Turn 不结束；最终正常 stop 后再由插件归一化 sticky Turn 结果。

两条路径都避免“先 idle settlement，再给 Lead 发送 max-tokens 终止通知，然后才续写”的竞态。

## 诊断日志

插件成功加载时无条件写一条 `ACTIVATED`：

```text
$DSH_HOME/logs/dsh-continue-on-limit-host.log
```

Windows 默认通常是：

```text
%USERPROFILE%\.dsh\logs\dsh-continue-on-limit-host.log
```

PowerShell 实时查看：

```powershell
Get-Content "$env:USERPROFILE\.dsh\logs\dsh-continue-on-limit-host.log" -Wait
```

打开 `debugLogging` 后，Follow-up 正常链路重点看：

```text
MAX_TOKENS_PRESTOP_CAPTURED ... mode=followup
FOLLOWUP_MAX_TOKENS_CAPTURED ...
FOLLOWUP_QUEUED ...
TURN_END_CAPTURED ... reason=max-tokens
```

Steer 正常链路重点看：

```text
MAX_TOKENS_PRESTOP_CAPTURED ... mode=steer
STEER_TURN_END_REWRITE_ARMED
STEER_MAX_TOKENS_CAPTURED ...
STEER_QUEUED ...
...
STEER_RECOVERY_REACHED_CLEAN_STOP ...
STEER_TURN_END_REWRITTEN max-tokens->completed
TURN_END_CAPTURED ... mode=steer ... reason=completed
```

若达到次数上限或 inbox 已有别的工作，会出现 `AUTO_CONTINUE_SKIPPED`。

## 安装

GitHub 安装：

```powershell
dsh plugin --profile web add github:Soulize/dsh-continue-on-limit-host
```

DSH 0.1.7-rc.2 对重复的无 ref Git spec 存在更新识别限制。更新时建议指定新 commit：

```powershell
dsh plugin --profile web add github:Soulize/dsh-continue-on-limit-host#<new-commit-sha>
```

如果 Plugin Manager 报：

```text
无法从依赖变更中确定安装了哪个包
```

可先移除再安装带 SHA 的版本。

npm 发布不是必需条件；本仓库保留了 npm 元数据，后续若发布 registry 包即可改用包名安装。

## 后台会话范围

“全局”指当前 Host 进程中已经加载的 live Agent/Session。纯历史、未加载的 Session 不会被本插件主动扫描或恢复。

## 开发 / 自检

```powershell
npm test
```

`test/smoke.cjs` 会做语法检查；若可找到 DSH runtime modules，还会分别验证 Follow-up 与 Steer 两条路径、模式隔离和 Plugins 配置页注册。

## 兼容性

- 主要目标：DSH `0.1.7-rc.2`
- 声明范围：`>=0.1.7-rc.1 <0.2.0`
- Node.js：`>=20`

关键接口：

- `agent/turn-stopping`
- `Agent.followup()`
- `Agent.steer()`
- `Agent.inbox`
- `Session.append()`
- `session/event`
- volatile Config
- `plugins.row.config`

## License

MIT
