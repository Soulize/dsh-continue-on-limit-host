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
- Subagent 默认不自动续写，避免干扰 Harness 自己的子代理 continuation 协议；可在配置中显式开启。
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
| `minIntervalMs` | `1500` | 两次自动继续之间的最小间隔，单位 ms |
| `includeSubagents` | `false` | 是否同时处理 `origin: subagent` 的会话 |

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

`includeSubagents=false` 时跳过 `session.header.origin === "subagent"`。普通后台主会话以及普通 fork 会话不受这个开关影响。

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
