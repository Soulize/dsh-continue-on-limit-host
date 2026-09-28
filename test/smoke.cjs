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

  // STEER MODE: same-turn next-step recovery and plugin-only sticky outcome normalization.
  config.continuationMode = 'steer'
  turn += 1
  session.append('turn/start', { turn })
  assistant(turn, 1, 'max-tokens')
  await emitStopping(turn)
  if (followups.length !== 1) throw new Error('steer mode must not call followup')
  if (steers.length !== 1) throw new Error('steer mode did not queue exactly one steer')
  if (inbox.nextStep.length !== 1 || inbox.nextTurn.length !== 0) throw new Error('steer mode queued the wrong inbox target')
  if (!logs.some(line => line.includes('STEER_TURN_END_REWRITE_ARMED'))) throw new Error('steer rewrite was not armed')

  // AgentLoop claims the steering and runs the next step in the SAME turn.
  inbox.nextStep.length = 0
  assistant(turn, 2, 'stop')
  await emitStopping(turn)
  if (steers.length !== 1) throw new Error('clean recovery stop must not steer again')

  // Native AgentLoop would still write max-tokens because it is sticky. The
  // plugin's one-shot Session.append wrapper must normalize only this turn-end.
  const steerEnd = session.append('turn/end', { turn, reason: { kind: 'max-tokens' } })
  if (steerEnd.data.reason.kind !== 'completed') throw new Error('steer recovery did not normalize sticky max-tokens to completed')
  if (!logs.some(line => line.includes('STEER_TURN_END_REWRITTEN'))) throw new Error('steer rewrite diagnostic marker missing')

  // Provider-level truth remains durable: the first step is still max-tokens.
  const firstSteerAssistant = events.find(event => event.type === 'assistant/message' && event.data.turn === turn && event.data.step === 1)
  const firstFinish = firstSteerAssistant?.data.stream?.find(record => record.type === 'chunk' && record.chunk?.type === 'finish')
  if (firstFinish?.chunk?.reason?.kind !== 'max-tokens') throw new Error('steer mode must preserve provider-level max-tokens history')

  // Repeated max-tokens in steer mode adds one steer per capped step, still no followup.
  turn += 1
  session.append('turn/start', { turn })
  assistant(turn, 1, 'max-tokens')
  await emitStopping(turn)
  inbox.nextStep.length = 0
  assistant(turn, 2, 'max-tokens')
  await emitStopping(turn)
  if (steers.length !== 3) throw new Error('steer mode must continue once per max-tokens step')
  if (followups.length !== 1) throw new Error('steer mode leaked into followup path')
  inbox.nextStep.length = 0
  assistant(turn, 3, 'stop')
  await emitStopping(turn)
  const repeatedSteerEnd = session.append('turn/end', { turn, reason: { kind: 'max-tokens' } })
  if (repeatedSteerEnd.data.reason.kind !== 'completed') throw new Error('multi-step steer recovery did not complete cleanly')

  // Hot mode switch is a hard boundary; next max-tokens uses followup only.
  config.continuationMode = 'followup'
  turn += 1
  session.append('turn/start', { turn })
  assistant(turn, 1, 'max-tokens')
  await emitStopping(turn)
  if (followups.length !== 2) throw new Error('mode switch back to followup did not select followup path')
  if (steers.length !== 3) throw new Error('mode switch back to followup leaked a steer')
  session.append('turn/end', { turn, reason: { kind: 'max-tokens' } })
  inbox.nextTurn.length = 0

  for (const dispose of cleanup.reverse()) await dispose()
  fs.rmSync(path.join(root, '.test-dsh-home'), { recursive: true, force: true })
  console.log('OK: isolated followup and steer max-tokens policies')
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
