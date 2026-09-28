window.__ModuleLoader__.load({
  id: 'dsh-continue-on-limit-host',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    const DEFAULTS = Object.freeze({
      enabled: true,
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
            description: 'Host 全局监听 turn/end → max-tokens；后台已加载会话即使不在当前页面也会自动续写。',
            enabled: '启用自动继续',
            continueText: '继续提示词',
            maxConsecutive: '最大连续自动继续次数',
            maxConsecutiveHint: '0 表示不限次数；默认 3。正常完成或用户发送新消息后重新计数。',
            minIntervalMs: '最小发送间隔（毫秒）',
            minIntervalHint: '仅用于普通主会话。Subagent 为避免官方 Activation 在空闲时结算，会在 max-tokens 的 turn/end 事件中同步入队，不等待此延迟。',
            includeSubagents: '同时处理 Subagent 会话',
            includeSubagentsHint: '默认开启。官方 continuation manager 只提供后续消息/冷恢复能力，不会在 max-tokens 后自动让 child 继续。',
            debugLogging: '启用诊断日志',
            debugLoggingHint: '开启后会在 Host 日志输出 TURN_END_CAPTURED、MAX_TOKENS_CAPTURED、AUTO_CONTINUE_QUEUED/SKIPPED/FAILED、SUBAGENT_END 等关键事件。',
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
            description: 'The Host listens globally for turn/end → max-tokens, so loaded background sessions can resume even when another conversation is open.',
            enabled: 'Enable auto-continue',
            continueText: 'Continuation prompt',
            maxConsecutive: 'Maximum consecutive auto-continues',
            maxConsecutiveHint: '0 means unlimited; default is 3. The counter resets after normal completion or new human input.',
            minIntervalMs: 'Minimum send interval (ms)',
            minIntervalHint: 'Applies to ordinary root sessions only. Subagents are queued synchronously at max-tokens so the official Activation cannot settle first.',
            includeSubagents: 'Include Subagent sessions',
            includeSubagentsHint: 'On by default. Harness continuation provides later-message/cold-resume capability; it does not automatically retry a child after max-tokens.',
            debugLogging: 'Enable diagnostic logging',
            debugLoggingHint: 'Logs TURN_END_CAPTURED, MAX_TOKENS_CAPTURED, AUTO_CONTINUE_QUEUED/SKIPPED/FAILED, SUBAGENT_END and related Host diagnostics.',
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
