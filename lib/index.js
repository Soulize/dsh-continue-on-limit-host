/** Host-side global auto-continuation for DeepSeek Harness. */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm/assistant-stream'
import z from '@deepseek-ai/schemastery'

const name = 'dsh-continue-on-limit-host'
const inject = ['agents', 'profileContext']
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
  const logDir = join(ctx.profileContext.home, 'logs')
  const logPath = join(logDir, 'dsh-continue-on-limit-host.log')

  const fileLog = (message) => {
    try {
      mkdirSync(logDir, { recursive: true })
      appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`, 'utf8')
    } catch (error) {
      logger.warn?.(`${LOG_PREFIX} failed to write diagnostic log ${logPath}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // Always leave one activation breadcrumb so "no log" means the Host plugin
  // itself did not load, rather than merely that no max-tokens event arrived.
  const initialCfg = resolveConfig(config)
  fileLog(`ACTIVATED profile=${ctx.profileContext.name} enabled=${initialCfg.enabled} includeSubagents=${initialCfg.includeSubagents} debugLogging=${initialCfg.debugLogging}`)

  const debug = (cfg, message) => {
    if (!cfg.debugLogging) return
    const line = `${LOG_PREFIX}[debug] ${message}`
    fileLog(line)
    logger.warn?.(line)
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
      state = { consecutive: 0, lastSentAt: 0, lastHandledTurn: -1 }
      states.set(session, state)
    }
    return state
  }

  const reset = (session, reason = 'reset') => {
    const state = states.get(session)
    if (state === undefined) return
    const cfg = resolveConfig(config)
    debug(cfg, `${sessionLabel(session)} state reset reason=${reason} previousConsecutive=${state.consecutive}`)
    state.consecutive = 0
    state.lastHandledTurn = -1
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

  const turnHitMaxTokens = (agent, turn) => {
    const events = agent.session.snapshotEvents()
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event.type === 'turn/start' && event.data.turn === turn) break
      if (
        (event.type === 'assistant/message' || event.type === 'assistant/attempt')
        && event.data.turn === turn
      ) {
        const finish = lastAssistantStreamChunk(event.data.stream, 'finish')
        if (finish?.reason?.kind === 'max-tokens') return true
      }
    }
    return false
  }

  const queueContinuationAtStopping = async (agent, turn, signal) => {
    const session = agent.session
    let cfg = resolveConfig(config)
    if (!cfg.enabled) {
      debug(cfg, `${sessionLabel(session)} turn=${turn} max-tokens prestop captured but enabled=false`)
      return
    }
    if (!cfg.includeSubagents && session.header?.origin === 'subagent') {
      debug(cfg, `${sessionLabel(session)} turn=${turn} skip: includeSubagents=false`)
      return
    }
    if (!turnHitMaxTokens(agent, turn)) return

    const state = stateFor(session)
    if (state.lastHandledTurn === turn) {
      debug(cfg, `${sessionLabel(session)} turn=${turn} skip: already handled at turn-stopping`)
      return
    }

    debug(cfg,
      `MAX_TOKENS_PRESTOP_CAPTURED ${sessionLabel(session)} turn=${turn} status=${agent.status} `
      + `nextTurn=${agent.inbox.nextTurn.length} nextStep=${agent.inbox.nextStep.length}`,
    )

    // Hold the serial turn-stopping checkpoint rather than scheduling work
    // after turn/end. This keeps the current driver alive and prevents a
    // continuable subagent from entering its idle settlement boundary.
    const delay = Math.max(0, state.lastSentAt + cfg.minIntervalMs - Date.now())
    if (delay > 0) {
      debug(cfg, `${sessionLabel(session)} turn=${turn} waiting ${delay}ms inside turn-stopping checkpoint`)
      await new Promise((resolve) => setTimeout(resolve, delay))
      if (signal.aborted) {
        debug(cfg, `${sessionLabel(session)} turn=${turn} AUTO_CONTINUE_SKIPPED reason=turn-aborted-during-delay`)
        return
      }
      cfg = resolveConfig(config)
      if (!cfg.enabled) {
        debug(cfg, `${sessionLabel(session)} turn=${turn} AUTO_CONTINUE_SKIPPED reason=disabled-during-delay`)
        return
      }
    }

    // Respect work that another producer already queued. At turn-stopping,
    // nextStep is normally empty by contract, while nextTurn may contain
    // genuine user/plugin work that should outrank our synthetic continuation.
    if (agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) {
      state.lastHandledTurn = turn
      debug(cfg, `${sessionLabel(session)} turn=${turn} AUTO_CONTINUE_SKIPPED reason=pending-inbox`)
      return
    }

    if (cfg.maxConsecutive > 0 && state.consecutive >= cfg.maxConsecutive) {
      state.lastHandledTurn = turn
      logger.warn?.(`${LOG_PREFIX} session ${session.id} reached auto-continue cap (${cfg.maxConsecutive})`)
      debug(cfg, `${sessionLabel(session)} turn=${turn} AUTO_CONTINUE_SKIPPED reason=maxConsecutive`)
      return
    }

    try {
      const message = createUserMessage({
        content: [{ type: 'text', text: cfg.continueText }],
        source: { kind: SOURCE_PLUGIN },
      })
      debug(cfg, `${sessionLabel(session)} turn=${turn} calling agent.followup at turn-stopping messageId=${message.id}`)
      agent.followup(message)
      state.lastHandledTurn = turn
      state.consecutive += 1
      state.lastSentAt = Date.now()
      logger.info?.(`${LOG_PREFIX} session ${session.id} hit max-tokens; queued auto-continue #${state.consecutive}`)
      debug(cfg,
        `${sessionLabel(session)} turn=${turn} AUTO_CONTINUE_QUEUED_PRE_TURN_END messageId=${message.id} `
        + `nextTurnAfter=${agent.inbox.nextTurn.length} nextStepAfter=${agent.inbox.nextStep.length}`,
      )
    } catch (error) {
      logger.warn?.(`${LOG_PREFIX} failed to continue session ${session.id}: ${error instanceof Error ? error.message : String(error)}`)
      debug(cfg, `${sessionLabel(session)} turn=${turn} AUTO_CONTINUE_FAILED error=${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    }
  }

  // 0.1.7 plugin manager: expose the volatile Config through this row, but let
  // this package render its own plugins.row.config page instead of auto schema UI.
  ctx.inject(['settings'], (sctx) => {
    sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber))
  })

  // The actual continuation is queued at agent/turn-stopping, before turn/end.
  // At that checkpoint no Session.append is being published, and a queued
  // next-turn message is visible to turn() before it decides whether the live
  // driver should continue. Global observation includes child agent scopes.
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    await queueContinuationAtStopping(agent, turn, signal)
  }, { global: true })

  // turn/end remains the canonical durable confirmation used by the UI. We
  // observe it for diagnostics and counter reset, but never call followup from
  // inside this synchronous Session.append publication.
  ctx.on('session/event', (session, event) => {
    const cfg = resolveConfig(config)
    if (event.type === 'user/message') {
      if (cfg.debugLogging && event.data?.source?.kind === 'user') {
        debug(cfg, `${sessionLabel(session)} user/message source=user -> reset continuation chain`)
      }
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

    debug(cfg,
      `MAX_TOKENS_CONFIRMED ${sessionLabel(session)} seq=${event.seq} turn=${event.data.turn} `
      + `prestopHandled=${stateFor(session).lastHandledTurn === event.data.turn}`,
    )
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
    states.delete(session)
  }, { global: true })

  ctx.effect(() => () => {
    states.clear()
  }, 'dsh-continue-on-limit-host: state')
}

export { Config, DEFAULTS, apply, inject, name, resolveConfig }
