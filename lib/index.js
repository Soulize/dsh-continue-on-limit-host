/** Host-side global auto-continuation for DeepSeek Harness. */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createUserMessage, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm/assistant-stream'
import z from '@deepseek-ai/schemastery'

const name = 'dsh-continue-on-limit-host'
const inject = ['agents', 'profileContext']
const SOURCE_PLUGIN = 'dsh-continue-on-limit-host'
const LOG_PREFIX = '[dsh-continue-on-limit-host]'
const MODE_FOLLOWUP = 'followup'
const MODE_STEER = 'steer'

const DEFAULTS = Object.freeze({
  enabled: true,
  continuationMode: MODE_FOLLOWUP,
  continueText: '继续',
  maxConsecutive: 3,
  minIntervalMs: 0,
  includeSubagents: true,
  debugLogging: false,
})

/** Live profile-owned configuration. */
const Config = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled).volatile(),
  continuationMode: z.string().default(DEFAULTS.continuationMode).volatile(),
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

function normalizeMode(value) {
  return value === MODE_STEER ? MODE_STEER : MODE_FOLLOWUP
}

function resolveConfig(config) {
  const continueText = String(unwrap(config?.continueText, DEFAULTS.continueText)).trim() || DEFAULTS.continueText
  const maxConsecutive = Math.max(0, Math.min(1000, Math.trunc(Number(unwrap(config?.maxConsecutive, DEFAULTS.maxConsecutive)) || 0)))
  const minIntervalMs = Math.max(0, Math.min(600000, Math.trunc(Number(unwrap(config?.minIntervalMs, DEFAULTS.minIntervalMs)) || 0)))
  return {
    enabled: unwrap(config?.enabled, DEFAULTS.enabled) !== false,
    continuationMode: normalizeMode(unwrap(config?.continuationMode, DEFAULTS.continuationMode)),
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

  const initialCfg = resolveConfig(config)
  fileLog(
    `ACTIVATED profile=${ctx.profileContext.name} enabled=${initialCfg.enabled} mode=${initialCfg.continuationMode} `
    + `includeSubagents=${initialCfg.includeSubagents} debugLogging=${initialCfg.debugLogging}`,
  )

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

  const stateFor = (session, mode = resolveConfig(config).continuationMode) => {
    let state = states.get(session)
    if (state === undefined) {
      state = {
        mode,
        consecutive: 0,
        lastSentAt: 0,
        lastHandledFinishSeq: -1,
      }
      states.set(session, state)
      return state
    }

    // Hot switching modes is a hard boundary: never let one implementation's
    // counters or handled markers drive the other implementation.
    if (state.mode !== mode) {
      state.mode = mode
      state.consecutive = 0
      state.lastSentAt = 0
      state.lastHandledFinishSeq = -1
    }
    return state
  }

  const reset = (session, reason = 'reset') => {
    const state = states.get(session)
    if (state === undefined) return
    const cfg = resolveConfig(config)
    debug(cfg,
      `${sessionLabel(session)} mode=${state.mode} state reset reason=${reason} `
      + `previousConsecutive=${state.consecutive}`,
    )
    state.consecutive = 0
    state.lastSentAt = 0
    state.lastHandledFinishSeq = -1
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

  /**
   * Find the newest settled provider finish in this turn.
   * Follow-up mode uses the durable Assistant settlement at turn-stopping.
   */
  const latestAssistantFinish = (session, turn) => {
    const events = session.snapshotEvents()
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event.type === 'turn/start' && event.data.turn === turn) break
      if (
        (event.type === 'assistant/message' || event.type === 'assistant/attempt')
        && event.data.turn === turn
      ) {
        const finish = lastAssistantStreamChunk(event.data.stream, 'finish')
        if (finish !== undefined) {
          return {
            kind: finish.reason.kind,
            seq: event.seq,
            step: event.data.step,
          }
        }
      }
    }
    return undefined
  }

  const waitForInterval = async (session, state, label, signal, cfg) => {
    const delay = Math.max(0, state.lastSentAt + cfg.minIntervalMs - Date.now())
    if (delay === 0) return cfg

    debug(cfg,
      `${sessionLabel(session)} mode=${cfg.continuationMode} ${label} waiting=${delay}ms`,
    )
    await new Promise((resolve) => setTimeout(resolve, delay))
    if (signal?.aborted) {
      debug(cfg,
        `${sessionLabel(session)} mode=${cfg.continuationMode} ${label} `
        + 'AUTO_CONTINUE_SKIPPED reason=aborted-during-delay',
      )
      return undefined
    }

    const liveCfg = resolveConfig(config)
    if (!liveCfg.enabled || liveCfg.continuationMode !== cfg.continuationMode) {
      debug(liveCfg,
        `${sessionLabel(session)} ${label} AUTO_CONTINUE_SKIPPED `
        + 'reason=disabled-or-mode-changed-during-delay',
      )
      return undefined
    }
    if (!liveCfg.includeSubagents && session.header?.origin === 'subagent') return undefined
    return liveCfg
  }

  const canSendFollowup = (agent, session, state, finish, turn, cfg) => {
    if (state.lastHandledFinishSeq === finish.seq) {
      debug(cfg,
        `${sessionLabel(session)} mode=followup turn=${turn} `
        + `finishSeq=${finish.seq} skip=already-handled`,
      )
      return false
    }

    if (agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) {
      state.lastHandledFinishSeq = finish.seq
      debug(cfg,
        `${sessionLabel(session)} mode=followup turn=${turn} `
        + 'AUTO_CONTINUE_SKIPPED reason=pending-inbox',
      )
      return false
    }

    if (cfg.maxConsecutive > 0 && state.consecutive >= cfg.maxConsecutive) {
      state.lastHandledFinishSeq = finish.seq
      logger.warn?.(`${LOG_PREFIX} session ${session.id} reached auto-continue cap (${cfg.maxConsecutive})`)
      debug(cfg,
        `${sessionLabel(session)} mode=followup turn=${turn} `
        + 'AUTO_CONTINUE_SKIPPED reason=maxConsecutive',
      )
      return false
    }
    return true
  }

  /**
   * Follow-up implementation: enqueue a distinct next turn before this turn
   * closes. This path preserves the real max-tokens settlement and turn/end.
   */
  const continueWithFollowup = async (agent, turn, signal, initialCfg, finish) => {
    const session = agent.session
    const state = stateFor(session, MODE_FOLLOWUP)
    let cfg = await waitForInterval(session, state, `turn=${turn} checkpoint=turn-stopping`, signal, initialCfg)
    if (cfg === undefined) return
    if (!canSendFollowup(agent, session, state, finish, turn, cfg)) return

    try {
      const message = createUserMessage({
        content: [{ type: 'text', text: cfg.continueText }],
        source: { kind: SOURCE_PLUGIN },
      })
      debug(cfg,
        `FOLLOWUP_MAX_TOKENS_CAPTURED ${sessionLabel(session)} turn=${turn} `
        + `step=${finish.step ?? '-'} finishSeq=${finish.seq}`,
      )
      agent.followup(message)
      state.lastHandledFinishSeq = finish.seq
      state.consecutive += 1
      state.lastSentAt = Date.now()
      logger.info?.(
        `${LOG_PREFIX} session ${session.id} hit max-tokens; followup auto-continue #${state.consecutive}`,
      )
      debug(cfg,
        `${sessionLabel(session)} mode=followup turn=${turn} FOLLOWUP_QUEUED messageId=${message.id} `
        + `nextTurnAfter=${agent.inbox.nextTurn.length} nextStepAfter=${agent.inbox.nextStep.length}`,
      )
    } catch (error) {
      logger.warn?.(
        `${LOG_PREFIX} failed followup continuation for session ${session.id}: `
        + `${error instanceof Error ? error.message : String(error)}`,
      )
      debug(cfg,
        `${sessionLabel(session)} mode=followup turn=${turn} AUTO_CONTINUE_FAILED `
        + `error=${error instanceof Error ? error.stack ?? error.message : String(error)}`,
      )
    }
  }

  /**
   * Preserve adapter replay metadata while hiding the native cap marker where
   * the shipped pi-ai adapter stores it. DeepSeek Messages replay metadata does
   * not carry its native stop reason.
   */
  const sanitizeMaskedReplayState = (replayState, maskedKind) => {
    if (replayState === undefined || replayState === null || typeof replayState !== 'object') return replayState
    const response = replayState.response
    if (
      response === undefined
      || response === null
      || typeof response !== 'object'
      || response.kind !== 'pi-ai'
      || response.stopReason !== 'length'
    ) return replayState

    return {
      ...replayState,
      response: {
        ...response,
        stopReason: maskedKind === 'tool-calls' ? 'toolUse' : 'stop',
      },
    }
  }

  /**
   * Transparent Steer mode.
   *
   * The provider's max-tokens finish is consumed here as a private trigger and
   * is never yielded to AgentLoop. AgentLoop therefore never sets its sticky
   * turnEnds=max-tokens state. A complete tool-call block is exposed as the
   * ordinary tool-calls finish; otherwise the finish is exposed as stop and
   * this plugin queues one same-turn steer.
   */
  ctx.on('llm/stream', async function* (options, next) {
    const initialCfg = resolveConfig(config)
    if (
      !initialCfg.enabled
      || initialCfg.continuationMode !== MODE_STEER
      || !isAgentLoopRequest(options)
      || options.sessionId === undefined
    ) {
      yield* next()
      return
    }

    const agent = ctx.agents.get(options.sessionId)
    if (agent === undefined || agent.session?.id !== options.sessionId) {
      yield* next()
      return
    }
    const session = agent.session
    if (!initialCfg.includeSubagents && session.header?.origin === 'subagent') {
      yield* next()
      return
    }

    let hasCompleteToolCall = false
    for await (const chunk of next()) {
      if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
        hasCompleteToolCall = true
      }
      if (chunk.type !== 'finish' || chunk.reason?.kind !== 'max-tokens') {
        yield chunk
        continue
      }

      let cfg = resolveConfig(config)
      if (
        !cfg.enabled
        || cfg.continuationMode !== MODE_STEER
        || (!cfg.includeSubagents && session.header?.origin === 'subagent')
      ) {
        yield chunk
        continue
      }

      const state = stateFor(session, MODE_STEER)
      const maskedKind = hasCompleteToolCall ? 'tool-calls' : 'stop'
      debug(cfg,
        `STEER_MAX_TOKENS_INTERCEPTED ${sessionLabel(session)} provider=${options.provider} `
        + `model=${options.model} mask=${maskedKind} `
        + `nextTurn=${agent.inbox.nextTurn.length} nextStep=${agent.inbox.nextStep.length}`,
      )

      // A complete tool call already gives AgentLoop a native continuation path
      // through its tool result. Otherwise add one next-step steer unless other
      // queued work or the configured cap already owns the continuation.
      if (!hasCompleteToolCall) {
        cfg = await waitForInterval(session, state, 'checkpoint=llm-finish', options.signal, cfg)
        if (cfg !== undefined) {
          if (agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) {
            debug(cfg,
              `${sessionLabel(session)} mode=steer STEER_SEND_SKIPPED reason=pending-inbox`,
            )
          } else if (cfg.maxConsecutive > 0 && state.consecutive >= cfg.maxConsecutive) {
            logger.warn?.(`${LOG_PREFIX} session ${session.id} reached auto-continue cap (${cfg.maxConsecutive})`)
            debug(cfg,
              `${sessionLabel(session)} mode=steer STEER_SEND_SKIPPED reason=maxConsecutive`,
            )
          } else {
            try {
              const message = createUserMessage({
                content: [{ type: 'text', text: cfg.continueText }],
                source: { kind: SOURCE_PLUGIN },
              })
              agent.steer(message)
              state.consecutive += 1
              state.lastSentAt = Date.now()
              logger.info?.(
                `${LOG_PREFIX} session ${session.id} hit max-tokens; transparent steer auto-continue #${state.consecutive}`,
              )
              debug(cfg,
                `${sessionLabel(session)} mode=steer STEER_QUEUED messageId=${message.id} `
                + `nextTurnAfter=${agent.inbox.nextTurn.length} nextStepAfter=${agent.inbox.nextStep.length}`,
              )
            } catch (error) {
              logger.warn?.(
                `${LOG_PREFIX} failed transparent steer for session ${session.id}: `
                + `${error instanceof Error ? error.message : String(error)}`,
              )
              debug(cfg,
                `${sessionLabel(session)} mode=steer STEER_SEND_FAILED `
                + `error=${error instanceof Error ? error.stack ?? error.message : String(error)}`,
              )
            }
          }
        }
      } else {
        debug(cfg,
          `${sessionLabel(session)} mode=steer STEER_SEND_SKIPPED reason=native-tool-loop`,
        )
      }

      // The real provider max-tokens is intentionally not yielded. From this
      // point outward, AgentLoop and the durable Assistant stream see only an
      // ordinary stop/tool-calls finish.
      yield {
        ...chunk,
        reason: { kind: maskedKind },
        ...chunk.replayState === undefined
          ? {}
          : { replayState: sanitizeMaskedReplayState(chunk.replayState, maskedKind) },
      }
    }
  }, { global: true })

  const handleTurnStopping = async (agent, turn, signal) => {
    const session = agent.session
    let cfg = resolveConfig(config)
    if (!cfg.enabled || cfg.continuationMode !== MODE_FOLLOWUP) return
    if (!cfg.includeSubagents && session.header?.origin === 'subagent') return

    const finish = latestAssistantFinish(session, turn)
    if (finish?.kind !== 'max-tokens') return

    debug(cfg,
      `MAX_TOKENS_PRESTOP_CAPTURED ${sessionLabel(session)} mode=followup `
      + `turn=${turn} step=${finish.step ?? '-'} finishSeq=${finish.seq} status=${agent.status} `
      + `nextTurn=${agent.inbox.nextTurn.length} nextStep=${agent.inbox.nextStep.length}`,
    )
    await continueWithFollowup(agent, turn, signal, cfg, finish)
  }

  // 0.1.7 plugin manager: expose the volatile Config through this row, but let
  // this package render its own plugins.row.config page instead of auto schema UI.
  ctx.inject(['settings'], (sctx) => {
    sctx.effect(() => sctx.settings.configure({ auto: false }, ctx.fiber))
  })

  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }) => {
    await handleTurnStopping(agent, turn, signal)
  }, { global: true })

  // Durable observation only. Neither continuation implementation sends from
  // inside session/event, so Session.append re-entry is impossible here.
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
      `TURN_END_CAPTURED ${sessionLabel(session)} mode=${cfg.continuationMode} seq=${event.seq} `
      + `turn=${event.data.turn} reason=${event.data.reason.kind} ${snapshot.text}`,
    )

    if (event.data.reason.kind !== 'max-tokens') {
      reset(session, `turn-end:${event.data.reason.kind}`)
      return
    }

    const state = stateFor(session, cfg.continuationMode)
    debug(cfg,
      `MAX_TOKENS_CONFIRMED ${sessionLabel(session)} mode=${cfg.continuationMode} seq=${event.seq} `
      + `turn=${event.data.turn} lastHandledFinishSeq=${state.lastHandledFinishSeq}`,
    )
  }, { global: true })

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

export { Config, DEFAULTS, MODE_FOLLOWUP, MODE_STEER, apply, inject, name, resolveConfig }
