window.__ModuleLoader__.load({
  id: 'dsh-continue-on-limit-host',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    const DEFAULTS = Object.freeze({
      enabled: true,
      continuationMode: 'followup',
      steerToolCallPolicy: 'discard',
      continueText: '继续',
      maxConsecutive: 3,
      minIntervalMs: 0,
      includeSubagents: true,
      debugLogging: false,
    })

    function isZh() {
      if (typeof navigator === 'undefined') return true
      const lang = String((navigator.languages && navigator.languages[0]) || navigator.language || 'zh').toLowerCase()
      return lang.startsWith('zh')
    }

    function copy() {
      return isZh()
        ? {
            summary: '后台会话达到输出 token 上限时自动继续，无需保持会话打开',
            title: '自动继续设置',
            description: 'Follow-up 在 agent/turn-stopping 续写；Steer 在 llm/stream 截获 max-tokens，把它只作为插件内部触发信号。',
            enabled: '启用自动继续',
            continuationMode: '续写实现',
            continuationModeFollowup: 'Follow-up（新 Turn，默认）',
            continuationModeSteer: 'Steer（同 Turn，透明隐藏 max-tokens）',
            continuationModeHint: '二选一，运行时严格互斥。Follow-up 保留真实 max-tokens 并加入 next-turn；Steer 在 llm/stream 截获 max-tokens，使 AgentLoop 和持久 Assistant stream 不看到该标识。',
            steerToolCallPolicy: 'Steer 截断 Tool Call 策略',
            steerToolCallPolicyDiscard: '安全丢弃并继续（0.4.1，默认）',
            steerToolCallPolicyPassthrough: '兼容 0.4.0：信任已闭合 Tool Call',
            steerToolCallPolicyHint: '0.4.1 会从首个 tool-call 起暂存；若最终是 max-tokens，则丢弃该响应中的全部 tool-call 并 steer。0.4.0 兼容模式不暂存；只要截断前出现过已闭合 tool-call，就伪装为 tool-calls 交给 Harness 执行，不额外 steer。后者可避免模型续写时跳过先前调用，但会绕过 DSH 对 max-tokens 工具调用的保守丢弃策略。',
            continueText: '继续提示词',
            maxConsecutive: '最大连续自动继续次数',
            maxConsecutiveHint: '0 表示不限次数；默认 3。正常完成或用户发送新消息后重新计数。',
            minIntervalMs: '最小发送间隔（毫秒）',
            minIntervalHint: 'Follow-up 在 agent/turn-stopping 等待；Steer 在截获 llm finish 后等待。',
            includeSubagents: '同时处理 Subagent 会话',
            includeSubagentsHint: '默认开启。官方 continuation manager 只提供后续消息/冷恢复能力，不会在 max-tokens 后自动让 child 继续。',
            debugLogging: '启用诊断日志',
            debugLoggingHint: '开启后会同时写入 $DSH_HOME/logs/dsh-continue-on-limit-host.log，并尝试输出到 Host 控制台。插件每次成功加载都会无条件写一条 ACTIVATED。',
            save: '保存',
            saving: '保存中…',
            discard: '放弃修改',
            saved: '已保存，运行中的插件实例会热更新配置。',
            refused: '保存被拒绝或配置已被其他页面修改，请重新打开此页面。',
            failed: '保存失败：',
            unavailable: '此配置当前不可用。请确认插件运行在 DSH 0.1.7-rc.1 或更高版本的 Web profile。',
            readonly: '当前 profile 配置为只读。',
          }
        : {
            summary: 'Auto-continue capped background sessions without keeping them open',
            title: 'Auto-continue settings',
            description: 'Follow-up continues at agent/turn-stopping; Steer intercepts max-tokens at llm/stream and keeps it private to the plugin.',
            enabled: 'Enable auto-continue',
            continuationMode: 'Continuation implementation',
            continuationModeFollowup: 'Follow-up (new Turn, default)',
            continuationModeSteer: 'Steer (same Turn, hide max-tokens)',
            continuationModeHint: 'Choose exactly one. Follow-up preserves the real max-tokens finish and queues next-turn. Steer intercepts max-tokens in llm/stream so AgentLoop and the durable Assistant stream never see that marker.',
            steerToolCallPolicy: 'Steer capped tool-call policy',
            steerToolCallPolicyDiscard: 'Discard and continue (v0.4.1, default)',
            steerToolCallPolicyPassthrough: 'v0.4.0 compatibility: trust closed tool calls',
            steerToolCallPolicyHint: 'v0.4.1 buffers from the first tool call; if the response ends max-tokens, it drops all tool calls and steers. v0.4.0 compatibility does not buffer; if any tool call reached block-end before the cap, it exposes tool-calls to Harness and does not add a steer. This can preserve calls the model may skip after continuation, but bypasses DSH\'s conservative capped-tool pruning.',
            continueText: 'Continuation prompt',
            maxConsecutive: 'Maximum consecutive auto-continues',
            maxConsecutiveHint: '0 means unlimited; default is 3. The counter resets after normal completion or new human input.',
            minIntervalMs: 'Minimum send interval (ms)',
            minIntervalHint: 'Follow-up waits at agent/turn-stopping; Steer waits after intercepting the LLM finish.',
            includeSubagents: 'Include Subagent sessions',
            includeSubagentsHint: 'On by default. Harness continuation provides later-message/cold-resume capability; it does not automatically retry a child after max-tokens.',
            debugLogging: 'Enable diagnostic logging',
            debugLoggingHint: 'Writes diagnostics to $DSH_HOME/logs/dsh-continue-on-limit-host.log and also attempts Host console output. Every successful plugin load writes an ACTIVATED line even when debug logging is off.',
            save: 'Save',
            saving: 'Saving…',
            discard: 'Discard',
            saved: 'Saved. The running plugin instance receives the live configuration update.',
            refused: 'The write was refused or the configuration changed elsewhere. Reopen this page and try again.',
            failed: 'Save failed: ',
            unavailable: 'Configuration is unavailable. Use a DSH 0.1.7-rc.1+ Web profile with this plugin enabled.',
            readonly: 'This profile configuration is read-only.',
          }
    }

    function normalized(value) {
      const v = value && typeof value === 'object' ? value : {}
      return {
        enabled: v.enabled !== false,
        continuationMode: v.continuationMode === 'steer' ? 'steer' : 'followup',
        steerToolCallPolicy: v.steerToolCallPolicy === 'passthrough' ? 'passthrough' : 'discard',
        continueText: typeof v.continueText === 'string' && v.continueText.trim() ? v.continueText : DEFAULTS.continueText,
        maxConsecutive: String(Number.isFinite(Number(v.maxConsecutive)) ? Math.max(0, Math.min(1000, Math.trunc(Number(v.maxConsecutive)))) : DEFAULTS.maxConsecutive),
        minIntervalMs: String(Number.isFinite(Number(v.minIntervalMs)) ? Math.max(0, Math.min(600000, Math.trunc(Number(v.minIntervalMs)))) : DEFAULTS.minIntervalMs),
        includeSubagents: v.includeSubagents === true,
        debugLogging: v.debugLogging === true,
      }
    }

    const styles = {
      root: { display: 'grid', gap: 16, maxWidth: 720, padding: '4px 0 18px' },
      intro: { margin: 0, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 },
      row: { display: 'grid', gap: 6 },
      label: { fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      hint: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 },
      input: { width: '100%', boxSizing: 'border-box', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 7, padding: '8px 10px', font: 'inherit', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-specific-input-major)' },
      number: { width: 180, boxSizing: 'border-box', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 7, padding: '8px 10px', font: 'inherit', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-specific-input-major)' },
      check: { display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer' },
      actions: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', paddingTop: 4 },
      button: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 7, padding: '7px 13px', font: 'inherit', cursor: 'pointer', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-elevated)' },
      primary: { border: 0, borderRadius: 7, padding: '8px 14px', font: 'inherit', cursor: 'pointer', color: 'white', background: 'var(--dsw-alias-brand-primary, #4f6ef7)' },
      status: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      error: { fontSize: 12, color: 'var(--dsw-alias-status-error, #d33)' },
    }

    function ConfigPage({ form }) {
      const t = copy()
      const snapshot = form?.state
      const [draft, setDraft] = React.useState(() => normalized(snapshot?.value))
      const [revision, setRevision] = React.useState(snapshot?.revision)
      const [dirty, setDirty] = React.useState(false)
      const [saving, setSaving] = React.useState(false)
      const [notice, setNotice] = React.useState('')
      const [error, setError] = React.useState('')

      React.useEffect(() => {
        if (snapshot?.status !== 'ready') return
        setDraft(normalized(snapshot.value))
        setRevision(snapshot.revision)
        setDirty(false)
        setError('')
      }, [snapshot?.status, snapshot?.revision])

      if (!form || !snapshot || snapshot.status === 'loading') {
        return React.createElement('div', { style: styles.root }, React.createElement('p', { style: styles.intro }, t.unavailable))
      }
      if (snapshot.status !== 'ready') {
        return React.createElement('div', { style: styles.root }, React.createElement('p', { style: styles.intro }, t.unavailable))
      }

      const disabled = saving || !snapshot.writable
      const edit = (patch) => {
        setDraft((current) => ({ ...current, ...patch }))
        setDirty(true)
        setNotice('')
        setError('')
      }
      const discard = () => {
        setDraft(normalized(snapshot.value))
        setRevision(snapshot.revision)
        setDirty(false)
        setNotice('')
        setError('')
      }
      const save = async () => {
        const continueText = String(draft.continueText ?? '').trim()
        if (!continueText) {
          setError(t.failed + 'continuation prompt cannot be empty')
          return
        }
        const maxConsecutive = Math.max(0, Math.min(1000, Math.trunc(Number(draft.maxConsecutive) || 0)))
        const minIntervalMs = Math.max(0, Math.min(600000, Math.trunc(Number(draft.minIntervalMs) || 0)))
        const next = { ...draft, continueText, maxConsecutive: String(maxConsecutive), minIntervalMs: String(minIntervalMs) }
        setDraft(next)
        setSaving(true)
        setNotice('')
        setError('')
        try {
          const ok = await form.mutate([
            { op: 'set', path: ['enabled'], value: next.enabled === true },
            { op: 'set', path: ['continuationMode'], value: next.continuationMode === 'steer' ? 'steer' : 'followup' },
            { op: 'set', path: ['steerToolCallPolicy'], value: next.steerToolCallPolicy === 'passthrough' ? 'passthrough' : 'discard' },
            { op: 'set', path: ['continueText'], value: continueText },
            { op: 'set', path: ['maxConsecutive'], value: maxConsecutive },
            { op: 'set', path: ['minIntervalMs'], value: minIntervalMs },
            { op: 'set', path: ['includeSubagents'], value: next.includeSubagents === true },
            { op: 'set', path: ['debugLogging'], value: next.debugLogging === true },
          ], revision)
          if (ok) {
            setDirty(false)
            setNotice(t.saved)
          } else {
            setError(t.refused)
          }
        } catch (e) {
          setError(t.failed + (e instanceof Error ? e.message : String(e)))
        } finally {
          setSaving(false)
        }
      }

      const checkbox = (field, label, hint) => React.createElement('div', { style: styles.row },
        React.createElement('label', { style: styles.check },
          React.createElement('input', {
            type: 'checkbox',
            checked: draft[field] === true,
            disabled,
            onChange: (event) => edit({ [field]: event.target.checked }),
          }),
          React.createElement('span', { style: styles.label }, label),
        ),
        hint ? React.createElement('div', { style: styles.hint }, hint) : null,
      )

      return React.createElement('div', { style: styles.root, 'data-continue-on-limit-config': '' },
        React.createElement('p', { style: styles.intro }, t.description),
        checkbox('enabled', t.enabled),
        React.createElement('div', { style: styles.row },
          React.createElement('label', { style: styles.label, htmlFor: 'continue-on-limit-mode' }, t.continuationMode),
          React.createElement('select', {
            id: 'continue-on-limit-mode',
            style: styles.input,
            value: draft.continuationMode,
            disabled,
            onChange: (event) => edit({ continuationMode: event.target.value === 'steer' ? 'steer' : 'followup' }),
          },
          React.createElement('option', { value: 'followup' }, t.continuationModeFollowup),
          React.createElement('option', { value: 'steer' }, t.continuationModeSteer),
          ),
          React.createElement('div', { style: styles.hint }, t.continuationModeHint),
        ),
        draft.continuationMode === 'steer' ? React.createElement('div', { style: styles.row },
          React.createElement('label', { style: styles.label, htmlFor: 'continue-on-limit-tool-policy' }, t.steerToolCallPolicy),
          React.createElement('select', {
            id: 'continue-on-limit-tool-policy',
            style: styles.input,
            value: draft.steerToolCallPolicy,
            disabled,
            onChange: (event) => edit({ steerToolCallPolicy: event.target.value === 'passthrough' ? 'passthrough' : 'discard' }),
          },
          React.createElement('option', { value: 'discard' }, t.steerToolCallPolicyDiscard),
          React.createElement('option', { value: 'passthrough' }, t.steerToolCallPolicyPassthrough),
          ),
          React.createElement('div', { style: styles.hint }, t.steerToolCallPolicyHint),
        ) : null,
        React.createElement('div', { style: styles.row },
          React.createElement('label', { style: styles.label, htmlFor: 'continue-on-limit-text' }, t.continueText),
          React.createElement('input', {
            id: 'continue-on-limit-text',
            style: styles.input,
            value: draft.continueText,
            disabled,
            onChange: (event) => edit({ continueText: event.target.value }),
          }),
        ),
        React.createElement('div', { style: styles.row },
          React.createElement('label', { style: styles.label, htmlFor: 'continue-on-limit-max' }, t.maxConsecutive),
          React.createElement('input', {
            id: 'continue-on-limit-max', type: 'number', min: 0, max: 1000, step: 1,
            style: styles.number, value: draft.maxConsecutive, disabled,
            onChange: (event) => edit({ maxConsecutive: event.target.value }),
          }),
          React.createElement('div', { style: styles.hint }, t.maxConsecutiveHint),
        ),
        React.createElement('div', { style: styles.row },
          React.createElement('label', { style: styles.label, htmlFor: 'continue-on-limit-interval' }, t.minIntervalMs),
          React.createElement('input', {
            id: 'continue-on-limit-interval', type: 'number', min: 0, max: 600000, step: 100,
            style: styles.number, value: draft.minIntervalMs, disabled,
            onChange: (event) => edit({ minIntervalMs: event.target.value }),
          }),
          React.createElement('div', { style: styles.hint }, t.minIntervalHint),
        ),
        checkbox('includeSubagents', t.includeSubagents, t.includeSubagentsHint),
        checkbox('debugLogging', t.debugLogging, t.debugLoggingHint),
        !snapshot.writable ? React.createElement('div', { style: styles.status }, t.readonly) : null,
        React.createElement('div', { style: styles.actions },
          React.createElement('button', { type: 'button', style: styles.button, disabled: saving || !dirty, onClick: discard }, t.discard),
          React.createElement('button', { type: 'button', style: styles.primary, disabled: disabled || !dirty, onClick: save }, saving ? t.saving : t.save),
          notice ? React.createElement('span', { style: styles.status, role: 'status' }, notice) : null,
          error ? React.createElement('span', { style: styles.error, role: 'alert' }, error) : null,
        ),
      )
    }

    const inject = ['slots']
    function apply(ctx) {
      ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: 'dsh-continue-on-limit-host#continue-on-limit-host',
      }, ({ view, form }) => view === 'summary'
        ? copy().summary
        : React.createElement(ConfigPage, { form })))
    }

    exports.DEFAULTS = DEFAULTS
    exports.ConfigPage = ConfigPage
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
