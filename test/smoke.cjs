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
  if (!host.inject.includes('agents')) throw new Error('host must inject agents')
  if (typeof host.Config !== 'function' && typeof host.Config !== 'object') throw new Error('Config export missing')
  if (host.DEFAULTS.includeSubagents !== true || host.DEFAULTS.minIntervalMs !== 0) {
    throw new Error('subagent-safe defaults are wrong: ' + JSON.stringify(host.DEFAULTS))
  }

  const listeners = new Map()
  const settingsCalls = []
  const sent = []
  const logs = []
  const session = { id: 'root-1', header: {} }
  const agent = {
    session,
    inbox: { nextTurn: [], nextStep: [] },
    followup(message) { sent.push(message) },
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
  const emitSession = (event) => {
    for (const cb of listeners.get('session/event') ?? []) cb(session, event)
  }
  const max = () => emitSession({ type: 'turn/end', seq: seq++, data: { turn: seq, reason: { kind: 'max-tokens' } } })
  const completed = () => emitSession({ type: 'turn/end', seq: seq++, data: { turn: seq, reason: { kind: 'completed' } } })

  config.debugLogging = true
  max()
  await delay(5)
  if (!logs.some(line => line.includes('TURN_END_CAPTURED') && line.includes('reason=max-tokens'))) {
    throw new Error('debug log did not report TURN_END_CAPTURED max-tokens')
  }
  if (!logs.some(line => line.includes('MAX_TOKENS_CAPTURED'))) {
    throw new Error('debug log did not report MAX_TOKENS_CAPTURED')
  }
  if (!logs.some(line => line.includes('AUTO_CONTINUE_QUEUED'))) {
    throw new Error('debug log did not report AUTO_CONTINUE_QUEUED')
  }
  config.debugLogging = false
  if (sent.length !== 1 || sent[0].content?.[0]?.text !== '继续') throw new Error('max-tokens did not queue a continuation')
  if (sent[0].source?.kind !== 'dsh-continue-on-limit-host') throw new Error('continuation must use the plugin-owned source kind')

  max(); max()
  await delay(5)
  if (sent.length !== 3) throw new Error('three consecutive max-tokens turns should produce three continuations')
  max()
  await delay(5)
  if (sent.length !== 3) throw new Error('maxConsecutive cap was not enforced')

  completed()
  max()
  await delay(5)
  if (sent.length !== 4) throw new Error('normal completion did not reset the chain')

  agent.inbox.nextTurn.push({})
  max()
  await delay(5)
  if (sent.length !== 4) throw new Error('pending inbox work must block auto-continue')
  agent.inbox.nextTurn.length = 0

  session.header.origin = 'subagent'
  config.includeSubagents = false
  max()
  await delay(5)
  if (sent.length !== 4) throw new Error('includeSubagents=false should skip the child')

  // A continuable child can naturally settle as soon as it becomes idle with
  // an empty inbox. Even with a large root-session delay configured, the
  // subagent continuation must therefore be queued synchronously in turn/end.
  config.includeSubagents = true
  config.minIntervalMs = 5000
  max()
  if (sent.length !== 5) throw new Error('subagent continuation must enqueue synchronously before Activation settlement')
  config.minIntervalMs = 0
  session.header.origin = undefined

  emitSession({ type: 'user/message', seq: seq++, data: { source: { kind: 'user' } } })
  max()
  await delay(5)
  if (sent.length !== 6) throw new Error('human input did not reset the chain')

  for (const dispose of cleanup.reverse()) await dispose()
  console.log('OK: host global max-tokens policy')
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
