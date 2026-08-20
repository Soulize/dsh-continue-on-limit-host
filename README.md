# dsh-continue-on-limit

本地小模型「输出达到上限」自动继续插件，面向 **DeepSeek Harness Web GUI**。

本地部署的模型输出 token 上限往往设得比较保守，回答到一半就截断——界面上出现「已达到输出 token 上限」的提示，得手动发送一次「继续」才能接着输出。本插件在检测到该提示出现时，**自动发送「继续」**，让回复自动接上，不用盯着界面手动点。

> **一键安装：**
> ```
> dsh plugin add qwert702/dsh-continue-on-limitout
> ```
> 装完重启 harness（`dsh web`）、刷新页面即可生效。插件完全隐形，不占用任何界面空间。

## 功能

- **自动继续**：会话出现「已达到输出 token 上限」提示（数据层是 `turn-max-tokens` 节点）时，自动以 `queue` 模式发送配置好的继续文字（默认「继续」），模型自动接着输出。
- **不打断用户**：只在提示是会话**最后一条**且会话空闲（没有正在回复、没有排队消息）时触发；用户中途发了新消息或自己操作了，就不会被插件打扰。
- **防死循环烧 token**：模型如果一直输出就截断，插件最多连续自动继续 `maxConsecutive` 次（默认 3）就停下，避免无限烧 token；模型正常完成一次回复或用户插话后，计数自动重置。
- **防重复发送**：同一条提示只处理一次；两次自动发送之间至少间隔 `minIntervalMs`（默认 1500ms）。
- **全自动、无 UI**：插件不渲染任何按钮或提示，仅在控制台打印操作日志（`[dsh-continue-on-limit] …`），方便排查。

## 工作原理

1. 插件挂载在会话头部坐席 `conversation.session.header.actions`（与 dsh-context-compressor 同一条链），但渲染为空，只订阅当前会话的快照。
2. harness 端 `turn/end` 事件带 `reason.kind === "max-tokens"` 时，UI 会落一条 `turn-max-tokens` 通知节点——这正是界面上「已达到输出 token 上限」提示的数据来源。
3. 快照里该节点出现在对话尾部时，插件通过会话面的 `prompt([{ type: 'text', text: '继续' }], 'queue')` 发送继续消息，与输入框手动发送走同一条通道。
4. 模型接着输出；若再次截断则再次自动继续，直到完成、用户介入或达到连续次数上限。

## 设置（可选）

在 `~/.dsh/settings.yaml` 添加命名空间 `dsh-continue-on-limit`：

```yaml
dsh-continue-on-limit:
  enabled: true        # 总开关
  continueText: '继续' # 发送的继续文字，可自定义，如 '请继续' / 'continue'
  maxConsecutive: 3    # 未完成回复时的连续自动继续次数上限（防无限烧 token）
  minIntervalMs: 1500  # 两次自动发送之间的最小间隔（毫秒）
```

不配置即用以上默认值。改完设置后重启 harness（或刷新页面，配置在页面加载时读取一次）。

## 仓库布局

- `lib/index.js` — 插件 host 半区：设置命名空间 + `GET /api/dsh-continue-on-limit/config` 配置读取路由。
- `lib/client.js` — 浏览器半区：纯策略函数（`evaluate` / `evaluateReset`）+ 隐形观察组件（订阅会话快照、自动发送继续）。
- `test/smoke.cjs` — `node test/smoke.cjs`：host 路由全路径（默认值/覆盖值/405）+ client 注册与 SSR 空渲染断言 + 策略全分支（禁用/忙碌/排队/无提示/非尾部/已处理/冷却/达上限/发送）+ 链重置逻辑 + 配置读取回退。

## 已知限制

- **只作用于打开中的会话**：插件订阅的是当前展示（staged）的会话，切到别的会话时只对该会话生效——这符合使用直觉：你在看哪个会话，哪个会话才会被自动继续。
- **提示必须处于尾部**：如果截断提示之后用户已经发了新消息，插件不会去追发「继续」（此时继续的意义已经变了，用户正在主导对话）。
- **无法区分手动「继续」**：如果用户恰好手动发送了与 `continueText` 相同的文字，插件会把它当作自己发的，不重置连续计数——最多让自动继续提前一轮停手，无其他影响。
- **配置读取一次**：浏览器半区在页面加载时读取一次配置，改设置需刷新页面（host 端每次请求都实时解析，但浏览器端不轮询）。
- **浏览器半区手动维护**：`lib/client.js` 为手写 bundle（与 dsh-context-compressor / dsh-auto-translate 同一技术路线），不经过构建步骤；改动后直接生效，冒烟测试兜底。

## License

MIT
