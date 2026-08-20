// Smoke test for dsh-continue-on-limit:
// 1. node --check on lib/index.js + lib/client.js
// 2. Host half: apply() registers the GET /api/dsh-continue-on-limit/config
//    route; the handler resolves the settings namespace (defaults when the
//    namespace is absent, overrides when configured) and rejects non-GET verbs.
// 3. Client bundle: the additive header.actions registration + the plugin's OWN
//    max-tokens chat-node definition (registered on conversationEvents, null
//    view on conversation.chat.node), the pure detection across every branch
//    (disabled / busy / queued / no-notice / not-tail / handled / cooldown /
//    cap / send) with the dual source (legacy nodes + chat snapshot), the
//    chain-reset policy, loadConfig against a mocked fetch, and the SSR null
//    render.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const pkg = path.resolve(__dirname, '..');
const bundle = path.join(pkg, 'lib/client.js');
const hostFile = path.join(pkg, 'lib/index.js');

// The host half imports harness packages. When this checkout has no
// node_modules (fresh clone), junction the harness install's node_modules
// from $DSH_HARNESS_NODE_MODULES so the smoke test still runs against a real
// install.
const localNodeModules = path.join(pkg, 'node_modules');
const harnessModules = process.env.DSH_HARNESS_NODE_MODULES ?? 'C:/Users/cbn/.dsh/profiles/node_modules';
if (!fs.existsSync(localNodeModules) && fs.existsSync(harnessModules)) {
  fs.symlinkSync(harnessModules, localNodeModules, 'junction');
}

// --- 1. syntax ---
execFileSync(process.execPath, ['--check', bundle], { stdio: 'inherit' });
execFileSync(process.execPath, ['--check', hostFile], { stdio: 'inherit' });
console.log('OK: node --check passed (client.js + index.js)');

// --- 2. host route tests ---
async function hostTests() {
  const host = await import('file:///' + hostFile.replace(/\\/g, '/'));
  if (host.name !== 'dsh-continue-on-limit-host') throw new Error('bad host name: ' + host.name);
  for (const service of ['webServer', 'settings']) {
    if (!host.inject.includes(service)) throw new Error('host missing inject: ' + service);
  }

  const registeredRoutes = [];
  let namespaceConfig = null;
  const ctx = {
    effect(fn) { fn(); },
    inject(services, cb) {
      cb({
        settings: { register: () => ({ get: () => namespaceConfig }) },
      });
    },
    webServer: {
      register(route) { registeredRoutes.push(route); return () => {}; },
    },
  };
  host.apply(ctx);
  const route = registeredRoutes.find((r) => r.path === '/api/dsh-continue-on-limit/config');
  if (route === undefined) throw new Error('config route not registered');
  if (route.kind !== 'exact') throw new Error('wrong route kind: ' + JSON.stringify(route));
  console.log('OK: host registers the config route');

  function fakeRes() {
    let status = 0;
    let body = '';
    return {
      res: {
        writeHead(s) { status = s; },
        end(b) { body = b; },
      },
      status: () => status,
      body: () => body,
    };
  }

  // absent namespace -> defaults
  namespaceConfig = null;
  let f = fakeRes();
  await route.handler({ method: 'GET' }, f.res);
  let parsed = JSON.parse(f.body());
  if (f.status() !== 200 || parsed.ok !== true) throw new Error('defaults path wrong: ' + f.status() + ' ' + f.body());
  if (parsed.config.enabled !== true || parsed.config.continueText !== '继续' || parsed.config.maxConsecutive !== 3 || parsed.config.minIntervalMs !== 1500) {
    throw new Error('defaults wrong: ' + JSON.stringify(parsed.config));
  }
  console.log('OK: host route returns composition defaults');

  // configured namespace -> overrides
  namespaceConfig = { enabled: false, continueText: '请继续', maxConsecutive: 5, minIntervalMs: 800 };
  f = fakeRes();
  await route.handler({ method: 'GET' }, f.res);
  parsed = JSON.parse(f.body());
  if (parsed.config.enabled !== false || parsed.config.continueText !== '请继续' || parsed.config.maxConsecutive !== 5 || parsed.config.minIntervalMs !== 800) {
    throw new Error('overrides wrong: ' + JSON.stringify(parsed.config));
  }
  console.log('OK: host route returns configured overrides');

  // non-GET -> 405
  f = fakeRes();
  await route.handler({ method: 'POST' }, f.res);
  parsed = JSON.parse(f.body());
  if (f.status() !== 405 || parsed.ok !== false || parsed.error.code !== 'method-not-allowed') {
    throw new Error('method-not-allowed path wrong: ' + f.status() + ' ' + f.body());
  }
  console.log('OK: host route rejects non-GET');
}

// --- 3. client bundle tests ---
async function clientTests() {
  const react = require(path.join(harnessModules, 'react'));
  const jsxRuntime = require(path.join(harnessModules, 'react/jsx-runtime'));

  const loader = {};
  global.window = {
    __ModuleLoader__: {
      load(entry) {
        loader.id = entry.id;
        loader.exports = entry.factory((spec) => {
          if (spec === 'react') return react;
          if (spec === 'react/jsx-runtime') return jsxRuntime;
          throw new Error('unexpected require: ' + spec);
        });
      },
    },
  };
  try {
    const source = fs.readFileSync(bundle, 'utf8');
    (0, eval)(source);
  } finally {
    delete global.window;
  }
  if (loader.id !== 'dsh-continue-on-limit') throw new Error('wrong bundle id: ' + loader.id);
  const client = loader.exports;
  if (client.inject.length !== 2 || client.inject[0] !== 'slots' || client.inject[1] !== 'sessions') {
    throw new Error('wrong client inject: ' + JSON.stringify(client.inject));
  }
  console.log('OK: client bundle loads, inject slots+sessions');

  // registration: own max-tokens definition + null view + header.actions entry
  const registeredDefinitions = [];
  const entries = [];
  const ctx = {
    get: (name) => {
      if (name === 'sessions') return sessionsMock;
      if (name === 'conversationEvents') return {
        register(def) { registeredDefinitions.push(def); return () => {}; },
      };
      return undefined;
    },
    slots: {
      inject(key, factory) {
        if (key !== 'conversation.chat.node' && key !== 'conversation.session.header.actions') {
          throw new Error('wrong injected seat: ' + key);
        }
        const registerCall = factory();
        registerCall();
        return () => {};
      },
      register(opts, component) {
        entries.push({ opts, component });
        return () => {};
      },
    },
  };
  const sessionsMock = {
    list: {
      getSnapshot: () => ({ ids: ['session-1'], byId: {}, current: 'session-1' }),
    },
    binding: () => undefined,
  };
  client.apply(ctx);

  const definition = registeredDefinitions[0];
  if (definition === undefined) throw new Error('own max-tokens definition not registered');
  if (definition.kind !== 'continue-max-tokens') throw new Error('wrong definition kind: ' + definition.kind);
  if (definition.target !== 'chat') throw new Error('wrong definition target: ' + definition.target);
  const matched = definition.match({ type: 'turn/end', seq: 200, time: 1, data: { turn: 4, reason: { kind: 'max-tokens' } } });
  if (matched === null || matched.id !== '4' || matched.role !== 'start') throw new Error('definition match wrong: ' + JSON.stringify(matched));
  if (definition.match({ type: 'turn/end', seq: 201, time: 1, data: { turn: 5, reason: { kind: 'stop' } } }) !== null) throw new Error('definition matched a non-max-tokens turn/end');
  if (definition.match({ type: 'assistant/message', seq: 202, time: 1, data: {} }) !== null) throw new Error('definition matched a non-turn/end event');
  const state = definition.start({}, { event: { type: 'turn/end', seq: 200, time: 1, data: { turn: 4, reason: { kind: 'max-tokens' } } } });
  if (state.turn !== 4 || state.seq !== 200) throw new Error('definition start state wrong: ' + JSON.stringify(state));
  const built = definition.buildViewNode({ state, key: 'k-1', id: '4', start: { location: { kind: 'turn', turn: {} } }, matches: [] });
  if (built.kind !== 'continue-max-tokens' || built.visibility !== 'hidden' || built.data.seq !== 200 || built.data.turn !== 4) {
    throw new Error('definition buildViewNode wrong: ' + JSON.stringify(built));
  }
  const nullView = entries.find((e) => e.opts.name === 'conversation.chat.node' && e.opts.key === 'continue-max-tokens');
  if (nullView === undefined) throw new Error('null view for continue-max-tokens not registered');
  const action = entries.find((e) => e.opts.name === 'conversation.session.header.actions');
  if (action === undefined) throw new Error('header.actions entry not registered');
  if (action.opts.id !== 'continue-on-limit' || action.opts.priority !== 10) throw new Error('wrong header action opts: ' + JSON.stringify(action.opts));
  console.log('OK: client registers own max-tokens definition, null view, and header.actions entry');

  // --- collectNoticeCandidates + evaluate() policy branches ---
  const config = { enabled: true, continueText: '继续', maxConsecutive: 3, minIntervalMs: 1500 };
  const notice = { kind: 'turn-max-tokens', seq: 100.05, time: 1, turn: 2, step: 0 };
  const ownNotice = { kind: 'continue-max-tokens', seq: 100, time: 1, turn: 2, step: 0 };
  const frozen = { kind: 'assistant', seq: 99.1, time: 1, turn: 2, step: 0, blocks: [], interrupted: true };
  const userMsg = { kind: 'user', seq: 0, time: 0, content: [{ type: 'text', text: '写一个脚本' }], source: {} };
  const chatNodes = (nodes) => ({ nodes: { values: () => nodes } });
  const baseSnapshot = {
    sessionId: 'session-1',
    nodes: [userMsg, frozen, notice],
    chat: chatNodes([]),
    queue: [],
    pending: [],
    running: false,
    removed: false,
    openState: 'open',
  };
  const freshState = () => ({ lastNoticeSeq: -1, consecutive: 0, lastSentAt: 0 });

  // disabled
  let verdict = client.evaluate(baseSnapshot, freshState(), { ...config, enabled: false }, 1000);
  if (verdict.action !== 'disabled') throw new Error('disabled branch: ' + JSON.stringify(verdict));
  // removed / not-open / running / queued
  verdict = client.evaluate({ ...baseSnapshot, removed: true }, freshState(), config, 1000);
  if (verdict.action !== 'removed') throw new Error('removed branch: ' + JSON.stringify(verdict));
  verdict = client.evaluate({ ...baseSnapshot, openState: 'loading' }, freshState(), config, 1000);
  if (verdict.action !== 'not-open') throw new Error('not-open branch: ' + JSON.stringify(verdict));
  verdict = client.evaluate({ ...baseSnapshot, running: true }, freshState(), config, 1000);
  if (verdict.action !== 'running') throw new Error('running branch: ' + JSON.stringify(verdict));
  verdict = client.evaluate({ ...baseSnapshot, queue: [{ id: 'q-1' }] }, freshState(), config, 1000);
  if (verdict.action !== 'queued') throw new Error('queued branch: ' + JSON.stringify(verdict));
  verdict = client.evaluate({ ...baseSnapshot, pending: [{ id: 'p-1' }] }, freshState(), config, 1000);
  if (verdict.action !== 'queued') throw new Error('pending branch: ' + JSON.stringify(verdict));
  // no notice (neither source)
  verdict = client.evaluate({ ...baseSnapshot, nodes: [userMsg, frozen], chat: chatNodes([]) }, freshState(), config, 1000);
  if (verdict.action !== 'no-notice') throw new Error('no-notice branch: ' + JSON.stringify(verdict));
  // notice not the tail (a later user message exists in the visible flow)
  verdict = client.evaluate({ ...baseSnapshot, nodes: [userMsg, frozen, notice, { ...userMsg, seq: 120, content: [{ type: 'text', text: '再写一个' }] }] }, freshState(), config, 1000);
  if (verdict.action !== 'not-tail') throw new Error('not-tail branch: ' + JSON.stringify(verdict));
  // handled
  verdict = client.evaluate(baseSnapshot, { lastNoticeSeq: 100.05, consecutive: 1, lastSentAt: 0 }, config, 1000);
  if (verdict.action !== 'handled') throw new Error('handled branch: ' + JSON.stringify(verdict));
  // cooldown
  verdict = client.evaluate(baseSnapshot, { lastNoticeSeq: -1, consecutive: 1, lastSentAt: 9900 }, config, 10000);
  if (verdict.action !== 'cooldown') throw new Error('cooldown branch: ' + JSON.stringify(verdict));
  // cap (consecutive >= maxConsecutive), notice is returned for marking handled
  verdict = client.evaluate(baseSnapshot, { lastNoticeSeq: -1, consecutive: 3, lastSentAt: 0 }, config, 10000);
  if (verdict.action !== 'cap' || verdict.notice !== notice) throw new Error('cap branch: ' + JSON.stringify(verdict));
  // send
  verdict = client.evaluate(baseSnapshot, freshState(), config, 10000);
  if (verdict.action !== 'send' || verdict.notice !== notice) throw new Error('send branch: ' + JSON.stringify(verdict));
  console.log('OK: evaluate() covers every branch');

  // --- dual-source detection ---
  // The harness's own turn-max-tokens lives only in the chat snapshot (older
  // ui-conversation without the legacy projection case): still detected.
  const chatOnlyNotice = { ...notice, seq: 100 };
  let chatSnapshot = { ...baseSnapshot, nodes: [userMsg, frozen], chat: chatNodes([{ kind: 'turn-max-tokens', data: chatOnlyNotice }]) };
  verdict = client.evaluate(chatSnapshot, freshState(), config, 10000);
  if (verdict.action !== 'send' || verdict.notice.seq !== 100) throw new Error('chat-only notice not detected: ' + JSON.stringify(verdict));
  // The plugin's OWN node fires when the harness ships no turn-max-tokens at
  // all (legacy flow ends at the frozen assistant, seq < own notice seq).
  const ownSnapshot = { ...baseSnapshot, nodes: [userMsg, frozen], chat: chatNodes([{ kind: 'continue-max-tokens', data: ownNotice }]) };
  verdict = client.evaluate(ownSnapshot, freshState(), config, 10000);
  if (verdict.action !== 'send' || verdict.notice !== ownNotice) throw new Error('own definition not detected: ' + JSON.stringify(verdict));
  // ... but a human message after the truncation still blocks it.
  const humanAfter = { ...baseSnapshot, nodes: [userMsg, frozen, { ...userMsg, seq: 150, content: [{ type: 'text', text: '我自己来' }] }], chat: chatNodes([{ kind: 'continue-max-tokens', data: ownNotice }]) };
  verdict = client.evaluate(humanAfter, freshState(), config, 10000);
  if (verdict.action !== 'not-tail') throw new Error('human after own notice must block: ' + JSON.stringify(verdict));
  // Dedup: the same truncation surfacing in both sources produces ONE candidate.
  const both = { ...baseSnapshot, nodes: [userMsg, frozen, notice], chat: chatNodes([
    { kind: 'turn-max-tokens', data: notice },
    { kind: 'continue-max-tokens', data: { ...ownNotice, seq: 100 } },
  ]) };
  const candidates = client.collectNoticeCandidates(both);
  const seqs = candidates.map((c) => c.seq).sort((a, b) => a - b);
  if (candidates.length !== 2 || seqs[0] !== 100 || seqs[1] !== 100.05) {
    throw new Error('candidate dedup wrong: ' + JSON.stringify(seqs));
  }
  verdict = client.evaluate(both, freshState(), config, 10000);
  if (verdict.action !== 'send') throw new Error('both-sources snapshot must send once: ' + JSON.stringify(verdict));
  console.log('OK: dual-source detection + dedup');

  // --- evaluateReset() ---
  // our own auto-continue message must NOT reset the chain
  const continueUser = { kind: 'user', seq: 101, time: 1, content: [{ type: 'text', text: '继续' }], source: {} };
  let reset = client.evaluateReset({ ...baseSnapshot, nodes: [userMsg, frozen, notice, continueUser] }, { lastNoticeSeq: 100.05, consecutive: 1 }, config);
  if (reset) throw new Error('our continue must not reset the chain');
  // a frozen (still truncated) assistant must NOT reset the chain
  const laterFrozen = { ...frozen, seq: 109.1, turn: 3 };
  const notice2 = { ...notice, seq: 110.05, turn: 3 };
  reset = client.evaluateReset({ ...baseSnapshot, nodes: [userMsg, frozen, notice, continueUser, laterFrozen, notice2] }, { lastNoticeSeq: 100.05, consecutive: 1 }, config);
  if (reset) throw new Error('frozen assistant must not reset the chain');
  // a normally completed assistant resets
  const finalized = { kind: 'assistant', seq: 120, time: 1, turn: 3, step: 0, blocks: [{ kind: 'text', text: '完成' }], messageId: 'm-1' };
  reset = client.evaluateReset({ ...baseSnapshot, nodes: [userMsg, frozen, notice, continueUser, finalized] }, { lastNoticeSeq: 100.05, consecutive: 1 }, config);
  if (!reset) throw new Error('completed assistant must reset the chain');
  // a human message that is not our continue resets
  const human = { kind: 'user', seq: 130, time: 1, content: [{ type: 'text', text: '换个问题' }], source: {} };
  reset = client.evaluateReset({ ...baseSnapshot, nodes: [userMsg, frozen, notice, continueUser, finalized, human] }, { lastNoticeSeq: 100.05, consecutive: 1 }, config);
  if (!reset) throw new Error('human message must reset the chain');
  console.log('OK: evaluateReset() covers the chain-reset branches');

  // --- loadConfig() against a mocked fetch ---
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => ({ ok: true, json: async () => ({ ok: true, config: { enabled: false, continueText: '请继续', maxConsecutive: 5, minIntervalMs: 800 } }) });
    const configured = await client.loadConfig();
    if (configured.enabled !== false || configured.continueText !== '请继续' || configured.maxConsecutive !== 5 || configured.minIntervalMs !== 800) {
      throw new Error('loadConfig configured wrong: ' + JSON.stringify(configured));
    }
    console.log('OK: loadConfig merges the host section');

    global.fetch = async () => { throw new Error('network down'); };
    const fallenBack = await client.loadConfig();
    if (fallenBack.enabled !== true || fallenBack.continueText !== '继续' || fallenBack.maxConsecutive !== 3) {
      throw new Error('loadConfig fallback wrong: ' + JSON.stringify(fallenBack));
    }
    console.log('OK: loadConfig falls back to defaults on failure');

    global.fetch = async () => ({ ok: true, json: async () => ({ ok: true, config: { continueText: '' } }) });
    const normalized = await client.loadConfig();
    if (normalized.continueText !== '继续') throw new Error('loadConfig empty continueText not normalized: ' + JSON.stringify(normalized));
    console.log('OK: loadConfig normalizes an empty continueText');
  } finally {
    global.fetch = originalFetch;
  }

  // --- SSR: the observer renders nothing ---
  const renderer = require(path.join(harnessModules, 'react-dom/server'));
  const html = renderer.renderToString(react.createElement(client.AutoContinue, {
    useSession: (sel) => sel(baseSnapshot),
    sessions: sessionsMock,
  }));
  if (html !== '') throw new Error('observer must render nothing, got: ' + html);
  console.log('OK: client SSR renders nothing (invisible observer)');
}

async function main() {
  await hostTests();
  await clientTests();
  console.log('all smoke tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
