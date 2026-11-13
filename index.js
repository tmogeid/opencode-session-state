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

const PLUGIN_VERSION = "2.0.1";
const INJECT_METADATA_KEY = "session-state-injected";

/** Session ID carried by a raw stream event (verified shapes). */
function extractSessionId(ev) {
  if (typeof ev?.data?.sessionID === "string" && ev.data.sessionID)
    return ev.data.sessionID;
  if (typeof ev?.data?.info?.id === "string" && ev.data.info.id)
    return ev.data.info.id;
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
              : Array.isArray(event.prompt?.parts)
                ? event.prompt.parts
                    .filter((part) => part?.type === "text")
                    .map((part) => part.text ?? "")
                    .join(String.fromCharCode(10))
                    .trim()
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

    // ── 5. Inject persistent state through the v2 context system parts ──
    // Never fabricate a user message: that could be mistaken for a new goal.
    const injectionMarker = "[session-state-manager:trusted-state]";
    registrations.push(
      await ctx.session.hook("context", async (event) => {
        if (!config.injectionEnabled) return;
        try {
          const sessionId = event.sessionID;
          if (!sessionId) return;
          const state =
            sessionManager.getCachedState(sessionId) ??
            (await sessionManager.getOrCreate(sessionId));
          const xml = formatStateAsXml(state);
          if (!xml) return;
          // v2.2.0 messages use provider-native content; inject stable system
          // context rather than fabricating a user turn that could change topic.
          for (let i = event.system.length - 1; i >= 0; i--) {
            const part = event.system[i];
            if (
              part?.type === "text" &&
              typeof part.text === "string" &&
              part.text.startsWith(injectionMarker)
            )
              event.system.splice(i, 1);
          }
          event.system.push({
            type: "text",
            text: `${injectionMarker} ${xml}`,
          });
          log.debug(
            `State injected into system context — ~${estimateInjectionTokens(xml)} tokens`,
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
          const state =
            sessionManager.getCachedState(sessionId) ??
            (await sessionManager.getOrCreate(sessionId));
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
          const sessionId = extractSessionId(ev) ?? ev?.data?.sessionID;
          if (!type || !sessionId) continue;
          if (type === "session.text.ended" && ev?.data?.text) {
            try {
              await sessionManager.processAssistantResponse(
                sessionId,
                ev.data.text,
              );
            } catch (err) {
              hookError("assistant-text", err);
            }
          }
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
