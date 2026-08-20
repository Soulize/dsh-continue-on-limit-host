window.__ModuleLoader__.load({
	id: "dsh-continue-on-limit",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");

		//#region dsh-continue-on-limit/config.js
		/**
		 * Default configuration, mirrored from the host half. Used until the
		 * config route answers, so a slow or missing host never stalls the
		 * auto-continue.
		 */
		const CONFIG_DEFAULTS = Object.freeze({
			enabled: true,
			continueText: "继续",
			maxConsecutive: 3,
			minIntervalMs: 1500,
		});

		/**
		 * Resolve the plugin configuration from the host route, merged over the
		 * defaults so an older host (or a settings namespace that gained fields)
		 * still yields a complete object. Any failure falls back to the defaults —
		 * a config fetch hiccup must never block auto-continue.
		 * @returns the resolved configuration object.
		 */
		async function loadConfig() {
			try {
				const response = await fetch("/api/dsh-continue-on-limit/config", { method: "GET" });
				if (!response.ok) throw new Error("config route responded " + response.status);
				const data = await response.json();
				const section = data?.ok === true && data.config !== null && typeof data.config === "object" ? data.config : null;
				if (section === null) throw new Error("config route payload is not an object");
				const config = { ...CONFIG_DEFAULTS, ...section };
				if (typeof config.continueText !== "string" || config.continueText.trim() === "") config.continueText = CONFIG_DEFAULTS.continueText;
				return config;
			} catch (error) {
				console.warn("[dsh-continue-on-limit] 读取配置失败，使用默认配置：", error instanceof Error ? error.message : error);
				return { ...CONFIG_DEFAULTS };
			}
		}
		//#endregion

		//#region dsh-continue-on-limit/detection.js
		/**
		 * Kind of the plugin's OWN max-tokens chat node. The plugin registers this
		 * definition itself (see index.js) so detection never depends on whether
		 * the harness's ui-conversation ships its `turn-max-tokens` definition:
		 * the signal is derived straight from the `turn/end` event carrying
		 * `reason.kind === "max-tokens"`.
		 */
		const CONTINUE_MAX_TOKENS_KIND = "continue-max-tokens";

		/**
		 * Collect every max-tokens notice visible to this snapshot, deduplicated
		 * by (kind, seq), from two sources:
		 *   - `snapshot.nodes` — the legacy flow projection (harness's
		 *     `turn-max-tokens` node when ui-conversation provides it);
		 *   - `snapshot.chat.nodes.values()` — every materialized chat node,
		 *     including hidden ones (the harness's `turn-max-tokens` node AND this
		 *     plugin's own `continue-max-tokens` node).
		 * @param snapshot - the session conversation snapshot.
		 * @returns the deduplicated notice list ({ kind, seq, time, turn, step }).
		 */
		function collectNoticeCandidates(snapshot) {
			const seen = new Map();
			const push = (kind, node) => {
				if (node === null || typeof node !== "object" || typeof node.seq !== "number") return;
				const key = kind + "@" + node.seq;
				if (!seen.has(key)) seen.set(key, node);
			};
			for (const node of snapshot.nodes ?? []) {
				if (node?.kind === "turn-max-tokens") push(node.kind, node);
			}
			for (const node of snapshot.chat?.nodes?.values?.() ?? []) {
				if (node?.kind === "turn-max-tokens" || node?.kind === CONTINUE_MAX_TOKENS_KIND) push(node.kind, node.data);
			}
			return [...seen.values()];
		}

		/** The highest-seq notice among the candidates, or null. */
		function lastMaxTokensNotice(candidates) {
			let notice = null;
			for (const candidate of candidates) {
				if (notice === null || candidate.seq > notice.seq) notice = candidate;
			}
			return notice;
		}

		/** The node with the highest seq in the legacy flow, or null when the window is empty. */
		function tailNode(nodes) {
			let tail = null;
			for (const node of nodes) {
				if (tail === null || node.seq > tail.seq) tail = node;
			}
			return tail;
		}

		/** Join the text parts of one conversation node's content. */
		function nodeText(node) {
			const content = node?.content;
			if (typeof content === "string") return content;
			if (Array.isArray(content)) {
				let text = "";
				for (const part of content) {
					if (part !== null && typeof part === "object" && typeof part.text === "string") text += part.text;
				}
				return text;
			}
			return "";
		}

		/** Whether a user/steering node is (probably) the auto-continue we sent. */
		function isAutoContinueText(node, continueText) {
			return typeof continueText === "string" && nodeText(node).trim() === continueText.trim();
		}

		/**
		 * Decide whether to auto-continue for one snapshot.
		 * @param snapshot - the session conversation snapshot.
		 * @param state - per-session { lastNoticeSeq, consecutive, lastSentAt }.
		 * @param config - resolved plugin configuration.
		 * @param now - epoch ms timestamp for the cooldown check.
		 * @returns one of: disabled / removed / not-open / running / queued /
		 *   no-notice / not-tail / handled / cooldown / cap / send { notice }.
		 */
		function evaluate(snapshot, state, config, now) {
			if (config.enabled !== true) return { action: "disabled" };
			if (snapshot.removed) return { action: "removed" };
			if (snapshot.openState !== "open") return { action: "not-open" };
			if (snapshot.running) return { action: "running" };
			if (snapshot.queue.length > 0 || snapshot.pending.length > 0) return { action: "queued" };
			const notice = lastMaxTokensNotice(collectNoticeCandidates(snapshot));
			if (notice === null) return { action: "no-notice" };
			// The truncation must be the last thing in the visible flow: any node
			// after it (a later user message, a later turn, a steering) means the
			// human already moved on and auto-continue would be wrong.
			for (const node of snapshot.nodes ?? []) {
				if (node.seq > notice.seq) return { action: "not-tail" };
			}
			if (notice.seq === state.lastNoticeSeq) return { action: "handled" };
			if (now - state.lastSentAt < config.minIntervalMs) return { action: "cooldown" };
			if (state.consecutive >= config.maxConsecutive) return { action: "cap", notice };
			return { action: "send", notice };
		}

		/**
		 * Whether the chain counter should reset: the human interjected a message
		 * that is not our auto-continue, or the model completed a turn normally
		 * after our last continue (only a still-truncated continuation keeps the
		 * chain alive). Pure; the caller zeroes `state.consecutive` on true.
		 * @param snapshot - the session conversation snapshot.
		 * @param state - per-session { lastNoticeSeq, consecutive }.
		 * @param config - resolved plugin configuration.
		 * @returns true when the consecutive chain must start over.
		 */
		function evaluateReset(snapshot, state, config) {
			for (const node of snapshot.nodes ?? []) {
				if (node.seq <= state.lastNoticeSeq) continue;
				if (node.kind === "user" || node.kind === "steering") {
					if (!isAutoContinueText(node, config.continueText)) return true;
				} else if (node.kind === "assistant" && node.interrupted !== true) {
					return true;
				}
			}
			return false;
		}
		//#endregion

		//#region dsh-continue-on-limit/max-tokens-definition.js
		/**
		 * The plugin's own chat-node definition: matches a `turn/end` event whose
		 * reason is the output-token cap and materializes a hidden
		 * `continue-max-tokens` node in the chat snapshot. Hidden nodes stay
		 * readable through `chat.nodes.values()` but never render, and a null view
		 * is registered for the kind as a second guard.
		 */
		function maxTokensState(match) {
			const event = match?.event;
			if (event?.type !== "turn/end" || event.data?.reason?.kind !== "max-tokens") return void 0;
			return { turn: event.data.turn, seq: event.seq, time: event.time };
		}

		const continueMaxTokensDefinition = {
			kind: CONTINUE_MAX_TOKENS_KIND,
			target: "chat",
			match: (event) => {
				if (event?.type === "turn/end" && event.data?.reason?.kind === "max-tokens") {
					return { id: String(event.data.turn), role: "start" };
				}
				return null;
			},
			start: (_context, match) => {
				const state = maxTokensState(match);
				if (state === void 0) throw new Error("continue-max-tokens start requires a max-tokens turn/end");
				return state;
			},
			update: (context) => context.state,
			buildViewNode: (context) => {
				const state = context.state;
				if (state === void 0) return null;
				const data = { kind: CONTINUE_MAX_TOKENS_KIND, seq: state.seq, time: state.time, turn: state.turn, step: 0 };
				return {
					key: context.key,
					kind: CONTINUE_MAX_TOKENS_KIND,
					id: context.id,
					target: "chat",
					anchorSeq: state.seq,
					location: context.start?.location ?? context.matches?.[0]?.location ?? { kind: "unresolved" },
					visibility: "hidden",
					data,
				};
			},
		};
		//#endregion

		//#region dsh-continue-on-limit/AutoContinue.js
		/**
		 * The invisible observer. Rides the session-scoped
		 * `conversation.session.header.actions` seat and renders nothing; its job
		 * is to subscribe to the staged session's snapshot and, when a fresh
		 * max-tokens notice appears at the tail of an idle conversation, send the
		 * configured continue text through the session face's `prompt` verb.
		 *
		 * Guardrails, all enforced by the pure `evaluate` policy: the truncation
		 * must be the last thing in the visible flow (the human did not move on),
		 * the session must be idle with an empty queue, the same notice is handled
		 * at most once, a cooldown spaces consecutive sends, and a burst cap stops
		 * the chain when the model keeps hitting the cap without ever completing a
		 * turn. A human message or a normally completed assistant turn resets the
		 * chain counter.
		 * @param props.useSession - session-scope snapshot selector (standard prop).
		 * @param props.sessions - the client sessions runtime (captured in apply).
		 */
		const AutoContinue = react.memo(function AutoContinue({ useSession, sessions }) {
			const snapshot = useSession((s) => s);
			const sessionId = snapshot.sessionId;
			const stateRef = react.useRef({ config: CONFIG_DEFAULTS, lastNoticeSeq: -1, consecutive: 0, lastSentAt: 0 });

			// Resolve the host configuration once per session (a reload re-reads it).
			react.useEffect(() => {
				let alive = true;
				loadConfig().then((config) => {
					if (alive) stateRef.current.config = config;
				});
				return () => {
					alive = false;
				};
			}, [sessionId]);

			// Fresh session identity: start a clean chain.
			react.useEffect(() => {
				stateRef.current = { ...stateRef.current, lastNoticeSeq: -1, consecutive: 0, lastSentAt: 0 };
			}, [sessionId]);

			// Mount diagnostic: makes a silent failure loud. If this line never
			// appears, the client half did not load (install/bundle issue); the
			// counts tell which detection sources are live in this harness.
			react.useEffect(() => {
				let flow = 0, chat = 0, own = 0;
				for (const node of snapshot.nodes ?? []) if (node?.kind === "turn-max-tokens") flow += 1;
				for (const node of snapshot.chat?.nodes?.values?.() ?? []) {
					if (node?.kind === "turn-max-tokens") chat += 1;
					if (node?.kind === CONTINUE_MAX_TOKENS_KIND) own += 1;
				}
				console.info("[dsh-continue-on-limit] 观察器已挂载：turn-max-tokens(flow/chat)=" + flow + "/" + chat + "，自有定义=" + own);
			}, [sessionId]);

			// The auto-continue effect: runs on every snapshot change, idempotent via evaluate.
			react.useEffect(() => {
				const state = stateRef.current;
				const config = state.config;
				const verdict = evaluate(snapshot, state, config, Date.now());
				if (verdict.action === "cap") {
					state.lastNoticeSeq = verdict.notice.seq;
					console.warn("[dsh-continue-on-limit] 连续自动继续已达上限（" + config.maxConsecutive + " 次），请手动发送「" + config.continueText + "」继续");
					return;
				}
				if (verdict.action !== "send") return;
				const session = sessions.binding(sessionId)?.session;
				if (session === undefined) return;
				const text = config.continueText;
				state.lastSentAt = Date.now();
				state.consecutive += 1;
				console.info("[dsh-continue-on-limit] 检测到输出达到上限（turn " + verdict.notice.turn + "），自动发送「" + text + "」");
				session.prompt([{ type: "text", text }], "queue").then((result) => {
					if (!result.ok) throw new Error(String(result.error?.message ?? result.error?.code ?? "prompt rejected"));
					state.lastNoticeSeq = verdict.notice.seq;
				}).catch((error) => {
					// The notice stays unhandled; the cooldown gates a retry on the
					// next snapshot change. A persistent failure hits the burst cap.
					console.warn("[dsh-continue-on-limit] 自动发送「" + text + "」失败：", error instanceof Error ? error.message : error);
				});
			}, [snapshot, sessionId]);

			// The chain-reset effect: human input or a normally completed turn starts over.
			react.useEffect(() => {
				const state = stateRef.current;
				if (state.consecutive === 0) return;
				if (evaluateReset(snapshot, state, state.config)) {
					state.consecutive = 0;
					console.info("[dsh-continue-on-limit] 检测到用户新消息或模型已正常完成回复，重置自动继续计数");
				}
			}, [snapshot]);

			return null;
		});
		//#endregion

		//#region dsh-continue-on-limit/index.js
		/**
		 * Client plugin body: one additive entry on the
		 * `conversation.session.header.actions` list seat (session scope) — the
		 * same seat the context-compressor rides. The entry renders nothing; it
		 * exists to subscribe the auto-continue policy to the staged session's
		 * snapshot. Additionally the plugin registers its OWN chat-node definition
		 * for `turn/end` with a max-tokens reason (hidden, never rendered) so the
		 * detection works even when the harness's ui-conversation ships no
		 * `turn-max-tokens` definition. Nothing in the stock composition is
		 * replaced or disabled.
		 * @param ctx - client root context.
		 */
		const inject = ["slots", "sessions"];
		function apply(ctx) {
			const sessions = ctx.get("sessions");

			// Register the plugin-owned max-tokens chat node. Fail open: if the
			// conversation events service is absent or the registration throws,
			// detection simply relies on the snapshot sources instead.
			try {
				const conversationEvents = ctx.get("conversationEvents");
				if (conversationEvents !== void 0) {
					conversationEvents.register(continueMaxTokensDefinition);
					ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
						name: "conversation.chat.node",
						key: CONTINUE_MAX_TOKENS_KIND,
					}, () => null));
				}
			} catch (error) {
				console.warn("[dsh-continue-on-limit] 注册自有 max-tokens 节点失败，回退到快照检测：", error instanceof Error ? error.message : error);
			}

			const AutoContinueEntry = (props) => react_jsx_runtime.jsx(AutoContinue, {
				...props,
				sessions,
			});
			ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id: "continue-on-limit",
				priority: 10,
			}, AutoContinueEntry));
		}
		//#endregion
		exports.CONFIG_DEFAULTS = CONFIG_DEFAULTS;
		exports.CONTINUE_MAX_TOKENS_KIND = CONTINUE_MAX_TOKENS_KIND;
		exports.loadConfig = loadConfig;
		exports.collectNoticeCandidates = collectNoticeCandidates;
		exports.evaluate = evaluate;
		exports.evaluateReset = evaluateReset;
		exports.AutoContinue = AutoContinue;
		exports.apply = apply;
		exports.inject = inject;
	return module.exports;
	}
});
