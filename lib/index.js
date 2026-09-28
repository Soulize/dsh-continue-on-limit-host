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
const TOOL_POLICY_DISCARD = 'discard'
const TOOL_POLICY_PASSTHROUGH = 'passthrough'

const DEFAULTS = Object.freeze({
  enabled: true,
  continuationMode: MODE_FOLLOWUP,
  steerToolCallPolicy: TOOL_POLICY_DISCARD,
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
  steerToolCallPolicy: z.string().default(DEFAULTS.steerToolCallPolicy).volatile(),
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

function normalizeToolPolicy(value) {
  return value === TOOL_POLICY_PASSTHROUGH ? TOOL_POLICY_PASSTHROUGH : TOOL_POLICY_DISCARD
}

function resolveConfig(config) {
  const continueText = String(unwrap(config?.continueText, DEFAULTS.continueText)).trim() || DEFAULTS.continueText
  const maxConsecutive = Math.max(0, Math.min(1000, Math.trunc(Number(unwrap(config?.maxConsecutive, DEFAULTS.maxConsecutive)) || 0)))
  const minIntervalMs = Math.max(0, Math.min(600000, Math.trunc(Number(unwrap(config?.minIntervalMs, DEFAULTS.minIntervalMs)) || 0)))
  return {
    enabled: unwrap(config?.enabled, DEFAULTS.enabled) !== false,
    continuationMode: normalizeMode(unwrap(config?.continuationMode, DEFAULTS.continuationMode)),
    steerToolCallPolicy: normalizeToolPolicy(unwrap(config?.steerToolCallPolicy, DEFAULTS.steerToolCallPolicy)),
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
    + `steerToolCallPolicy=${initialCfg.steerToolCallPolicy} `
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

  const blockIdentity = (chunk) => {
    switch (chunk.type) {
      case 'block-start': return { index: chunk.index, type: chunk.blockType }
      case 'text-delta': return { index: chunk.index, type: 'text' }
      case 'reasoning-delta': return { index: chunk.index, type: 'reasoning' }
      case 'tool-call-delta': return { index: chunk.index, type: 'tool-call' }
      case 'block-end': return { index: chunk.index, type: chunk.block.type }
      default: return undefined
    }
  }

  const isToolChunk = (chunk, toolIndexes) => {
    const identity = blockIdentity(chunk)
    return identity !== undefined && toolIndexes.has(identity.index)
  }

  /**
   * v0.4.0-compatible replay masking: keep the response structure intact and
   * only hide pi-ai's native length marker.
   */
  const sanitizePassthroughReplayState = (replayState, maskedKind) => {
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
   * v0.4.1-safe replay masking: mirror BlockAssembler's max-token pruning by
   * deleting tool-call replay entries together with the held tool chunks.
   */
  const sanitizeDiscardReplayState = (replayState, blockOrder, blockTypes) => {
    if (replayState === undefined || replayState === null || typeof replayState !== 'object') return replayState

    let next = replayState
    if (Array.isArray(replayState.blocks)) {
      if (replayState.blocks.length !== blockOrder.length) return undefined
      next = {
        ...next,
        blocks: replayState.blocks.filter((_, position) =>
          blockTypes.get(blockOrder[position]) !== 'tool-call'),
      }
    }

    const response = next.response
    if (
      response !== undefined
      && response !== null
      && typeof response === 'object'
      && response.kind === 'pi-ai'
      && response.stopReason === 'length'
    ) {
      next = {
        ...next,
        response: {
          ...response,
          stopReason: 'stop',
        },
      }
    }
    return next
  }

  const queueTransparentSteer = async (agent, session, state, options, initialCfg, policy) => {
    let cfg = await waitForInterval(session, state, 'checkpoint=llm-finish', options.signal, initialCfg)
    if (cfg === undefined) return false

    if (agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) {
      debug(cfg,
        `${sessionLabel(session)} mode=steer policy=${policy} STEER_SEND_SKIPPED reason=pending-inbox`,
      )
      return false
    }
    if (cfg.maxConsecutive > 0 && state.consecutive >= cfg.maxConsecutive) {
      logger.warn?.(`${LOG_PREFIX} session ${session.id} reached auto-continue cap (${cfg.maxConsecutive})`)
      debug(cfg,
        `${sessionLabel(session)} mode=steer policy=${policy} STEER_SEND_SKIPPED reason=maxConsecutive`,
      )
      return false
    }

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
        `${sessionLabel(session)} mode=steer policy=${policy} STEER_QUEUED messageId=${message.id} `
        + `nextTurnAfter=${agent.inbox.nextTurn.length} nextStepAfter=${agent.inbox.nextStep.length}`,
      )
      return true
    } catch (error) {
      logger.warn?.(
        `${LOG_PREFIX} failed transparent steer for session ${session.id}: `
        + `${error instanceof Error ? error.message : String(error)}`,
      )
      debug(cfg,
        `${sessionLabel(session)} mode=steer policy=${policy} STEER_SEND_FAILED `
        + `error=${error instanceof Error ? error.stack ?? error.message : String(error)}`,
      )
      return false
    }
  }

  /**
   * Transparent Steer mode has two selectable capped-tool policies:
   *
   * - discard (v0.4.1, default): buffer from the first tool chunk; if the
   *   response ends max-tokens, discard every tool-call, steer, and expose stop.
   * - passthrough (v0.4.0 compatibility): stream tool chunks immediately; if
   *   any tool-call reached block-end before max-tokens, expose tool-calls and
   *   do not add a steer. Otherwise expose stop and steer.
   *
   * The policy is snapshotted at request start so a live config change cannot
   * retroactively change handling after chunks have already been yielded.
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

    const policy = initialCfg.steerToolCallPolicy
    const state = stateFor(session, MODE_STEER)

    if (policy === TOOL_POLICY_PASSTHROUGH) {
      let hasClosedToolCall = false
      for await (const chunk of next()) {
        if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') {
          hasClosedToolCall = true
        }

        if (chunk.type !== 'finish' || chunk.reason?.kind !== 'max-tokens') {
          yield chunk
          continue
        }

        const liveCfg = resolveConfig(config)
        if (
          !liveCfg.enabled
          || liveCfg.continuationMode !== MODE_STEER
          || (!liveCfg.includeSubagents && session.header?.origin === 'subagent')
        ) {
          yield chunk
          return
        }

        const maskedKind = hasClosedToolCall ? 'tool-calls' : 'stop'
        debug(liveCfg,
          `STEER_MAX_TOKENS_INTERCEPTED ${sessionLabel(session)} provider=${options.provider} `
          + `model=${options.model} policy=passthrough closedToolCall=${hasClosedToolCall} mask=${maskedKind} `
          + `nextTurn=${agent.inbox.nextTurn.length} nextStep=${agent.inbox.nextStep.length}`,
        )

        if (!hasClosedToolCall) {
          await queueTransparentSteer(agent, session, state, options, liveCfg, policy)
        } else {
          debug(liveCfg,
            `${sessionLabel(session)} mode=steer policy=passthrough STEER_SEND_SKIPPED reason=closed-tool-call`,
          )
        }

        yield {
          ...chunk,
          reason: { kind: maskedKind },
          ...(chunk.replayState === undefined
            ? {}
            : { replayState: sanitizePassthroughReplayState(chunk.replayState, maskedKind) }),
        }
        return
      }
      return
    }

    // Safe v0.4.1 behavior: do not yield any tool-call until the terminal
    // reason is known, so a capped response can still have all tools removed.
    const blockOrder = []
    const blockTypes = new Map()
    const toolIndexes = new Set()
    let held = undefined

    const observeBlock = (chunk) => {
      const identity = blockIdentity(chunk)
      if (identity === undefined) return false
      if (!blockTypes.has(identity.index)) blockOrder.push(identity.index)
      blockTypes.set(identity.index, identity.type)
      if (identity.type === 'tool-call') toolIndexes.add(identity.index)
      return identity.type === 'tool-call'
    }

    try {
      for await (const chunk of next()) {
        const toolChunk = observeBlock(chunk)
        if (held === undefined && toolChunk) held = []

        if (chunk.type !== 'finish') {
          if (held === undefined) yield chunk
          else held.push(chunk)
          continue
        }

        if (chunk.reason?.kind !== 'max-tokens') {
          if (held !== undefined) {
            for (const buffered of held) yield buffered
          }
          yield chunk
          return
        }

        const liveCfg = resolveConfig(config)
        if (
          !liveCfg.enabled
          || liveCfg.continuationMode !== MODE_STEER
          || (!liveCfg.includeSubagents && session.header?.origin === 'subagent')
        ) {
          if (held !== undefined) {
            for (const buffered of held) yield buffered
          }
          yield chunk
          return
        }

        debug(liveCfg,
          `STEER_MAX_TOKENS_INTERCEPTED ${sessionLabel(session)} provider=${options.provider} `
          + `model=${options.model} policy=discard droppedToolCalls=${toolIndexes.size} `
          + `nextTurn=${agent.inbox.nextTurn.length} nextStep=${agent.inbox.nextStep.length}`,
        )

        if (held !== undefined) {
          for (const buffered of held) {
            if (!isToolChunk(buffered, toolIndexes)) yield buffered
          }
        }

        await queueTransparentSteer(agent, session, state, options, liveCfg, policy)

        const replayState = sanitizeDiscardReplayState(chunk.replayState, blockOrder, blockTypes)
        yield {
          ...chunk,
          reason: { kind: 'stop' },
          ...(replayState === undefined ? { replayState: undefined } : { replayState }),
        }
        return
      }
    } catch (error) {
      if (held !== undefined) {
        for (const buffered of held) yield buffered
      }
      throw error
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

export {
  Config,
  DEFAULTS,
  MODE_FOLLOWUP,
  MODE_STEER,
  TOOL_POLICY_DISCARD,
  TOOL_POLICY_PASSTHROUGH,
  apply,
  inject,
  name,
  resolveConfig,
}
