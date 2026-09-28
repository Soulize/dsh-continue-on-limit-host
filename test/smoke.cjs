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
  if (typeof host.Config !== 'function' && typeof host.Config !== 'object') throw new Error('Config export missing')
  if (host.DEFAULTS.includeSubagents !== true || host.DEFAULTS.minIntervalMs !== 0) {
    throw new Error('subagent-safe defaults are wrong: ' + JSON.stringify(host.DEFAULTS))
  }

  const listeners = new Map()
  const settingsCalls = []
  const sent = []
  const logs = []
  const events = []
  const inbox = { nextTurn: [], nextStep: [] }
  const session = {
    id: 'root-1',
    header: {},
    snapshotEvents() { return [...events] },
  }
  const agent = {
    session,
    status: 'running',
    inbox,
    followup(message) {
      sent.push(message)
      inbox.nextTurn.push(message)
    },
  }
  const config = {
    enabled: true,
    continueText: '继续',
    maxConsecutive: 3,
    minIntervalMs: 0,
    includeSubagents: true,
    debugLogging: false,
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

  let seq = 1
  let turn = 0
  const emitSession = (event) => {
    events.push(event)
    for (const cb of listeners.get('session/event') ?? []) cb(session, event)
  }
  const emitStopping = async (number) => {
    const payload = { agent, turn: number, signal: new AbortController().signal }
    for (const cb of listeners.get('agent/turn-stopping') ?? []) await cb(payload)
  }
  const finishStream = (kind) => [{ type: 'chunk', time: Date.now(), chunk: { type: 'finish', reason: { kind } } }]
  const runMax = async () => {
    turn += 1
    emitSession({ type: 'turn/start', seq: seq++, data: { turn } })
    emitSession({
      type: 'assistant/message',
      seq: seq++,
      data: {
        turn,
        step: 1,
        message: { id: 'assistant-' + turn, role: 'assistant', content: [], source: { provider: 'mock', model: 'mock' } },
        stream: finishStream('max-tokens'),
      },
      surfaceOp: 'append',
    })
    await emitStopping(turn)
    emitSession({ type: 'turn/end', seq: seq++, data: { turn, reason: { kind: 'max-tokens' } } })
    // Simulate AgentLoop claiming the queued next-turn message before the next turn.
    inbox.nextTurn.length = 0
  }
  const runCompleted = () => {
    turn += 1
    emitSession({ type: 'turn/start', seq: seq++, data: { turn } })
    emitSession({ type: 'turn/end', seq: seq++, data: { turn, reason: { kind: 'completed' } } })
  }

  config.debugLogging = true
  await runMax()
  if (!logs.some(line => line.includes('MAX_TOKENS_PRESTOP_CAPTURED'))) {
    throw new Error('debug log did not report MAX_TOKENS_PRESTOP_CAPTURED')
  }
  if (!logs.some(line => line.includes('AUTO_CONTINUE_QUEUED_PRE_TURN_END'))) {
    throw new Error('debug log did not report AUTO_CONTINUE_QUEUED_PRE_TURN_END')
  }
  if (!logs.some(line => line.includes('MAX_TOKENS_CONFIRMED') && line.includes('prestopHandled=true'))) {
    throw new Error('turn/end did not confirm prestop handling')
  }
  config.debugLogging = false
  if (sent.length !== 1 || sent[0].content?.[0]?.text !== '继续') throw new Error('max-tokens did not queue a continuation')
  if (sent[0].source?.kind !== 'dsh-continue-on-limit-host') throw new Error('continuation must use the plugin-owned source kind')

  await runMax()
  await runMax()
  if (sent.length !== 3) throw new Error('three consecutive max-tokens turns should produce three continuations')
  await runMax()
  if (sent.length !== 3) throw new Error('maxConsecutive cap was not enforced')

  runCompleted()
  await runMax()
  if (sent.length !== 4) throw new Error('normal completion did not reset the chain')

  inbox.nextTurn.push({})
  turn += 1
  emitSession({ type: 'turn/start', seq: seq++, data: { turn } })
  emitSession({
    type: 'assistant/message', seq: seq++,
    data: { turn, step: 1, message: { id: 'assistant-pending', role: 'assistant', content: [], source: { provider: 'mock', model: 'mock' } }, stream: finishStream('max-tokens') },
    surfaceOp: 'append',
  })
  await emitStopping(turn)
  if (sent.length !== 4) throw new Error('pending inbox work must block auto-continue')
  inbox.nextTurn.length = 0
  emitSession({ type: 'turn/end', seq: seq++, data: { turn, reason: { kind: 'max-tokens' } } })

  session.header.origin = 'subagent'
  config.includeSubagents = false
  await runMax()
  if (sent.length !== 4) throw new Error('includeSubagents=false should skip the child')

  config.includeSubagents = true
  config.minIntervalMs = 0
  await runMax()
  if (sent.length !== 5) throw new Error('subagent continuation must queue at turn-stopping before turn/end')
  session.header.origin = undefined

  emitSession({ type: 'user/message', seq: seq++, data: { source: { kind: 'user' } } })
  await runMax()
  if (sent.length !== 6) throw new Error('human input did not reset the chain')

  for (const dispose of cleanup.reverse()) await dispose()
  fs.rmSync(path.join(root, '.test-dsh-home'), { recursive: true, force: true })
  console.log('OK: host prestop max-tokens policy')
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
