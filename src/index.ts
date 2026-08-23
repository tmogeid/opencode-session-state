/**
 * Session State Manager — OpenCode Plugin
 *
 * Maintains an intelligent session state to preserve context across
 * compactions, model switches, and long sessions.
 *
 * Hooks used:
 * - chat.message:                          Capture user messages
 * - event:             Session lifecycle + assistant message tracking
 * - experimental.chat.messages.transform: Inject state at payload tail (.1 cache-safety)
 * - experimental.session.compacting:     Preserve context during compaction
 * - experimental.compaction.autocontinue: Control post-compaction auto-continue
 * - tool:              Session_state tool
 *
 * @module session-state-manager
 */

import type { Plugin, PluginInput, PluginOptions } from "@opencode-ai/plugin";
import { resolveConfig, type SsmConfig } from "./config.js";
import { createLogger, setGlobalLogger, getLogger } from "./logger.js";
import { SessionManager } from "./session-manager.js";
import { formatStateAsXml, estimateInjectionTokens } from "./context-injector.js";
import { createSessionStateTool } from "./tools/session-state.js";
import {
	appendTaggedSyntheticPart,
	appendTrailingVolatileMessage,
	stripTaggedContent,
	// @ts-ignore — módulo JS externo sin tipos (.1 cache-safety, D1)
} from "./cache-safe-injection.js";
import { join } from "node:path";

// ─── Plugin Default Export ──────────────────────────────────────────────────

const PLUGIN_NAME = "SessionStateManager";

const plugin: Plugin = async (ctx: PluginInput, options?: PluginOptions) => {
	// ── 1. Initialize configuration ─────────────────────────────────────────
	const config: SsmConfig = resolveConfig(options as Record<string, unknown> | undefined);

	// ── 2. Initialize logger (file-based + toast for errors) ───────────────
	const logDir = join(ctx.directory, ".session-state", "logs");
	const logDate = new Date().toISOString().slice(0, 10);
	const logFilePath = join(logDir, `${logDate}.log`);
	const log = createLogger({
		level: (config.logging ?? "warn") as "debug" | "info" | "warn" | "error",
		logFilePath,
		showWarnings: !!config.logging && config.logging !== "off",
		showToast: ctx.client?.tui?.showToast
			? (msg: string, variant: "error" | "warning") =>
					ctx.client.tui.showToast({
						body: { message: `[SSM] ${msg}`, variant },
					})
			: undefined,
	});
	setGlobalLogger(log);
	log.info(`SessionStateManager v1.1.4 (big-pickle default + json-repair) initializing...`);
	log.info(`Project: ${ctx.directory}`);

	// ── 3. Initialize session manager ───────────────────────────────────────
	const sessionManager = new SessionManager(config, ctx.directory);

	// ── 4. Register tool(s) ────────────────────────────────────────────────
	const sessionStateTool = createSessionStateTool(sessionManager, ctx.directory);

	// ── 5. Return hooks ────────────────────────────────────────────────────
	return {
		/**
		 * Register the session_state tool so the AI can inspect session state.
		 */
		tool: {
			session_state: sessionStateTool,
		},

		/**
		 * chat.message hook — captures user messages.
		 * This is the primary way to detect user input, providing sessionID directly.
		 */
		async "chat.message"(input, output) {
			try {
				const sessionId = input.sessionID;
				if (!sessionId) return;

				// Ensure session exists
				await sessionManager.getOrCreate(sessionId);

				// Extract text from message parts — safe at runtime
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				const text = (output.parts as any[])
					.filter((p: { type: string }) => p.type === "text" || p.type === "tool_result")
					.map((p: { text?: string }) => p.text ?? "")
					.join("\n")
					.trim();

				if (text) {
					await sessionManager.processUserMessage(sessionId, text);
					log.debug(`User message via chat.message: ${sessionId}`);
				}
			} catch (err) {
				getLogger().error(
					`chat.message hook error: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},

		/**
		 * Event hook — captures session lifecycle and assistant message tracking.
		 *
		 * Events handled:
		 * - session.created → initialize session state
		 * - session.deleted → persist final state (no deletion)
		 * - session.idle    → flush state to disk
		 * - message.updated (assistant) → process assistant response
		 */
		async event(input) {
			try {
				const event = input.event as {
					type: string;
					properties?: Record<string, unknown>;
				};

				const eventType = event.type;

				// Extract session ID based on event type
				let sessionId: string | undefined;
				if (event.properties?.info && typeof event.properties.info === "object") {
					const info = event.properties.info as Record<string, unknown>;
					if (typeof info.sessionID === "string") {
						sessionId = info.sessionID as string;
					} else if (typeof info.id === "string") {
						sessionId = info.id as string;
					}
				}
				if (!sessionId && typeof event.properties?.sessionID === "string") {
					sessionId = event.properties.sessionID as string;
				}

				if (!sessionId) return;

				switch (eventType) {
					case "session.created": {
						await sessionManager.getOrCreate(sessionId);
						log.info(`Session created: ${sessionId}`);
						break;
					}

					case "session.deleted": {
						// Persist state (don't delete — archive)
						const state = sessionManager.getCachedState(sessionId);
						if (state) {
							await sessionManager.persist(sessionId, state);
							log.info(`Session archived: ${sessionId}`);
						}
						break;
					}

					case "session.idle": {
						// Flush to disk on idle
						const state = sessionManager.getCachedState(sessionId);
						if (state) {
							await sessionManager.persist(sessionId, state);
							log.debug(`Session flushed on idle: ${sessionId}`);
						}
						break;
					}

					case "message.updated": {
						const info = event.properties?.info as Record<string, unknown> | undefined;
						const role = info?.role as string | undefined;
						const text = extractMessageText(event);

						if (role === "assistant" && text) {
							await sessionManager.processAssistantResponse(sessionId, text);

							// Log token usage if available
							if (info?.tokens && typeof info.tokens === "object") {
								const tokens = info.tokens as Record<string, number>;
								log.debug(
									`Assistant response — ` +
										`input: ${tokens.input ?? "?"} ` +
										`output: ${tokens.output ?? "?"} ` +
										`cost: ${info?.cost ?? "?"}`,
								);
							}
						}
						break;
					}
				}
			} catch (err) {
				getLogger().error(`event hook error: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
		// DEPRECATED .1 cache-safety — experimental.chat.system.transform eliminado.
		// Inyectaba el estado en output.system (cabecera del payload: tools →
		// system → messages) y bustaba el byte-prefix del prompt-cache en cada
		// turno, porque el XML cambia. Reemplazado por messages.transform, que
		// inyecta en el tail del payload vía cache-safe-injection.js.
		// Código anterior (fallback si messages.transform no está disponible):
		// async "experimental.chat.system.transform"(input, output) {
		// 	if (!config.injectionEnabled) return;
		// 	try {
		// 		const sessionId = input.sessionID;
		// 		if (!sessionId) return;
		// 		const state = sessionManager.getCachedState(sessionId);
		// 		if (!state) return;
		// 		const xml = formatStateAsXml(state);
		// 		if (!xml) return;
		// 		output.system.push(xml);
		// 		const estTokens = estimateInjectionTokens(xml);
		// 		log.debug(
		// 			`State injected into system prompt — ` +
		// 				`~${estTokens} tokens, ${xml.length} chars`,
		// 		);
		// 	} catch (err) {
		// 		getLogger().error(
		// 			`system.transform hook error: ${err instanceof Error ? err.message : String(err)}`,
		// 		);
		// 	}
		// },

		/**
		 * Injects the current session state at the TAIL of the outgoing
		 * payload before every LLM call (.1 cache-safety).
		 *
		 * Replaces the legacy system.transform injection: mutating the system
		 * prompt busted the provider byte-prefix cache every turn, because the
		 * state XML changes. This hook appends deterministic content at the
		 * tail of an existing user message, or as a trailing synthetic message
		 * when the payload ends in an assistant message, so cache churn only
		 * ever touches the end of the prompt. Fully automatic, zero user
		 * intervention; never persists the synthetic message (render-time only).
		 */
		async "experimental.chat.messages.transform"(_input, output) {
			if (!config.injectionEnabled) return;

			try {
				const messages = output && Array.isArray(output.messages) ? output.messages : null;
				if (!messages || messages.length === 0) return;

				const sessionId = findSessionIdInMessages(messages);
				if (!sessionId) return;

				const state = sessionManager.getCachedState(sessionId);
				if (!state) return;

				const xml = formatStateAsXml(state);
				if (!xml) return;

				// Metadata key estable para dedupe: quitar y re-appendrear
				// cualquier inyección previa antes de insertar la actual.
				const KEY = "session-state-injected";
				stripTaggedContent(messages, KEY);

				const lastMessage = messages[messages.length - 1];
				const lastRole = lastMessage?.info?.role;
				if (lastRole === "user") {
					appendTaggedSyntheticPart(lastMessage, {
						text: xml,
						metadataKey: KEY,
					});
				} else {
					appendTrailingVolatileMessage(
						messages,
						{ role: "user", sessionID: sessionId },
						{ text: xml, metadataKey: KEY },
					);
				}

				const estTokens = estimateInjectionTokens(xml);
				log.debug(
					`State injected at payload tail — ` + `~${estTokens} tokens, ${xml.length} chars`,
				);
			} catch (err) {
				getLogger().error(
					`messages.transform hook error: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},

		/**
		 * Preserves session state context during compaction.
		 * Ensures the compaction summary includes our session state.
		 */
		async "experimental.session.compacting"(input, output) {
			try {
				const sessionId = input.sessionID;
				if (!sessionId) return;

				const state = sessionManager.getCachedState(sessionId);
				if (!state) return;

				// Add a snapshot of the current state to the compaction context
				const contextXml = formatStateAsXml(state);
				if (contextXml) {
					output.context.push(
						`[Session State Manager — preserve this state in the compaction summary]\n${contextXml}`,
					);
					log.info(`Session state added to compaction context: ${sessionId}`);
				}
			} catch (err) {
				getLogger().error(
					`session.compacting hook error: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},

		/**
		 * Ensures auto-continue works after compaction (default behavior).
		 * Keeps the session flowing after compaction completes.
		 */
		async "experimental.compaction.autocontinue"(_input, output) {
			// Default is enabled=true; we leave it as-is to maintain flow.
			// Do not disable — the state preservation via compacting hook
			// already ensures context is maintained.
			output.enabled = true;
		},
	};
};

// Export default for OpenCode plugin loader
export default plugin;

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Extracts message text from an event object.
 * Handles different event structures across OpenCode versions.
 */
function extractMessageText(event: {
	type: string;
	properties?: Record<string, unknown>;
}): string | null {
	try {
		const props = event.properties;
		if (!props) return null;

		// Try direct text field
		if (typeof props.text === "string" && props.text.trim()) {
			return props.text.trim();
		}

		// Try info.message.text
		const info = props.info as Record<string, unknown> | undefined;
		if (info?.message && typeof info.message === "object") {
			const msg = info.message as Record<string, unknown>;
			if (typeof msg.text === "string" && msg.text.trim()) {
				return msg.text.trim();
			}
			// Handle parts format
			if (Array.isArray(msg.parts)) {
				return extractTextFromParts(msg.parts);
			}
		}

		// Try parts directly
		if (Array.isArray(props.parts)) {
			return extractTextFromParts(props.parts as Array<Record<string, unknown>>);
		}

		return null;
	} catch {
		return null;
	}
}

/**
 * Extracts text from an array of message parts (OpenCode message format).
 */
function extractTextFromParts(parts: Array<Record<string, unknown>>): string | null {
	const textParts = parts
		.filter((p) => p.type === "text" || p.type === "tool_result")
		.map((p) => {
			if (typeof p.text === "string") return p.text;
			return "";
		})
		.filter((t) => t.length > 0);

	return textParts.length > 0 ? textParts.join("\n").trim() : null;
}

/**
 * Extracts the session ID from the first message that carries one.
 * The messages.transform hook input has no sessionID field, so the
 * session is derived from the message info objects.
 */
function findSessionIdInMessages(
	messages: Array<{ info?: { sessionID?: string } }>,
): string | null {
	for (const message of messages) {
		const sessionID = message?.info?.sessionID;
		if (typeof sessionID === "string" && sessionID) return sessionID;
	}
	return null;
}

/**
 * Cleanup handler for plugin teardown.
 * Flushes all pending state to disk.
 */
async function cleanup(sessionManager: SessionManager): Promise<void> {
	const log = getLogger();
	log.info("Plugin shutting down — flushing sessions...");
	// Note: we can't iterate private sessions map here, but the
	// session.idle event should handle this. For extra safety,
	// the dispose hook would ideally call this, but we don't have
	// access to the sessionManager outside the factory function scope.
}
