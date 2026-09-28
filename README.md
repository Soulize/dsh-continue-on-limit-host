# dsh-continue-on-limit-host

面向 **DeepSeek Harness / DSH 0.1.7-rc.2** 的 Host 侧全局自动续写插件。

当模型因为单次输出上限结束，Harness 最终会写入：

```text
provider finish_reason = length
  -> llm-pi-ai stopReason = length
  -> FinishReason { kind: "max-tokens" }
  -> turn/end.reason.kind = "max-tokens"
```

本插件直接在 Host 监听最后这个 `turn/end` 事件，并向同一个 live Agent 排队一条 `followup("继续")`。因此它不再依赖当前浏览器正在展示的 staged session：**后台已加载的主会话即使没有打开在页面上，也可以继续运行。**

## 与原版的主要区别

原版 `dsh-continue-on-limit` 把观察器挂在 Web Client 的 `conversation.session.header.actions`，通过当前页面的 `useSession()` 检测 `turn-max-tokens`，所以只能作用于当前打开的会话。

这个 fork 改为：

```text
Host: session/event
       |
       +-- turn/end.reason.kind === "max-tokens"
               |
               +-- ctx.agents.get(session.id)
                       |
                       +-- agent.followup("继续")
```

检测依据仍然是 Harness 自己的 `max-tokens` 链路，不统计 token，也不解析页面上的中文提示。

## 功能

- Host 全局检测 `turn/end.reason.kind === "max-tokens"`。
- 支持后台 live 主会话，不要求该会话正在 Web UI 中打开。
- 如果 turn 结束后已有用户或其他插件工作排队，不抢在它们前面发送“继续”。
- 每个 Session 独立维护连续续写次数和发送间隔。
- 正常结束、报错结束等非 `max-tokens` 轮次，或新的真人输入，会重置连续计数。
- `maxConsecutive = 0` 可关闭次数上限。
- Subagent 默认参与自动续写。Harness 官方所谓 continuation 是“可继续 child + 后续消息/冷恢复”能力，并不会在 `max-tokens` 后自动重试 child。
- DSH 0.1.7 新版 Plugins 页面内置配置 UI，保存后通过 `.volatile()` 热更新，无需重启插件实例。

## 安装

### 直接从 GitHub 安装（不需要发布 npm）

DSH 官方插件管理器支持 Git 仓库作为安装源，npm 发布不是必需条件：

```powershell
dsh plugin --profile web add github:Soulize/dsh-continue-on-limit-host
```

安装或更新 Bundle 后重启对应 profile：

```powershell
dsh web --profile web
```

如果之前安装了原版 `dsh-continue-on-limit`，建议先移除，避免两个自动续写插件同时工作：

```powershell
dsh plugin --profile web remove dsh-continue-on-limit
```

DSH 0.1.7 的 Plugins 安装界面也可以使用同一个 GitHub spec：

```text
github:Soulize/dsh-continue-on-limit-host
```

### GitHub 安装源的更新限制（DSH 0.1.7-rc.2）

DSH 0.1.7-rc.2 的 Plugin Manager 在 `installBundle()` 完成后，会比较 profile `package.json` 的 `dependencies` 前后值来推断“本次安装/更新的是哪个包”。如果一个已经安装的 GitHub spec 再次使用完全相同的地址，例如：

```text
github:Soulize/dsh-continue-on-limit-host
```

pnpm 可以更新 lockfile / node_modules，但 `package.json` 中该 dependency 的 spec 可能保持不变。此时 DSH 看不到唯一的 dependency 变化，会报：

```text
无法从依赖变更中确定安装了哪一个包
```

这是 DSH 0.1.7-rc.2 对重复 Git spec 的识别限制，不是插件 bundle metadata 缺失。

使用 GitHub 分发时，更新建议显式改变 ref，例如：

```powershell
dsh plugin --profile web add github:Soulize/dsh-continue-on-limit-host#<new-commit-sha>
```

或者先卸载后安装新的 GitHub ref。若需要 Plugin Manager 中更自然的按包名更新流程，建议发布到 npm，并使用包名 / `name@version` 安装，因为 DSH 对 registry spec 有按 package name 的回退识别。

### npm 发布是可选的

本仓库已经补齐 npm 元数据和 `publishConfig`。如果以后希望用户直接执行：

```powershell
dsh plugin --profile web add dsh-continue-on-limit-host
```

再登录 npm、确认包名可用并执行 `npm publish` 即可。**仅自己使用或通过 GitHub 分发时不需要 npm。**

## 配置 UI（DSH 0.1.7-rc.2）

打开：

```text
侧栏 -> Plugins / 插件 -> Installed / 已安装
-> dsh-continue-on-limit-host
-> continue-on-limit-host -> Configure / 配置
```

页面提供以下字段：

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `enabled` | `true` | 总开关 |
| `continueText` | `继续` | 达到输出上限后发送给同一会话的提示词 |
| `maxConsecutive` | `3` | 连续自动继续次数；`0` 表示不限次数 |
| `minIntervalMs` | `0` | 普通主会话的最小发送间隔；Subagent 为避免 Activation 先结算会同步入队，不等待延迟 |
| `includeSubagents` | `true` | 是否同时处理 `origin: subagent` 的会话；默认开启 |
| `debugLogging` | `false` | 输出 Host 诊断日志，用于确认是否捕获 `max-tokens` 以及为何没有续写 |

这些值属于当前 profile 的插件 Config。UI 保存后由 Harness ConfigEditor 写回 profile patch，并通过 volatile config 热更新到正在运行的插件。

Bundle 默认配置：

```yaml
- insert:
    - id: continue-on-limit-host
      name: dsh-continue-on-limit-host
      config:
        enabled: true
        continueText: '继续'
        maxConsecutive: 3
        minIntervalMs: 1500
        includeSubagents: false
```

## 后台会话的范围

“全局”指 **当前 Host 进程中已经加载的 live Agent/Session**。例如 A、B、C 三个会话都已经在运行，你当前只打开 A，B/C 命中 `max-tokens` 也能自动继续。

纯历史会话如果根本没有被加载成 live Agent，本插件不会为了扫描历史而主动恢复它；没有正在发生的 `turn/end` 事件，也就没有需要续写的运行。

## 安全保护

### 不覆盖已排队工作

准备发送续写前会再次检查：

```text
agent.inbox.nextTurn
agent.inbox.nextStep
```

任意队列已有内容时，本次自动继续放弃，避免在用户刚发的新消息或其他调度工作前插入“继续”。

### 连续次数上限

默认最多连续自动继续 3 次。如果模型以非 `max-tokens` 原因结束，或收到新的真人 `user` 输入，计数归零。需要长输出时可以在插件 UI 把 `maxConsecutive` 调大，或设为 `0` 表示不限次数。

### Subagent

`includeSubagents=true` 为默认值。官方 continuable child 命中 `max-tokens` 后会自然 settlement，并给 parent 投递 `subagent-settled` 通知，但不会自己再跑一轮；因此插件会在 child 的 `turn/end(max-tokens)` 事件处理中同步 `followup()`，让下一轮在 Activation 结算前进入 inbox。若手动关闭该开关，则跳过 `session.header.origin === "subagent"`。

## 开发 / 自检

```powershell
npm test
```

`test/smoke.cjs` 会先做 JS 语法检查；如果能找到 DSH 的 `node_modules`（可用 `DSH_HARNESS_NODE_MODULES` 指定），还会检查 Host 全局 `max-tokens` 续写策略和 Plugins 配置页注册。

## 兼容性

- 主要目标：DSH `0.1.7-rc.2`
- 声明范围：`>=0.1.7-rc.1 <0.2.0`
- Node.js：`>=20`

插件使用的关键公开接口：`session/event`、`ctx.agents.get()`、`Agent.followup()`、`Agent.inbox`、volatile `Config`、`plugins.row.config`。

## License

MIT


## 诊断日志

在插件管理页打开 `启用诊断日志` 后，Host 会用统一前缀输出：

```text
[dsh-continue-on-limit-host][debug]
```

重点看以下事件：

```text
TURN_END_CAPTURED
MAX_TOKENS_CAPTURED
AUTO_CONTINUE_QUEUED
AUTO_CONTINUE_SKIPPED
AUTO_CONTINUE_FAILED
SUBAGENT_END
SESSION_DISPOSED
```

理想的 Subagent 截断续写链路应该出现：

```text
TURN_END_CAPTURED ... reason=max-tokens ... origin=subagent
MAX_TOKENS_CAPTURED ...
... subagent path: synchronous followup
... calling agent.followup ...
AUTO_CONTINUE_QUEUED ...
```

如果只看到：

```text
SUBAGENT_END ... stopReason=max-tokens
```

却没有 `MAX_TOKENS_CAPTURED`，说明 lifecycle 看到了 token 上限，但 `session/event` 监听没有收到该 child 的 `turn/end`。

如果看到了 `MAX_TOKENS_CAPTURED`，随后出现：

```text
skip: liveAgent=no
```

说明事件抓到了，但 child Agent 在续写前已经不在 registry 中。

如果出现：

```text
AUTO_CONTINUE_QUEUED
```

但 UI 仍未出现下一轮模型请求，则应继续检查 Agent inbox claim / driver wakeup 路径。
