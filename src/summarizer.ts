/**
 * Summarizer — calls an external LLM to incrementally update the session state.
 *
 * Principles:
 * - INCREMENTAL: previous state + new turn → updated state (never re-summarize everything)
 * - THROTTLED: max one call per config.summarizerInterval (default 30s)
 * - ASYNC: never blocks the main thread
 * - FALLBACK: if the LLM call fails, returns null (caller continues with heuristic state)
 */

import type { SsmConfig } from "./config.js";
import type { SessionState } from "./state-store.js";
import { getLogger } from "./logger.js";

export interface TurnData {
	role: "user" | "assistant";
	text: string;
}

/**
 * Global serial queue for LLM calls — prevents concurrent summarizer requests
 * to the same provider/API key. Each call waits for the previous one to finish.
 */
let llmQueue: Promise<void> = Promise.resolve();

/**
 * Wraps callLLM() inside a serial queue so summarizer calls from different
 * sessions never run in parallel. This avoids rate-limit collisions and
 * ensures predictable load on the LLM provider.
 */
async function callLLMWithQueue(
	systemPrompt: string,
	userPrompt: string,
	config: SsmConfig,
): Promise<string | null> {
	// Capturar la promesa anterior y crear la siguiente en la cadena
	const waitForTurn = llmQueue;
	let releaseNext!: () => void;
	llmQueue = new Promise<void>((r) => {
		releaseNext = r;
	});

	// Esperar a que termine la llamada anterior
	await waitForTurn;

	try {
		return await callLLM(systemPrompt, userPrompt, config);
	} finally {
		// Liberar la siguiente llamada en la cola
		releaseNext();
	}
}

/**
 * Attempts an incremental update of the session state using an LLM.
 *
 * @param prevState - The current session state before this turn
 * @param newTurns - The new user + assistant messages since last summarization
 * @param config - Plugin configuration
 * @returns Updated session state, or null if the call was skipped or failed
 */
export async function incrementalSummarize(
	prevState: SessionState,
	newTurns: TurnData[],
	config: SsmConfig,
): Promise<Partial<SessionState> | null> {
	const log = getLogger();

	// Guard: nothing to summarize
	if (newTurns.length === 0) return null;

	// Guard: trivial messages (greetings, single words)
	const allText = newTurns.map((t) => t.text).join(" ");
	if (allText.length < 30) return null;

	// Build the system prompt for the summarizer LLM
	const systemPrompt = buildSummarizerSystemPrompt(config);

	// Build the user message with previous state + new turns
	const userPrompt = buildIncrementalPrompt(prevState, newTurns);

	// Call the LLM with retry on JSON parse failure
	try {
		let result = await callLLMWithQueue(systemPrompt, userPrompt, config);
		if (!result) return null;

		// Parse and validate the LLM response
		let updated = parseLLMResponse(result, prevState, config);

		// If parse failed (returned {} with no fields), retry once
		if (Object.keys(updated).length === 0 && result.trim() !== "{}") {
			log.debug("First LLM parse failed, retrying once...");
			result = await callLLMWithQueue(systemPrompt, userPrompt, config);
			if (result) {
				updated = parseLLMResponse(result, prevState, config);
			}
		}

		log.info(
			`Summarizer update applied — ` +
				`episodes=${updated.episodes?.length ?? prevState.episodes.length} ` +
				`decisions=${updated.decisions?.length ?? prevState.decisions.length}`,
		);
		return updated;
	} catch (err) {
		log.warn(`Summarizer LLM call failed: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	}
}

/**
 * Builds the system prompt for the summarizer LLM.
 * Instructs the model to do incremental, structured updates.
 */
function buildSummarizerSystemPrompt(config: SsmConfig): string {
	return `Eres un extractor de estado de sesión para OpenCode. Tu función es ÚNICAMENTE ACTUALIZAR un estado existente basándote en NUEVOS mensajes — NUNCA resumas la conversación completa.

## REGLAS ESTRICTAS

1. **INCREMENTAL**: Toma el estado anterior y SOLO añade/cambia lo que los nuevos mensajes modifican. Conserva TODO lo demás intacto. **EXCEPCIÓN**: Si detectas entradas claramente incorrectas en el estado anterior (nombres de tecnologías como "Node.js" en importantFiles, duplicados, formato inválido, rutas que no son archivos), corrígelas automáticamente aunque los nuevos mensajes no las mencionen.
2. **NO RESUMAS**: No repitas información que ya está en el estado anterior.
3. **DETECTA TEMAS**: Si los nuevos mensajes indican un cambio de tema, crea un nuevo episodio.
4. **SÉ CONCRETO**: Extrae solo información relevante (decisiones, tareas, archivos, errores, riesgos, pasos siguientes).
5. **IGNORA RUIDO**: Omite saludos, despedidas, tool output, logs, terminal output, diffs grandes y conversación trivial.
6. **MÁXIMO ${config.maxEpisodes} EPISODIOS**: Si hay más episodios comprime los antiguos eliminando detalles no esenciales.

## FORMATO DE RESPUESTA

Responde ÚNICAMENTE con un objeto JSON válido. NUNCA incluyas markdown, explicaciones o texto fuera del JSON.

El JSON debe contener SOLO los campos que CAMBIARON respecto al estado anterior. Campos no incluidos = no cambiaron.

Campos posibles:
- currentTask (string)
- currentObjective (string)
- mainTopic (string)
- decisions (array de {text: string, episode: string, timestamp: string})
- pendingTasks (array de {text: string, episode: string})
- importantFiles (array de {path: string, reason: string, episode: string})
- knownErrors (array de {error: string, context: string, episode: string})
- risks (array de {text: string, mitigation: string, episode: string})
- nextSteps (array de {text: string, episode: string})
- conclusions (array de {text: string, episode: string})
- episodes (array completo de episodios — solo si cambia)
- activeEpisodeId (string — solo si cambia)`;
}

/**
 * Builds the incremental user prompt with previous state + new turns.
 */
function buildIncrementalPrompt(prevState: SessionState, newTurns: TurnData[]): string {
	const turnsText = newTurns
		.map((t) => `<${t.role}>\n${cleanContent(t.text)}\n</${t.role}>`)
		.join("\n\n");

	return `## Estado Anterior (NO modificar a menos que los nuevos mensajes lo contradigan)

\`\`\`json
${JSON.stringify(prevState, null, 2)}
\`\`\`

## Nuevos Mensajes (SOLO esto debe procesarse)

${turnsText}

## Instrucción

Actualiza el JSON del estado anterior con la información de los nuevos mensajes.
Si los nuevos mensajes no contienen información relevante, responde con un objeto JSON vacío: {}

Responde SOLO con JSON.`;
}

/**
 * Cleans message content by removing common noise.
 */
function cleanContent(text: string): string {
	return (
		text
			// Remove code blocks (they are too long)
			.replace(/```[\s\S]*?```/g, "[código omitido]")
			// Remove terminal output blocks
			.replace(/`[\s\S]*?`/g, "[output omitido]")
			// Truncate very long lines
			.split("\n")
			.map((line) => (line.length > 200 ? line.slice(0, 200) + "..." : line))
			.join("\n")
			// Limit total length
			.slice(0, 4000)
	);
}

/**
 * Redacts likely secrets from a provider body snippet and caps length.
 */
function redactSnippet(text: string): string {
	return text
		.replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
		.replace(/sk-[A-Za-z0-9-_]+/g, "[redacted]")
		.replace(/(api[_-]?key["'\s:=]+)[^\s"',}]+/gi, "$1[redacted]")
		.slice(0, 300);
}

/**
 * Extracts concatenated delta.content/message.content from SSE payloads.
 * Returns isSSE=true when content-type is event-stream or the body carries
 * SSE framing lines (: / data:). Empty content means no usable text.
 */
function extractSSEContent(
	rawBody: string,
	contentType: string,
): { isSSE: boolean; content: string } {
	const looksSSE =
		contentType.includes("text/event-stream") || /(^|\n)\s*(data:|:\s)/m.test(rawBody);
	if (!looksSSE) return { isSSE: false, content: "" };
	const parts: string[] = [];
	for (const line of rawBody.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith(":")) continue;
		const payload = trimmed.startsWith("data:") ? trimmed.slice(5).trim() : trimmed;
		if (!payload || payload === "[DONE]") continue;
		try {
			const chunk = JSON.parse(payload) as {
				choices?: Array<{
					delta?: { content?: string };
					message?: { content?: string };
				}>;
			};
			const c = chunk.choices?.[0]?.delta?.content ?? chunk.choices?.[0]?.message?.content;
			if (typeof c === "string" && c) parts.push(c);
		} catch {
			// Non-JSON SSE payload — ignore.
		}
	}
	return { isSSE: true, content: parts.join("").trim() };
}

/**
 * Calls the LLM API (OpenAI-compatible) and returns response text.
 * Works with any body (normal, md or json): prefers choices[0].message.content
 * when present, else falls back to the trimmed rawBody. Only null on total
 * empty or non-OK without body. Never throws on parse.
 */
async function callLLM(
	systemPrompt: string,
	userPrompt: string,
	config: SsmConfig,
): Promise<string | null> {
	const log = getLogger();
	const apiKey = config.apiKey;
	if (!apiKey) return null;

	const url = `${config.apiBaseUrl.replace(/\/+$/, "")}/chat/completions`;

	const body: Record<string, unknown> = {
		model: config.model,
		messages: [
			{ role: "system", content: systemPrompt },
			{ role: "user", content: userPrompt },
		],
		temperature: config.temperature,
		max_tokens: config.maxTokens,
		stream: false,
		response_format: { type: "json_object" },
	};

	// Try JSON mode if the model supports it
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(config.timeout),
	});

	const rawBody = await response.text().catch(() => "");
	const snippet = redactSnippet(rawBody);
	const contentType = response.headers.get("content-type") ?? "";

	if (!response.ok) {
		if (!rawBody.trim()) {
			log.info(
				`Summarizer provider non-OK ${response.status} (${contentType || "unknown content-type"}): ${snippet}`,
			);
			return null;
		}
		if (contentType.includes("json")) {
			try {
				const errData = JSON.parse(rawBody) as {
					choices?: Array<{ message?: { content?: string } }>;
				};
				const errContent = errData.choices?.[0]?.message?.content?.trim();
				if (errContent) return errContent;
			} catch {
				// Fall through to raw text below.
			}
		}
		log.info(
			`Summarizer provider non-OK ${response.status} (${contentType || "unknown content-type"}), using raw text: ${snippet}`,
		);
		return rawBody.trim();
	}

	if (!rawBody.trim()) {
		log.info(`Summarizer provider empty body (${contentType || "unknown content-type"})`);
		return null;
	}

	const sse = extractSSEContent(rawBody, contentType);
	if (sse.isSSE) {
		if (sse.content) {
			log.info(
				`Summarizer provider SSE body (${contentType || "unknown content-type"}), extracted delta content`,
			);
			return sse.content;
		}
		log.info(
			`Summarizer provider SSE without usable content (${contentType || "unknown content-type"}): ${snippet}`,
		);
		return null;
	}

	try {
		const data = JSON.parse(rawBody) as {
			choices?: Array<{ message?: { content?: string } }>;
		};
		const content = data.choices?.[0]?.message?.content?.trim();
		if (content) return content;
	} catch {
		// Not JSON — fall through to raw text below.
	}
	const text = rawBody.trim();
	if (!text) {
		log.info(
			`Summarizer provider empty content (${contentType || "unknown content-type"}): ${snippet}`,
		);
		return null;
	}
	log.info(
		`Summarizer provider non-JSON body (${contentType || "unknown content-type"}), using raw text: ${snippet}`,
	);
	return text;
}

/**
 * Parses the LLM JSON response, merging it with the previous state.
 * Handles partial JSON, malformed responses, and empty updates gracefully.
 */
function parseLLMResponse(
	raw: string,
	prevState: SessionState,
	config: SsmConfig,
): Partial<SessionState> {
	const log = getLogger();

	// Strip markdown code fences if present
	let cleaned = raw
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/i, "")
		.trim();

	// Tolerant: strip SSE framing if raw arrived with event-stream lines.
	const sseInParse = extractSSEContent(raw, "");
	if (sseInParse.isSSE) {
		if (sseInParse.content) {
			cleaned = sseInParse.content;
		} else {
			log.debug("Summarizer SSE without usable JSON, skipping parse");
			return {};
		}
	}

	if (!cleaned || cleaned === "{}") {
		log.debug("Summarizer returned empty update");
		return {};
	}

	// Tolerant: extract first { … last } to drop md/prose wrappers before parse.
	const braceFirst = cleaned.indexOf("{");
	const braceLast = cleaned.lastIndexOf("}");
	const candidate =
		braceFirst >= 0 && braceLast > braceFirst
			? cleaned.slice(braceFirst, braceLast + 1).trim()
			: cleaned;

	// Attempt 1: direct parse
	let parsed: Record<string, unknown> | null = null;
	try {
		parsed = JSON.parse(candidate) as Record<string, unknown>;
	} catch {
		// Attempt 2: auto-repair truncated JSON (missing closing braces/brackets)
		const repaired = autoRepairJSON(candidate);
		if (repaired !== cleaned) {
			try {
				parsed = JSON.parse(repaired) as Record<string, unknown>;
				log.debug("Auto-repaired truncated JSON successfully");
			} catch {
				// Repair didn't help
			}
		}
	}

	if (!parsed) {
		log.warn("Failed to parse summarizer JSON response after retry");
		return {};
	}

	// Validate that we got an object
	if (typeof parsed !== "object" || parsed === null) {
		log.warn("Summarizer returned non-object response");
		return {};
	}

	// Merge episodes if present, with max episode enforcement
	if (parsed.episodes && Array.isArray(parsed.episodes)) {
		// Cap episodes at maxEpisodes
		if (parsed.episodes.length > config.maxEpisodes) {
			const sorted = parsed.episodes.sort(
				(a: { priority?: number }, b: { priority?: number }) =>
					(b.priority ?? 0) - (a.priority ?? 0),
			);
			parsed.episodes = sorted.slice(0, config.maxEpisodes);
		}
	}

	return parsed as Partial<SessionState>;
}

/**
 * Attempts to repair truncated JSON by closing unmatched braces and brackets.
 */
function autoRepairJSON(text: string): string {
	// Count unmatched open braces and brackets
	let braces = 0;
	let brackets = 0;
	let inString = false;
	let isEscaping = false;

	for (const ch of text) {
		if (isEscaping) {
			isEscaping = false;
			continue;
		}
		if (ch === "\\") {
			isEscaping = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (inString) continue;
		if (ch === "{") braces++;
		if (ch === "}") braces--;
		if (ch === "[") brackets++;
		if (ch === "]") brackets--;
	}

	// Remove trailing incomplete key/value (e.g. "..., "key": "val")
	let repaired = text.replace(/,\s*"[^"]*"\s*:\s*"?[^"]*$/, "");

	// Close any unclosed string
	if (inString) repaired += '"';

	// Close brackets first, then braces
	while (brackets > 0) {
		repaired += "]";
		brackets--;
	}
	while (braces > 0) {
		repaired += "}";
		braces--;
	}

	return repaired;
}
