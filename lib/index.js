/** Host-side global auto-continuation for DeepSeek Harness. */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

const name = 'dsh-continue-on-limit-host'
const inject = ['agents']
const SOURCE_PLUGIN = 'dsh-continue-on-limit-host'
const LOG_PREFIX = '[dsh-continue-on-limit-host]'

const DEFAULTS = Object.freeze({
  enabled: true,
  continueText: '继续',
  maxConsecutive: 3,
  minIntervalMs: 0,
  includeSubagents: true,
  debugLogging: false,
})

/** Live profile-owned configuration. */
const Config = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled).volatile(),
  continueText: z.string().default(DEFAULTS.continueText).volatile(),
  maxConsecutive: z.number().step(1).min(0).max(1000).default(DEFAULTS.maxConsecutive).volatile(),
  minIntervalMs: z.number().step(1).min(0).max(600000).default(DEFAULTS.minIntervalMs).volatile(),
  includeSubagents: z.boolean().default(DEFAULTS.includeSubagents).volatile(),
  debugLogging: z.boolean().default(DEFAULTS.debugLogging).volatile(),
})

function unwrap(value, fallback) {
  const resolved = value !== null && typeof value === 'object' && typeof value.get === 'function'
    ? value.get()
    : value
  return resolved === undefined ? fallback : resolved
}

function resolveConfig(config) {
  const continueText = String(unwrap(config?.continueText, DEFAULTS.continueText)).trim() || DEFAULTS.continueText
  const maxConsecutive = Math.max(0, Math.min(1000, Math.trunc(Number(unwrap(config?.maxConsecutive, DEFAULTS.maxConsecutive)) || 0)))
  const minIntervalMs = Math.max(0, Math.min(600000, Math.trunc(Number(unwrap(config?.minIntervalMs, DEFAULTS.minIntervalMs)) || 0)))
  return {
    enabled: unwrap(config?.enabled, DEFAULTS.enabled) !== false,
    continueText,
    maxConsecutive,
    minIntervalMs,
    includeSubagents: unwrap(config?.includeSubagents, DEFAULTS.includeSubagents) !== false,
    debugLogging: unwrap(config?.debugLogging, DEFAULTS.debugLogging) === true,
  }
}

function apply(ctx, config) {
  const states = new Map()
  const logger = ctx.logger

  const debug = (cfg, message) => {
    if (cfg.debugLogging) logger.info?.(`${LOG_PREFIX}[debug] ${message}`)
  }

  const sessionLabel = (session) => {
    const origin = session.header?.origin ?? 'root'
    const parent = session.header?.parentSession ?? '-'
    return `session=${session.id} origin=${origin} parent=${parent}`
  }

  const agentSnapshot = (session) => {
    const agent = ctx.agents.get(session.id)
    if (agent === undefined) return { agent: undefined, text: 'liveAgent=no' }
    if (agent.session !== session) {
      return { agent: undefined, text: `liveAgent=mismatch registrySession=${agent.session?.id ?? '-'}` }
    }
    return {
      agent,
      text: `liveAgent=yes status=${agent.status ?? 'unknown'} nextTurn=${agent.inbox?.nextTurn?.length ?? '?'} nextStep=${agent.inbox?.nextStep?.length ?? '?'}`,
    }
  }

  const stateFor = (session) => {
    let state = states.get(session)
    if (state === undefined) {
      state = { consecutive: 0, lastSentAt: 0, lastHandledSeq: -1, pendingSeq: undefined, timer: undefined }
      states.set(session, state)
    }
    return state
  }

  const clearPending = (state) => {
    if (state.timer !== undefined) clearTimeout(state.timer)
    state.timer = undefined
    state.pendingSeq = undefined
  }

  const reset = (session, reason = 'reset') => {
    const state = states.get(session)
    if (state === undefined) return
    const cfg = resolveConfig(config)
    debug(cfg, `${sessionLabel(session)} state reset reason=${reason} previousConsecutive=${state.consecutive}`)
    clearPending(state)
    state.consecutive = 0
  }

  const eligibleAgent = (session, cfg) => {
    if (!cfg.includeSubagents && session.header?.origin === 'subagent') {
      debug(cfg, `${sessionLabel(session)} skip: includeSubagents=false`)
      return undefined
    }
    const snapshot = agentSnapshot(session)
    if (snapshot.agent === undefined) {
      debug(cfg, `${sessionLabel(session)} skip: ${snapshot.text}`)
      return undefined
    }
    return snapshot.agent
  }

  const enqueue = (session, event, state, cfg) => {
    if (state.lastHandledSeq === event.seq) {
      debug(cfg, `${sessionLabel(session)} seq=${event.seq} skip: already handled`)
      return
    }

    const agent = eligibleAgent(session, cfg)
    if (agent === undefined) return

    debug(cfg,
      `${sessionLabel(session)} seq=${event.seq} enqueue-check consecutive=${state.consecutive} `
      + `nextTurn=${agent.inbox.nextTurn.length} nextStep=${agent.inbox.nextStep.length}`,
    )

    // A human or another subsystem already queued work after this turn. Do not
    // jump ahead of it with a synthetic "continue".
    if (agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) {
      state.lastHandledSeq = event.seq
      logger.info?.(`${LOG_PREFIX} skip session ${session.id}: pending inbox work exists`)
      debug(cfg, `${sessionLabel(session)} seq=${event.seq} AUTO_CONTINUE_SKIPPED reason=pending-inbox`)
      return
    }

    if (cfg.maxConsecutive > 0 && state.consecutive >= cfg.maxConsecutive) {
      state.lastHandledSeq = event.seq
      logger.warn?.(`${LOG_PREFIX} session ${session.id} reached auto-continue cap (${cfg.maxConsecutive})`)
      debug(cfg, `${sessionLabel(session)} seq=${event.seq} AUTO_CONTINUE_SKIPPED reason=maxConsecutive`)
      return
    }

    try {
      const message = createUserMessage({
        content: [{ type: 'text', text: cfg.continueText }],
        source: { kind: SOURCE_PLUGIN },
      })
      // Deliberately synchronous for continuable subagents. Their official
      // continuation manager treats an idle, empty-inbox child as settled and
      // may dispose its Activation immediately after max-tokens. Enqueueing
      // inside the turn/end event keeps the Agent non-idle and prevents that
      // settlement race.
      debug(cfg, `${sessionLabel(session)} seq=${event.seq} calling agent.followup messageId=${message.id}`)
      agent.followup(message)
      state.lastHandledSeq = event.seq
      state.consecutive += 1
      state.lastSentAt = Date.now()
      logger.info?.(`${LOG_PREFIX} session ${session.id} hit max-tokens; queued auto-continue #${state.consecutive}`)
      debug(cfg,
        `${sessionLabel(session)} seq=${event.seq} AUTO_CONTINUE_QUEUED messageId=${message.id} `
        + `nextTurnAfter=${agent.inbox.nextTurn.length} nextStepAfter=${agent.inbox.nextStep.length}`,
      )
    } catch (error) {
      logger.warn?.(`${LOG_PREFIX} failed to continue session ${session.id}: ${error instanceof Error ? error.message : String(error)}`)
      debug(cfg, `${sessionLabel(session)} seq=${event.seq} AUTO_CONTINUE_FAILED error=${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    }
  }

  const scheduleContinuation = (session, event) => {
    const cfg = resolveConfig(config)
    if (!cfg.enabled) {
      debug(cfg, `${sessionLabel(session)} seq=${event.seq} max-tokens captured but enabled=false`)
      return
    }
    const agent = eligibleAgent(session, cfg)
    if (agent === undefined) return

    const state = stateFor(session)
    if (state.lastHandledSeq === event.seq || state.pendingSeq === event.seq) {
      debug(cfg, `${sessionLabel(session)} seq=${event.seq} skip: duplicate max-tokens event`)
      return
    }
    clearPending(state)

    // Continuable subagents must be re-queued synchronously. The official
    // manager exposes "continuation" as later-message/cold-resume capability,
    // not automatic retry on max-tokens, and it naturally settles an empty
    // child Activation. Waiting on setTimeout here can therefore lose the child.
    if (session.header?.origin === 'subagent') {
      debug(cfg, `${sessionLabel(session)} seq=${event.seq} subagent path: synchronous followup`)
      enqueue(session, event, state, cfg)
      return
    }

    const delay = Math.max(0, state.lastSentAt + cfg.minIntervalMs - Date.now())
    if (delay === 0) {
      debug(cfg, `${sessionLabel(session)} seq=${event.seq} root path: immediate followup`)
      enqueue(session, event, state, cfg)
      return
    }

    debug(cfg, `${sessionLabel(session)} seq=${event.seq} root path: delaying followup by ${delay}ms`)
    state.pendingSeq = event.seq
    state.timer = setTimeout(() => {
      state.timer = undefined
      if (state.pendingSeq !== event.seq) return
      state.pendingSeq = undefined
      const liveCfg = resolveConfig(config)
      if (!liveCfg.enabled) {
        debug(liveCfg, `${sessionLabel(session)} seq=${event.seq} delayed continuation cancelled: enabled=false`)
        return
      }
      enqueue(session, event, state, liveCfg)
    }, delay)
  }

  // 0.1.7 plugin manager: expose the volatile Config through this row, but let
  // this package render its own plugins.row.config page instead of auto schema UI.
  ctx.inject(['settings'], (sctx) => {
    sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber))
  })

  // This listener is intentionally global: subagents run in agent-owned scopes.
  // Without global observation a Host plugin can miss a child Session's turn/end.
  ctx.on('session/event', (session, event) => {
    const cfg = resolveConfig(config)
    if (event.type === 'user/message') {
      if (cfg.debugLogging && event.data?.source?.kind === 'user') {
        debug(cfg, `${sessionLabel(session)} user/message source=user -> reset continuation chain`)
      }
      // Browser/user input starts a new chain. Synthetic/plugin context does not.
      if (event.data?.source?.kind === 'user') reset(session, 'human-user-message')
      return
    }
    if (event.type !== 'turn/end') return

    const snapshot = agentSnapshot(session)
    debug(cfg,
      `TURN_END_CAPTURED ${sessionLabel(session)} seq=${event.seq} turn=${event.data.turn} `
      + `reason=${event.data.reason.kind} ${snapshot.text}`,
    )

    if (event.data.reason.kind !== 'max-tokens') {
      reset(session, `turn-end:${event.data.reason.kind}`)
      return
    }

    debug(cfg, `MAX_TOKENS_CAPTURED ${sessionLabel(session)} seq=${event.seq} turn=${event.data.turn}`)
    scheduleContinuation(session, event)
  }, { global: true })

  // Secondary diagnostic: if this appears with stopReason=max-tokens but no
  // MAX_TOKENS_CAPTURED line above, the child lifecycle saw the limit while our
  // session/event path did not. This edge fires after a continuable Activation
  // has settled, so it is diagnostic only and is deliberately not used to retry.
  ctx.on('subagent/end', (info) => {
    const cfg = resolveConfig(config)
    debug(cfg,
      `SUBAGENT_END id=${info.id ?? '-'} runId=${info.runId ?? '-'} provider=${info.provider ?? '-'} `
      + `stopReason=${info.stopReason ?? '-'} liveAgent=${info.id !== undefined && ctx.agents.get(info.id) !== undefined ? 'yes' : 'no'}`,
    )
  }, { global: true })

  ctx.on('session/disposed', (session) => {
    const cfg = resolveConfig(config)
    debug(cfg, `SESSION_DISPOSED ${sessionLabel(session)}`)
    const state = states.get(session)
    if (state !== undefined) clearPending(state)
    states.delete(session)
  }, { global: true })

  ctx.effect(() => () => {
    for (const state of states.values()) clearPending(state)
    states.clear()
  }, 'dsh-continue-on-limit-host: timers')
}

export { Config, DEFAULTS, apply, inject, name, resolveConfig }
