/** Host-side global auto-continuation for DeepSeek Harness. */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

const name = 'dsh-continue-on-limit-host'
const inject = ['agents']
const SOURCE_PLUGIN = 'dsh-continue-on-limit-host'

const DEFAULTS = Object.freeze({
  enabled: true,
  continueText: '继续',
  maxConsecutive: 3,
  minIntervalMs: 1500,
  includeSubagents: false,
})

/** Live profile-owned configuration. */
const Config = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled).volatile(),
  continueText: z.string().default(DEFAULTS.continueText).volatile(),
  maxConsecutive: z.number().step(1).min(0).max(1000).default(DEFAULTS.maxConsecutive).volatile(),
  minIntervalMs: z.number().step(1).min(0).max(600000).default(DEFAULTS.minIntervalMs).volatile(),
  includeSubagents: z.boolean().default(DEFAULTS.includeSubagents).volatile(),
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
    includeSubagents: unwrap(config?.includeSubagents, DEFAULTS.includeSubagents) === true,
  }
}

function apply(ctx, config) {
  const states = new Map()
  const logger = ctx.logger

  const stateFor = (session) => {
    let state = states.get(session)
    if (state === undefined) {
      state = { consecutive: 0, lastSentAt: 0, pendingSeq: undefined, timer: undefined }
      states.set(session, state)
    }
    return state
  }

  const clearPending = (state) => {
    if (state.timer !== undefined) clearTimeout(state.timer)
    state.timer = undefined
    state.pendingSeq = undefined
  }

  const reset = (session) => {
    const state = states.get(session)
    if (state === undefined) return
    clearPending(state)
    state.consecutive = 0
  }

  const eligibleAgent = (session, cfg) => {
    if (!cfg.includeSubagents && session.header?.origin === 'subagent') return undefined
    const agent = ctx.agents.get(session.id)
    if (agent === undefined || agent.session !== session) return undefined
    return agent
  }

  const scheduleContinuation = (session, event) => {
    const cfg = resolveConfig(config)
    if (!cfg.enabled) return
    const agent = eligibleAgent(session, cfg)
    if (agent === undefined) return

    const state = stateFor(session)
    if (state.pendingSeq === event.seq) return
    clearPending(state)
    state.pendingSeq = event.seq

    const delay = Math.max(0, state.lastSentAt + cfg.minIntervalMs - Date.now())
    state.timer = setTimeout(() => {
      state.timer = undefined
      if (state.pendingSeq !== event.seq) return
      state.pendingSeq = undefined

      const liveCfg = resolveConfig(config)
      if (!liveCfg.enabled) return
      const liveAgent = eligibleAgent(session, liveCfg)
      if (liveAgent === undefined) return

      // Do not jump ahead of human/plugin work already queued after the turn ended.
      if (liveAgent.inbox.nextTurn.length > 0 || liveAgent.inbox.nextStep.length > 0) {
        logger.info?.(`[dsh-continue-on-limit-host] skip session ${session.id}: pending inbox work exists`)
        return
      }

      if (liveCfg.maxConsecutive > 0 && state.consecutive >= liveCfg.maxConsecutive) {
        logger.warn?.(`[dsh-continue-on-limit-host] session ${session.id} reached auto-continue cap (${liveCfg.maxConsecutive})`)
        return
      }

      try {
        const message = createUserMessage({
          content: [{ type: 'text', text: liveCfg.continueText }],
          source: { kind: SOURCE_PLUGIN },
        })
        liveAgent.followup(message)
        state.consecutive += 1
        state.lastSentAt = Date.now()
        logger.info?.(`[dsh-continue-on-limit-host] session ${session.id} hit max-tokens; queued auto-continue #${state.consecutive}`)
      } catch (error) {
        logger.warn?.(`[dsh-continue-on-limit-host] failed to continue session ${session.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }, delay)
  }

  // 0.1.7 plugin manager: expose the volatile Config through this row, but let
  // this package render its own plugins.row.config page instead of auto schema UI.
  ctx.inject(['settings'], (sctx) => {
    sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber))
  })

  ctx.on('session/event', (session, event) => {
    if (event.type === 'user/message') {
      // Browser/user input starts a new chain. Synthetic/plugin context does not.
      if (event.data?.source?.kind === 'user') reset(session)
      return
    }
    if (event.type !== 'turn/end') return
    if (event.data.reason.kind !== 'max-tokens') {
      reset(session)
      return
    }
    scheduleContinuation(session, event)
  })

  ctx.on('session/disposed', (session) => {
    const state = states.get(session)
    if (state !== undefined) clearPending(state)
    states.delete(session)
  })

  ctx.effect(() => () => {
    for (const state of states.values()) clearPending(state)
    states.clear()
  }, 'dsh-continue-on-limit-host: timers')
}

export { Config, DEFAULTS, apply, inject, name, resolveConfig }
