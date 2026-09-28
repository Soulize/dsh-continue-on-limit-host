const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const hostFile = path.join(root, 'lib/index.js')
const clientFile = path.join(root, 'lib/client.js')

execFileSync(process.execPath, ['--check', hostFile], { stdio: 'inherit' })
execFileSync(process.execPath, ['--check', clientFile], { stdio: 'inherit' })
console.log('OK: syntax check passed')

const candidates = [
  process.env.DSH_HARNESS_NODE_MODULES,
  'C:/Users/cbn/.dsh/profiles/node_modules',
  'C:/Users/11011/.dsh/profiles/node_modules',
].filter(Boolean)
const harnessModules = candidates.find((p) => fs.existsSync(p))
const localNodeModules = path.join(root, 'node_modules')
if (!fs.existsSync(localNodeModules) && harnessModules) {
  fs.symlinkSync(harnessModules, localNodeModules, 'junction')
}

if (!fs.existsSync(path.join(localNodeModules, '@deepseek-ai', 'dsh-llm'))) {
  console.log('SKIP: DSH runtime modules not found; set DSH_HARNESS_NODE_MODULES for host/client smoke tests')
  process.exit(0)
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function hostTests() {
  const host = await import('file:///' + hostFile.replace(/\\/g, '/'))
  const { markAgentLoopRequest } = await import('@deepseek-ai/dsh-llm')
  if (host.name !== 'dsh-continue-on-limit-host') throw new Error('unexpected host name: ' + host.name)
  if (!host.inject.includes('agents') || !host.inject.includes('profileContext')) throw new Error('host injects are incomplete')
  if (host.DEFAULTS.continuationMode !== 'followup') throw new Error('followup must remain the default mode')

  const listeners = new Map()
  const settingsCalls = []
  const followups = []
  const steers = []
  const logs = []
  const events = []
  const inbox = { nextTurn: [], nextStep: [] }
  let seq = 1

  const session = {
    id: 'root-1',
    header: {},
    snapshotEvents() { return [...events] },
    append(type, data, opts) {
      const event = { type, seq: seq++, data, ...(opts ?? {}) }
      events.push(event)
      for (const cb of listeners.get('session/event') ?? []) cb(session, event)
      return event
    },
  }

  const agent = {
    session,
    status: 'running',
    inbox,
    followup(message) {
      followups.push(message)
      inbox.nextTurn.push(message)
    },
    steer(message) {
      steers.push(message)
      inbox.nextStep.push(message)
    },
  }

  const config = {
    enabled: true,
    continuationMode: 'followup',
    continueText: '继续',
    maxConsecutive: 3,
    minIntervalMs: 0,
    includeSubagents: true,
    debugLogging: true,
  }

  const cleanup = []
  const ctx = {
    fiber: {},
    profileContext: { name: 'web', home: path.join(root, '.test-dsh-home') },
    agents: { get: (id) => id === session.id ? agent : undefined },
    logger: { info(message) { logs.push(String(message)) }, warn(message) { logs.push(String(message)) } },
    on(name, cb) {
      const list = listeners.get(name) ?? []
      list.push(cb)
      listeners.set(name, list)
      return () => {}
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') cleanup.push(dispose)
      return dispose
    },
    inject(services, cb) {
      if (services.includes('settings')) {
        cb({
          settings: { configure(value) { settingsCalls.push(value); return () => {} } },
          effect(fn) { const dispose = fn(); if (typeof dispose === 'function') cleanup.push(dispose); return dispose },
        })
      }
    },
  }

  host.apply(ctx, config)
  if (settingsCalls.length !== 1 || settingsCalls[0].auto !== false) throw new Error('settings custom-page registration missing')

  const emitStopping = async (turn) => {
    const payload = { agent, turn, signal: new AbortController().signal }
    for (const cb of listeners.get('agent/turn-stopping') ?? []) await cb(payload)
  }
  const runLlmStream = async (chunks) => {
    const options = markAgentLoopRequest({
      provider: 'mock',
      model: 'mock',
      messages: [],
      sessionId: session.id,
      signal: new AbortController().signal,
    })
    let stream = (async function* () { yield* chunks })()
    const callbacks = [...(listeners.get('llm/stream') ?? [])]
    for (let index = callbacks.length - 1; index >= 0; index -= 1) {
      const cb = callbacks[index]
      const downstream = stream
      stream = cb(options, () => downstream)
    }
    const out = []
    for await (const chunk of stream) out.push(chunk)
    return out
  }
  const finishStream = (kind) => [{ type: 'chunk', time: Date.now(), chunk: { type: 'finish', reason: { kind } } }]
  const assistant = (turn, step, kind) => session.append('assistant/message', {
    turn,
    step,
    message: {
      id: 'assistant-' + turn + '-' + step,
      role: 'assistant',
      content: [{ type: 'text', text: kind }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    },
    stream: finishStream(kind),
  }, { surfaceOp: 'append' })

  // FOLLOW-UP MODE: exactly one next-turn send; no steer.
  let turn = 1
  session.append('turn/start', { turn })
  assistant(turn, 1, 'max-tokens')
  await emitStopping(turn)
  if (followups.length !== 1) throw new Error('followup mode did not queue exactly one followup')
  if (steers.length !== 0) throw new Error('followup mode must never steer')
  if (inbox.nextTurn.length !== 1 || inbox.nextStep.length !== 0) throw new Error('followup mode queued the wrong inbox target')
  const followupEnd = session.append('turn/end', { turn, reason: { kind: 'max-tokens' } })
  if (followupEnd.data.reason.kind !== 'max-tokens') throw new Error('followup mode must preserve native max-tokens turn/end')
  if (!logs.some(line => line.includes('FOLLOWUP_QUEUED'))) throw new Error('followup diagnostic marker missing')
  inbox.nextTurn.length = 0

  // Normal completion resets the followup chain.
  turn += 1
  session.append('turn/start', { turn })
  assistant(turn, 1, 'stop')
  await emitStopping(turn)
  session.append('turn/end', { turn, reason: { kind: 'completed' } })

  // STEER MODE: max-tokens is a private plugin trigger. AgentLoop sees
  // only the masked terminal reason and the queued next-step steer.
  config.continuationMode = 'steer'
  turn += 1
  session.append('turn/start', { turn })
  const masked = await runLlmStream([{
    type: 'finish',
    reason: { kind: 'max-tokens' },
    replayState: {
      response: { kind: 'pi-ai', version: 2, provider: 'mock', model: 'mock', api: 'openai-completions', stopReason: 'length' },
      blocks: [],
    },
  }])
  if (masked.length !== 1 || masked[0].reason.kind !== 'stop') throw new Error('steer mode did not hide max-tokens as stop')
  if (masked[0].replayState?.response?.stopReason !== 'stop') throw new Error('steer mode did not sanitize pi-ai replay stopReason')
  if (steers.length !== 1) throw new Error('steer mode did not queue exactly one next-step steer')
  if (followups.length !== 1) throw new Error('steer mode leaked into followup path')
  if (inbox.nextStep.length !== 1 || inbox.nextTurn.length !== 0) throw new Error('steer mode queued the wrong inbox target')
  if (!logs.some(line => line.includes('STEER_MAX_TOKENS_INTERCEPTED'))) throw new Error('transparent steer interception marker missing')

  // Simulate AgentLoop claiming the steer. The durable Assistant settlement
  // contains only the masked finish; turn/end is therefore natively completed.
  inbox.nextStep.length = 0
  assistant(turn, 1, 'stop')
  await emitStopping(turn)
  const transparentEnd = session.append('turn/end', { turn, reason: { kind: 'completed' } })
  if (transparentEnd.data.reason.kind !== 'completed') throw new Error('transparent steer turn did not remain completed')

  // Any tool call in a capped response is discarded, even if the adapter
  // emitted block-end. DSH's native BlockAssembler makes the same safety
  // choice for max-tokens responses.
  turn += 1
  session.append('turn/start', { turn })
  const toolMasked = await runLlmStream([
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'write', argumentsDelta: '{"file_path":"x"' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1', name: 'write', arguments: '{"file_path":"x"' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'after tool' },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'after tool' } },
    {
      type: 'finish',
      reason: { kind: 'max-tokens' },
      replayState: {
        response: { kind: 'pi-ai', version: 2, provider: 'mock', model: 'mock', api: 'openai-completions', stopReason: 'length' },
        blocks: [{ type: 'tool-call' }, { type: 'text' }],
      },
    },
  ])
  if (toolMasked.some((chunk) =>
    chunk.type === 'tool-call-delta'
    || (chunk.type === 'block-start' && chunk.blockType === 'tool-call')
    || (chunk.type === 'block-end' && chunk.block?.type === 'tool-call')
  )) throw new Error('capped tool call leaked through transparent steer')
  if (!toolMasked.some((chunk) => chunk.type === 'text-delta' && chunk.text === 'after tool')) throw new Error('non-tool suffix was lost while dropping capped tool calls')
  if (toolMasked.at(-1)?.reason?.kind !== 'stop') throw new Error('capped tool response did not mask max-tokens as stop')
  if (toolMasked.at(-1)?.replayState?.response?.stopReason !== 'stop') throw new Error('capped tool replay stopReason was not sanitized')
  if (toolMasked.at(-1)?.replayState?.blocks?.length !== 1 || toolMasked.at(-1)?.replayState?.blocks?.[0]?.type !== 'text') {
    throw new Error('capped tool replay metadata was not pruned with the dropped tool call')
  }
  if (steers.length !== 2) throw new Error('capped tool response did not queue a steer')
  inbox.nextStep.length = 0
  session.append('turn/end', { turn, reason: { kind: 'completed' } })

  // A normal tool-calls response is not altered: held tool chunks flush in
  // original order and no continuation is injected.
  turn += 1
  session.append('turn/start', { turn })
  const normalTool = await runLlmStream([
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: 'call-2', name: 'write', argumentsDelta: '{}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-2', name: 'write', arguments: '{}' } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ])
  if (normalTool.at(-1)?.reason?.kind !== 'tool-calls') throw new Error('normal tool-calls finish was modified')
  if (!normalTool.some((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')) {
    throw new Error('normal tool call was not flushed')
  }
  if (steers.length !== 2) throw new Error('normal tool-calls response must not steer')
  session.append('turn/end', { turn, reason: { kind: 'completed' } })

  // The cap limits injected steer messages, but max-tokens remains hidden even
  // when the cap prevents another injection.
  config.maxConsecutive = 1
  turn += 1
  session.append('turn/start', { turn })
  const firstCapped = await runLlmStream([{ type: 'finish', reason: { kind: 'max-tokens' } }])
  if (firstCapped[0]?.reason?.kind !== 'stop') throw new Error('first capped finish leaked max-tokens')
  if (steers.length !== 3) throw new Error('first capped finish did not steer')
  inbox.nextStep.length = 0
  const secondCapped = await runLlmStream([{ type: 'finish', reason: { kind: 'max-tokens' } }])
  if (secondCapped[0]?.reason?.kind !== 'stop') throw new Error('maxConsecutive path leaked max-tokens')
  if (steers.length !== 3) throw new Error('maxConsecutive should suppress the second steer')
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  config.maxConsecutive = 3

  // Hot mode switch is a hard boundary. Follow-up mode must leave the
  // provider max-tokens finish untouched and handle it at turn-stopping.
  config.continuationMode = 'followup'
  turn += 1
  session.append('turn/start', { turn })
  const raw = await runLlmStream([{ type: 'finish', reason: { kind: 'max-tokens' } }])
  if (raw[0]?.reason?.kind !== 'max-tokens') throw new Error('followup mode must not mask max-tokens')
  assistant(turn, 1, 'max-tokens')
  await emitStopping(turn)
  if (followups.length !== 2) throw new Error('mode switch back to followup did not select followup path')
  if (steers.length !== 3) throw new Error('mode switch back to followup leaked a steer')
  session.append('turn/end', { turn, reason: { kind: 'max-tokens' } })
  inbox.nextTurn.length = 0

  for (const dispose of cleanup.reverse()) await dispose()
  fs.rmSync(path.join(root, '.test-dsh-home'), { recursive: true, force: true })
  console.log('OK: followup preserves max-tokens; steer masks it before AgentLoop')
}

async function clientTests() {
  const React = require(path.join(localNodeModules, 'react'))
  const loaded = {}
  global.window = {
    __ModuleLoader__: {
      load(entry) {
        loaded.id = entry.id
        loaded.exports = entry.factory((name) => {
          if (name === 'react') return React
          throw new Error('unexpected client require: ' + name)
        })
      },
    },
  }
  try {
    ;(0, eval)(fs.readFileSync(clientFile, 'utf8'))
  } finally {
    delete global.window
  }
  if (loaded.id !== 'dsh-continue-on-limit-host') throw new Error('wrong client module id: ' + loaded.id)
  const entries = []
  const ctx = {
    slots: {
      inject(name, factory) {
        if (name !== 'plugins.row.config') throw new Error('unexpected slot: ' + name)
        factory()()
      },
      register(options, component) {
        entries.push({ options, component })
        return () => {}
      },
    },
  }
  loaded.exports.apply(ctx)
  const row = entries[0]
  if (row?.options?.key !== 'dsh-continue-on-limit-host#continue-on-limit-host') throw new Error('wrong Plugins row config key')
  const summary = row.component({ view: 'summary' })
  if (typeof summary !== 'string' || summary.length === 0) throw new Error('row summary missing')
  console.log('OK: DSH 0.1.7 plugins.row.config registration')
}

async function main() {
  await hostTests()
  await clientTests()
  console.log('all smoke tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
