//#region lib/index.js
/**
 * Continue-on-limit plugin, node half. Owns the settings namespace and the one
 * read route the browser half consumes:
 *
 *   GET /api/dsh-continue-on-limit/config
 *
 * The actual work — watching the conversation for the harness's max-tokens
 * notice (`turn-max-tokens`) and sending the "continue" text when it lands —
 * happens entirely in the browser half against the client sessions runtime.
 * This half only resolves the `dsh-continue-on-limit` settings (feature
 * switch, the resume text, the consecutive-chain cap, and the inter-send
 * cooldown), mirroring the settings-namespace discipline of the other plugins
 * in this family. The client fails open to the defaults below when the route
 * is unreachable, so a missing namespace never breaks the auto-continue.
 */
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'

const name = 'dsh-continue-on-limit-host'
const inject = ['webServer', 'settings']

/** Settings namespace holding the auto-continue configuration. */
const NS = settingsNamespace('dsh-continue-on-limit')
/**
 * Schema: the feature switch, the exact text sent to resume the reply, the
 * maximum number of back-to-back auto-continues without the model completing
 * a turn (burst protection — a model that always hits the cap cannot drain
 * tokens forever), and the minimum gap between two auto-sends.
 */
const SCHEMA = z.object({
  enabled: z.boolean().default(true),
  continueText: z.string().default('继续'),
  maxConsecutive: z.number().default(3),
  minIntervalMs: z.number().default(1500),
})
/** Composition defaults when the settings namespace is absent. */
const DEFAULTS = {
  enabled: true,
  continueText: '继续',
  maxConsecutive: 3,
  minIntervalMs: 1500,
}

/**
 * Write a JSON response the handler fully owns.
 * @param res - the response.
 * @param status - HTTP status.
 * @param payload - JSON-serializable payload.
 */
function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

/**
 * Resolve the configuration, falling back to the composition defaults when the
 * settings namespace yields no object (a bare host or a namespace that has not
 * settled yet). The client merges over its own defaults anyway; this keeps the
 * route self-contained.
 * @param source - settings resolver for the auto-continue configuration.
 * @returns the plain config object.
 */
function resolveConfig(source) {
  const resolved = source()
  return resolved !== null && typeof resolved === 'object' ? resolved : DEFAULTS
}

/**
 * Handle `GET /api/dsh-continue-on-limit/config`. Resolves the settings
 * namespace through the composition and returns the plain config object; any
 * transport/parse failure is the client's problem (it falls back to the
 * defaults). Non-GET verbs are rejected.
 * @param req - the incoming request.
 * @param res - the response.
 * @param source - settings resolver for the auto-continue configuration.
 */
async function handleConfig(req, res, source) {
  if (req.method !== 'GET') {
    send(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'this route only serves GET' } })
    return
  }
  send(res, 200, { ok: true, config: resolveConfig(source) })
}

/**
 * Register the settings namespace and the config route for the browser half.
 * @param ctx - host context carrying the webServer and settings services.
 */
function apply(ctx) {
  let source = () => DEFAULTS
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(NS, SCHEMA)
    source = () => scope.get()
  })
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/api/dsh-continue-on-limit/config',
      handler: (req, res) => handleConfig(req, res, source),
    }),
    'dsh-continue-on-limit: config route',
  )
}
//#endregion
export { apply, inject, name };
