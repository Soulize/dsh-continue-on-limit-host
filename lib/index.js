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

  const restoreSteerPatch = (state) => {
    if (typeof state.restoreSteerPatch === 'function') {
      const restore = state.restoreSteerPatch
      state.restoreSteerPatch = undefined
      restore()
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
        steerRecoveryTurn: undefined,
        lastConcludingToolFinishSeq: -1,
        restoreSteerPatch: undefined,
      }
      states.set(session, state)
      return state
    }

    // Hot switching modes is a hard boundary: never let state from one
    // implementation cause the other implementation to send or rewrite.
    if (state.mode !== mode) {
      restoreSteerPatch(state)
      state.mode = mode
      state.consecutive = 0
      state.lastSentAt = 0
      state.lastHandledFinishSeq = -1
      state.steerRecoveryTurn = undefined
      state.lastConcludingToolFinishSeq = -1
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
    restoreSteerPatch(state)
    state.consecutive = 0
    state.lastSentAt = 0
    state.lastHandledFinishSeq = -1
    state.steerRecoveryTurn = undefined
    state.lastConcludingToolFinishSeq = -1
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
   * This deliberately reads the latest step only. An older max-tokens finish
   * must not make us send again after a later clean recovery step.
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

  const waitForInterval = async (session, state, turn, signal, cfg) => {
    const delay = Math.max(0, state.lastSentAt + cfg.minIntervalMs - Date.now())
    if (delay === 0) return cfg

    debug(cfg,
      `${sessionLabel(session)} mode=${cfg.continuationMode} turn=${turn} `
      + `waiting ${delay}ms inside turn-stopping checkpoint`,
    )
    await new Promise((resolve) => setTimeout(resolve, delay))
    if (signal.aborted) {
      debug(cfg,
        `${sessionLabel(session)} mode=${cfg.continuationMode} turn=${turn} `
        + 'AUTO_CONTINUE_SKIPPED reason=turn-aborted-during-delay',
      )
      return undefined
    }

    const liveCfg = resolveConfig(config)
    if (!liveCfg.enabled || liveCfg.continuationMode !== cfg.continuationMode) {
      debug(liveCfg,
        `${sessionLabel(session)} turn=${turn} AUTO_CONTINUE_SKIPPED `
        + 'reason=disabled-or-mode-changed-during-delay',
      )
      return undefined
    }
    return liveCfg
  }

  const canSend = (agent, session, state, finish, turn, cfg) => {
    if (state.lastHandledFinishSeq === finish.seq) {
      debug(cfg,
        `${sessionLabel(session)} mode=${cfg.continuationMode} turn=${turn} `
        + `finishSeq=${finish.seq} skip: already handled`,
      )
      return false
    }

    if (agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) {
      state.lastHandledFinishSeq = finish.seq
      debug(cfg,
        `${sessionLabel(session)} mode=${cfg.continuationMode} turn=${turn} `
        + 'AUTO_CONTINUE_SKIPPED reason=pending-inbox',
      )
      return false
    }

    if (cfg.maxConsecutive > 0 && state.consecutive >= cfg.maxConsecutive) {
      state.lastHandledFinishSeq = finish.seq
      logger.warn?.(`${LOG_PREFIX} session ${session.id} reached auto-continue cap (${cfg.maxConsecutive})`)
      debug(cfg,
        `${sessionLabel(session)} mode=${cfg.continuationMode} turn=${turn} `
        + 'AUTO_CONTINUE_SKIPPED reason=maxConsecutive',
      )
      return false
    }
    return true
  }

  /**
   * Follow-up implementation: enqueue a distinct next turn before this turn
   * closes. This is the conservative/default path and never rewrites Session
   * events.
   */
  const continueWithFollowup = async (agent, turn, signal, initialCfg, finish) => {
    const session = agent.session
    const state = stateFor(session, MODE_FOLLOWUP)
    let cfg = await waitForInterval(session, state, turn, signal, initialCfg)
    if (cfg === undefined) return

    if (!canSend(agent, session, state, finish, turn, cfg)) return

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
   * Plugin-only steer implementation.
   *
   * DSH intentionally makes max-tokens sticky for an entire turn. We preserve
   * every provider-level max-tokens finish in assistant streams, but when a
   * steer recovery later reaches a clean provider stop, a one-shot per-Session
   * append wrapper normalizes ONLY that turn/end from max-tokens to completed.
   *
   * No core package is patched and no global prototype is changed.
   */
  const armSteerTurnEndRewrite = (session, state, turn, cfg) => {
    if (state.steerRecoveryTurn === turn && typeof state.restoreSteerPatch === 'function') return

    restoreSteerPatch(state)
    state.steerRecoveryTurn = turn

    const hadOwnAppend = Object.prototype.hasOwnProperty.call(session, 'append')
    const previousOwnAppend = hadOwnAppend ? session.append : undefined
    const originalAppend = session.append
    let wrappedAppend

    const restore = () => {
      if (session.append !== wrappedAppend) return
      if (hadOwnAppend) session.append = previousOwnAppend
      else delete session.append
    }

    wrappedAppend = function (type, data, ...opts) {
      if (type !== 'turn/end' || data?.turn !== turn) {
        return originalAppend.call(this, type, data, ...opts)
      }

      const liveCfg = resolveConfig(config)
      let nextData = data
      try {
        if (
          liveCfg.enabled
          && liveCfg.continuationMode === MODE_STEER
          && state.steerRecoveryTurn === turn
          && data?.reason?.kind === 'max-tokens'
        ) {
          const latest = latestAssistantFinish(session, turn)
          const cleanToolConclusion = latest?.kind === 'tool-calls'
            && state.lastConcludingToolFinishSeq === latest.seq
          if (latest?.kind === 'stop' || cleanToolConclusion) {
            nextData = { ...data, reason: { kind: 'completed' } }
            debug(liveCfg,
              `${sessionLabel(session)} mode=steer turn=${turn} STEER_TURN_END_REWRITTEN `
              + `max-tokens->completed finalStep=${latest.step ?? '-'} finalFinish=${latest.kind} `
              + `finalFinishSeq=${latest.seq}`,
            )
          } else {
            debug(liveCfg,
              `${sessionLabel(session)} mode=steer turn=${turn} STEER_TURN_END_PRESERVED `
              + `reason=max-tokens latestFinish=${latest?.kind ?? 'none'}`,
            )
          }
        }
        return originalAppend.call(this, type, nextData, ...opts)
      } finally {
        state.steerRecoveryTurn = undefined
        if (state.restoreSteerPatch === restore) state.restoreSteerPatch = undefined
        restore()
      }
    }

    state.restoreSteerPatch = restore
    session.append = wrappedAppend
    debug(cfg,
      `${sessionLabel(session)} mode=steer turn=${turn} STEER_TURN_END_REWRITE_ARMED`,
    )
  }

  const continueWithSteer = async (agent, turn, signal, initialCfg, finish) => {
    const session = agent.session
    const state = stateFor(session, MODE_STEER)
    let cfg = await waitForInterval(session, state, turn, signal, initialCfg)
    if (cfg === undefined) return

    if (!canSend(agent, session, state, finish, turn, cfg)) return

    try {
      const message = createUserMessage({
        content: [{ type: 'text', text: cfg.continueText }],
        source: { kind: SOURCE_PLUGIN },
      })

      // Arm before steer so even an unusual synchronous turn close cannot escape
      // the recovery accounting. The wrapper is per Session and one turn only.
      armSteerTurnEndRewrite(session, state, turn, cfg)

      debug(cfg,
        `STEER_MAX_TOKENS_CAPTURED ${sessionLabel(session)} turn=${turn} `
        + `step=${finish.step ?? '-'} finishSeq=${finish.seq}`,
      )
      agent.steer(message)
      state.lastHandledFinishSeq = finish.seq
      state.consecutive += 1
      state.lastSentAt = Date.now()
      logger.info?.(
        `${LOG_PREFIX} session ${session.id} hit max-tokens; steer auto-continue #${state.consecutive}`,
      )
      debug(cfg,
        `${sessionLabel(session)} mode=steer turn=${turn} STEER_QUEUED messageId=${message.id} `
        + `nextTurnAfter=${agent.inbox.nextTurn.length} nextStepAfter=${agent.inbox.nextStep.length}`,
      )
    } catch (error) {
      restoreSteerPatch(state)
      state.steerRecoveryTurn = undefined
      logger.warn?.(
        `${LOG_PREFIX} failed steer continuation for session ${session.id}: `
        + `${error instanceof Error ? error.message : String(error)}`,
      )
      debug(cfg,
        `${sessionLabel(session)} mode=steer turn=${turn} AUTO_CONTINUE_FAILED `
        + `error=${error instanceof Error ? error.stack ?? error.message : String(error)}`,
      )
    }
  }

  /**
   * A max-tokens finish is sticky at the turn level in DSH. If a steered
   * recovery step ends with ordinary tool-calls, step() returns null, but the
   * earlier sticky max-tokens value prevents AgentLoop from observing that null
   * and it reaches turn-stopping instead of the native next tool step.
   *
   * Queue one same-turn steer to restore the tool loop. This does NOT count
   * toward maxConsecutive: it is continuation of the already-admitted recovery,
   * not another max-tokens event.
   */
  const bridgeStickySteerToolLoop = (agent, turn, cfg, finish) => {
    const session = agent.session
    const state = stateFor(session, MODE_STEER)

    if (state.lastHandledFinishSeq === finish.seq) {
      debug(cfg,
        `${sessionLabel(session)} mode=steer turn=${turn} finishSeq=${finish.seq} `
        + 'STEER_TOOL_LOOP_BRIDGE_SKIPPED reason=already-handled',
      )
      return
    }

    if (agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) {
      state.lastHandledFinishSeq = finish.seq
      debug(cfg,
        `${sessionLabel(session)} mode=steer turn=${turn} finishSeq=${finish.seq} `
        + 'STEER_TOOL_LOOP_BRIDGE_SKIPPED reason=pending-inbox',
      )
      return
    }

    try {
      const message = createUserMessage({
        content: [{ type: 'text', text: cfg.continueText }],
        source: { kind: SOURCE_PLUGIN },
      })
      agent.steer(message)
      state.lastHandledFinishSeq = finish.seq
      debug(cfg,
        `${sessionLabel(session)} mode=steer turn=${turn} STEER_TOOL_LOOP_BRIDGE_QUEUED `
        + `step=${finish.step ?? '-'} finishSeq=${finish.seq} messageId=${message.id} `
        + `nextStepAfter=${agent.inbox.nextStep.length}`,
      )
    } catch (error) {
      logger.warn?.(
        `${LOG_PREFIX} failed steer tool-loop bridge for session ${session.id}: `
        + `${error instanceof Error ? error.message : String(error)}`,
      )
      debug(cfg,
        `${sessionLabel(session)} mode=steer turn=${turn} STEER_TOOL_LOOP_BRIDGE_FAILED `
        + `error=${error instanceof Error ? error.stack ?? error.message : String(error)}`,
      )
    }
  }

  const handleTurnStopping = async (agent, turn, signal) => {
    const session = agent.session
    let cfg = resolveConfig(config)
    if (!cfg.enabled) return
    if (!cfg.includeSubagents && session.header?.origin === 'subagent') return

    const state = stateFor(session, cfg.continuationMode)
    const finish = latestAssistantFinish(session, turn)

    // In steer mode a previous max-tokens step may have recovered cleanly in a
    // later step. Do not steer again; leave the armed one-shot append wrapper
    // to normalize the sticky turn/end to completed.
    if (cfg.continuationMode === MODE_STEER && state.steerRecoveryTurn === turn) {
      if (finish?.kind === 'stop') {
        debug(cfg,
          `${sessionLabel(session)} mode=steer turn=${turn} STEER_RECOVERY_REACHED_CLEAN_STOP `
          + `step=${finish.step ?? '-'} finishSeq=${finish.seq}; allowing turn to close`,
        )
        return
      }

      if (finish?.kind === 'tool-calls') {
        if (state.lastConcludingToolFinishSeq === finish.seq) {
          debug(cfg,
            `${sessionLabel(session)} mode=steer turn=${turn} STEER_RECOVERY_REACHED_CONCLUDING_TOOL `
            + `step=${finish.step ?? '-'} finishSeq=${finish.seq}; allowing turn to close`,
          )
          return
        }

        bridgeStickySteerToolLoop(agent, turn, cfg, finish)
        return
      }

      if (finish?.kind !== 'max-tokens') {
        debug(cfg,
          `${sessionLabel(session)} mode=steer turn=${turn} STEER_RECOVERY_NOT_CLEAN `
          + `latestFinish=${finish?.kind ?? 'none'}; allowing native outcome`,
        )
        return
      }
    }

    if (finish?.kind !== 'max-tokens') return

    debug(cfg,
      `MAX_TOKENS_PRESTOP_CAPTURED ${sessionLabel(session)} mode=${cfg.continuationMode} `
      + `turn=${turn} step=${finish.step ?? '-'} finishSeq=${finish.seq} status=${agent.status} `
      + `nextTurn=${agent.inbox.nextTurn.length} nextStep=${agent.inbox.nextStep.length}`,
    )

    // Exactly one implementation is selected. No fall-through is allowed.
    if (cfg.continuationMode === MODE_STEER) {
      await continueWithSteer(agent, turn, signal, cfg, finish)
      return
    }
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

  // Observe only model-direct final tool outcomes. During a same-turn Steer
  // recovery, a successful root tool may explicitly conclude the turn. That
  // must remain terminal; ordinary tool calls instead need the sticky-loop
  // bridge above.
  ctx.on('tools/result', (exec, result) => {
    if (result?.concludesTurn !== true || exec?.parent !== undefined) return
    const agent = exec?.agent
    const session = agent?.session
    if (session === undefined) return

    const cfg = resolveConfig(config)
    if (!cfg.enabled || cfg.continuationMode !== MODE_STEER) return

    const state = states.get(session)
    const turn = state?.steerRecoveryTurn
    if (state === undefined || turn === undefined) return

    const finish = latestAssistantFinish(session, turn)
    if (finish?.kind !== 'tool-calls') return
    state.lastConcludingToolFinishSeq = finish.seq
    debug(cfg,
      `${sessionLabel(session)} mode=steer turn=${turn} STEER_CONCLUDING_TOOL_CAPTURED `
      + `tool=${exec.name ?? '-'} step=${finish.step ?? '-'} finishSeq=${finish.seq}`,
    )
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
    const state = states.get(session)
    if (state !== undefined) restoreSteerPatch(state)
    states.delete(session)
  }, { global: true })

  ctx.effect(() => () => {
    for (const state of states.values()) restoreSteerPatch(state)
    states.clear()
  }, 'dsh-continue-on-limit-host: state')
}

export { Config, DEFAULTS, MODE_FOLLOWUP, MODE_STEER, apply, inject, name, resolveConfig }
