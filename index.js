/**
 * Session State Manager — OpenCode plugin v2 entrypoint (directory package).
 *
 * Migration v1 -> v2 of the original plugin (v1.1.5). The compiled,
 * self-contained modules under dist/ are reused unchanged; this file only
 * translates the v1 hook surface to the v2 contract {id, setup(ctx)}.
 *
 * Hook mapping (verified against the v2 oracle plugins-local/opencode-mempalace-v2/index.js):
 *   tool: {session_state}                -> ctx.tool.transform (editor.add)
 *   chat.message                         -> ctx.session.hook("prompt")
 *   experimental.chat.messages.transform -> ctx.session.hook("context") mutating event.messages
 *   experimental.session.compacting      -> ctx.session.hook("compaction") (event.system.push)
 *   event (session.created/deleted/idle) -> ctx.event.subscribe stream + AbortController
 *
 * Accepted degradations (no v2 equivalent surface):
 *   - experimental.compaction.autocontinue omitted (runtime default applies).
 *   - message.updated (assistant-response capture) omitted: not in the v2 event manifest.
 *   - prompt hook exposes text only (no output.parts / tool_result parts).
 *   - client.tui.showToast degraded to console.warn (v2 has no ctx.client).
 */

import { define } from "@opencode-ai/plugin/v2/promise";
import { join, resolve } from "node:path";
import { resolveConfig } from "./dist/config.js";
import { createLogger, setGlobalLogger, getLogger } from "./dist/logger.js";
import { SessionManager } from "./dist/session-manager.js";
import {
  formatStateAsXml,
  estimateInjectionTokens,
} from "./dist/context-injector.js";
import { createSessionStateTool } from "./dist/tools/session-state.js";

const PLUGIN_VERSION = "2.0.0";
const INJECT_METADATA_KEY = "session-state-injected";

/** Session ID carried by a raw stream event (verified shapes). */
function extractSessionId(ev) {
  const props = ev?.properties;
  if (!props || typeof props !== "object") return undefined;
  if (typeof props.sessionID === "string" && props.sessionID)
    return props.sessionID;
  const info = props.info;
  if (info && typeof info === "object") {
    if (typeof info.sessionID === "string" && info.sessionID)
      return info.sessionID;
    if (typeof info.id === "string" && info.id) return info.id;
  }
  return undefined;
}

export default define({
  id: "session-state-manager",
  async setup(ctx) {
    // ── 1. Configuration: options come from the plural `plugins` entry ──
    const config = resolveConfig(ctx.options ?? {});

    // ── 2. Logger: file-based; toast degraded to console.warn ────────────
    const directory = resolve(
      (ctx.location?.directory ?? ctx.directory) || process.cwd(),
    );
    const logDate = new Date().toISOString().slice(0, 10);
    const log = createLogger({
      level: config.logging ?? "warn",
      logFilePath: join(directory, ".session-state", "logs", `${logDate}.log`),
      showWarnings: !!config.logging && config.logging !== "off",
      showToast: (message, variant) =>
        console.warn(`[SSM][${variant}] ${message}`),
    });
    setGlobalLogger(log);
    log.info(
      `SessionStateManager v${PLUGIN_VERSION} (v2 entrypoint) initializing...`,
    );
    log.info(`Project: ${directory}`);

    // ── 3. Core services (compiled v1 modules, reused unchanged) ─────────
    const sessionManager = new SessionManager(config, directory);
    const sessionStateTool = createSessionStateTool(sessionManager, directory);

    const hookError = (hook, err) =>
      getLogger().error(
        `${hook} hook error: ${err instanceof Error ? err.message : String(err)}`,
      );

    const registrations = [];

    // ── 4. chat.message → session.hook("prompt") ─────────────────────────
    registrations.push(
      await ctx.session.hook("prompt", async (event) => {
        try {
          const sessionId = event.sessionID;
          if (!sessionId) return;
          await sessionManager.getOrCreate(sessionId);
          const text =
            typeof event.prompt?.text === "string"
              ? event.prompt.text.trim()
              : "";
          if (text) {
            await sessionManager.processUserMessage(sessionId, text);
            log.debug(`User message via prompt hook: ${sessionId}`);
          }
        } catch (err) {
          hookError("prompt", err);
        }
      }),
    );

    // ── 5. messages.transform → session.hook("context") ───────────────────
    // Injects the state at the TAIL of event.messages so cache churn only
    // ever touches the end of the payload. v2 Message shape (verified):
    // { role, content: [{ type: "text", text, metadata? }] }. The v1 helper
    // cache-safe-injection.js targets the v1 {info, parts} shape, so the
    // tag/strip/append semantics are re-expressed here for the v2 shape.
    const injectedPart = (text) => ({
      type: "text",
      text,
      metadata: { [INJECT_METADATA_KEY]: true },
    });
    const stripInjected = (messages) => {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (!message || !Array.isArray(message.content)) continue;
        const hadParts = message.content.length > 0;
        message.content = message.content.filter(
          (part) =>
            !(
              part &&
              typeof part === "object" &&
              part.metadata?.[INJECT_METADATA_KEY] === true
            ),
        );
        if (hadParts && message.content.length === 0) messages.splice(i, 1);
      }
    };
    registrations.push(
      await ctx.session.hook("context", async (event) => {
        if (!config.injectionEnabled) return;
        try {
          const messages =
            event && Array.isArray(event.messages) ? event.messages : null;
          if (!messages || messages.length === 0) return;
          const sessionId = event.sessionID;
          if (!sessionId) return;
          const state = sessionManager.getCachedState(sessionId);
          if (!state) return;
          const xml = formatStateAsXml(state);
          if (!xml) return;
          // Dedupe: strip any previous injection before re-appending.
          stripInjected(messages);
          const lastMessage = messages[messages.length - 1];
          if (
            lastMessage &&
            lastMessage.role === "user" &&
            Array.isArray(lastMessage.content)
          ) {
            lastMessage.content.push(injectedPart(xml));
          } else {
            messages.push({ role: "user", content: [injectedPart(xml)] });
          }
          const estTokens = estimateInjectionTokens(xml);
          log.debug(
            `State injected at payload tail — ~${estTokens} tokens, ${xml.length} chars`,
          );
        } catch (err) {
          hookError("context", err);
        }
      }),
    );

    // ── 6. session.compacting → session.hook("compaction") ───────────────
    registrations.push(
      await ctx.session.hook("compaction", async (event) => {
        try {
          const sessionId = event.sessionID;
          if (!sessionId) return;
          const state = sessionManager.getCachedState(sessionId);
          if (!state) return;
          const contextXml = formatStateAsXml(state);
          if (contextXml) {
            event.system.push({
              type: "text",
              text: `[Session State Manager — preserve this state in the compaction summary]\n${contextXml}`,
            });
            log.info(`Session state added to compaction context: ${sessionId}`);
          }
        } catch (err) {
          hookError("compaction", err);
        }
      }),
    );

    // ── 7. Tool registration: v1 {description, args, execute} → v2 Info ──
    registrations.push(
      await ctx.tool.transform((editor) => {
        editor.add({
          name: "session_state",
          description: sessionStateTool.description,
          input: {
            type: "object",
            properties: {
              action: {
                type: "string",
                description:
                  "Acción: 'ver' (estado completo, default), 'resumen' (episodio activo), 'episodios' (lista), 'limpiar' (archivadas >30d)",
              },
            },
            additionalProperties: false,
          },
          execute: async (args, context) => {
            const result = await sessionStateTool.execute(args ?? {}, context);
            const text =
              typeof result === "string"
                ? result
                : String(result?.output ?? "");
            return { content: [{ type: "text", text }] };
          },
        });
      }),
    );

    // ── 8. Raw event stream: session.created / deleted / idle ─────────────
    const eventAbort = new AbortController();
    (async () => {
      try {
        const stream = ctx.event.subscribe({ signal: eventAbort.signal });
        for await (const raw of stream) {
          if (eventAbort.signal.aborted) break;
          const ev = raw?.event ?? raw;
          const type = ev?.type;
          const sessionId = extractSessionId(ev);
          if (!type || !sessionId) continue;
          try {
            switch (type) {
              case "session.created": {
                await sessionManager.getOrCreate(sessionId);
                log.info(`Session created: ${sessionId}`);
                break;
              }
              case "session.deleted": {
                const state = sessionManager.getCachedState(sessionId);
                if (state) {
                  await sessionManager.persist(sessionId, state);
                  log.info(`Session archived: ${sessionId}`);
                }
                break;
              }
              case "session.idle": {
                const state = sessionManager.getCachedState(sessionId);
                if (state) {
                  await sessionManager.persist(sessionId, state);
                  log.debug(`Session flushed on idle: ${sessionId}`);
                }
                break;
              }
            }
          } catch (err) {
            hookError("event", err);
          }
        }
      } catch (err) {
        if (!eventAbort.signal.aborted) {
          getLogger().error(
            `event subscription error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    })();

    // ── 9. Cleanup: stop the stream and dispose every registration ──────
    return async () => {
      eventAbort.abort();
      await Promise.allSettled(registrations.map((r) => r.dispose()));
      getLogger().info(
        "SessionStateManager shutting down — registrations disposed",
      );
    };
  },
});
