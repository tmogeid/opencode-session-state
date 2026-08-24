/**
 * SessionManager — core orchestrator for session state lifecycle.
 *
 * Responsibilities:
 * - Get or create session state for any sessionId
 * - Process user messages and assistant responses
 * - Detect topic changes and manage episodes
 * - Trigger incremental summarization via LLM
 * - Maintain an in-memory cache with LRU eviction
 * - Persist state to disk after each meaningful update
 */

import type { SsmConfig } from "./config.js";
import { StateStore, type SessionState, createEmptyState } from "./state-store.js";
import { detectTopicChange, applyTopicChange, compressOldEpisodes } from "./episode-detector.js";
import { incrementalSummarize, type TurnData } from "./summarizer.js";
import { getLogger } from "./logger.js";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_LIVE_SESSIONS = 24;

/** Maximum turns to process in a single summarizer call. Extra turns carry over to the next cycle. */
const MAX_TURNS_PER_SUMMARY = 8;

/** Technology/product names that look like files but aren't */
const TECH_EXCLUSIONS =
	/^(Node|React|Vue|Angular|Next|Nuxt|Vite|Astro|Svelte|Solid|Bun|Deno|Express|Koa|Fastify|jQuery|Lodash|Axios|TypeScript|JavaScript|ESLint|Prettier|Webpack|Rollup|Turbopack|PostCSS|Babel|Tailwind|Prisma|Supabase|Firebase|Docker|Kubernetes|Terraform|Ansible|Webpack|Vitest|Jest|Mocha|Cypress|Playwright|Storybook|Chromatic|Stripe|GraphQL|Apollo|Relay|Redux|Zustand|Jotai|XState|Zod|Yup)\.\w+$/i;

/**
 * Metadata tracked per live session in memory.
 */
interface LiveSession {
	/** Session state (shared with disk) */
	state: SessionState;
	/** Pending user messages since last summarizer call */
	pendingTurns: TurnData[];
	/** Timestamp of the last summarizer call */
	lastSummarizerCall: number;
	/** Number of user messages processed */
	messageCount: number;
	/** When the session was first seen */
	createdAt: number;
	/** mtimeMs of the disk file at the last read */
	lastMtimeMs: number;
}

/**
 * SessionManager handles all session state operations.
 * One instance per plugin lifetime.
 */
export class SessionManager {
	private config: SsmConfig;
	private store: StateStore;
	private sessions: Map<string, LiveSession>;
	private projectDir: string;

	constructor(config: SsmConfig, projectDir: string) {
		this.config = config;
		this.projectDir = projectDir;
		this.store = new StateStore(projectDir, config.storageDir);
		this.sessions = new Map();
	}

	/**
	 * Returns the live state for a session, loading from disk or creating if new.
	 * Implements LRU eviction: oldest session is flushed to disk when cache is full.
	 */
	async getOrCreate(sessionId: string): Promise<SessionState> {
		const log = getLogger();

		// Return from cache if available
		const live = this.sessions.get(sessionId);
		if (live) return live.state;

		// Evict oldest if at capacity
		if (this.sessions.size >= MAX_LIVE_SESSIONS) {
			const oldestKey = this.sessions.keys().next().value;
			if (oldestKey !== undefined) {
				const oldestLive = this.sessions.get(oldestKey);
				if (oldestLive) {
					await this.persist(oldestKey, oldestLive.state);
				}
				this.sessions.delete(oldestKey);
				log.debug(`Evicted session: ${oldestKey}`);
			}
		}

		// Load from disk or create new
		const stored = await this.store.read(sessionId);
		const state = stored ?? createEmptyState(sessionId);

		log.info(
			stored
				? `Loaded session: ${sessionId} (${state.episodes.length} episodes)`
				: `Created new session: ${sessionId}`,
		);

		this.sessions.set(sessionId, {
			state,
			pendingTurns: [],
			lastSummarizerCall: 0,
			messageCount: stored ? state.decisions.length : 0,
			createdAt: Date.now(),
			lastMtimeMs: 0,
		});

		return state;
	}

	/**
	 * Processes a new user message: updates state, detects topic changes,
	 * and triggers summarization if needed.
	 */
	async processUserMessage(sessionId: string, text: string): Promise<void> {
		const log = getLogger();
		const live = this.sessions.get(sessionId);
		if (!live) {
			log.warn(`processUserMessage: session not found: ${sessionId}`);
			return;
		}

		live.messageCount++;

		// Skip trivial messages
		const cleanText = text.trim();
		if (cleanText.length < 10) return;

		// Queue for summarizer
		live.pendingTurns.push({ role: "user", text: cleanText });

		const state = live.state;

		// Detect topic change
		const activeEp = state.episodes.find((e) => e.id === state.activeEpisodeId);
		if (activeEp) {
			const detection = detectTopicChange(cleanText, activeEp, state.importantFiles);
			if (detection.detected && detection.confidence >= 0.5) {
				applyTopicChange(state, detection, [cleanText]);
				// Persist immediately on topic change
				await this.persist(sessionId, state);
			}
		}

		// Check if we should trigger the summarizer
		await this.maybeTriggerSummarizer(sessionId, live, state);

		// If summarizer wasn't triggered, persist heuristic updates
		if (live.pendingTurns.length > 0) {
			await this.applyHeuristicUpdates(state, cleanText);
			await this.persist(sessionId, state);
		}
	}

	/**
	 * Processes a new assistant response: captures conclusions and next steps.
	 */
	async processAssistantResponse(sessionId: string, text: string): Promise<void> {
		const live = this.sessions.get(sessionId);
		if (!live) return;

		const cleanText = text.trim();
		if (cleanText.length < 20) return;

		// Queue for summarizer
		live.pendingTurns.push({ role: "assistant", text: cleanText });

		const state = live.state;

		// Heuristic extraction of conclusions and next steps
		this.extractConclusionsFromAssistant(state, cleanText);

		// Check summarizer trigger
		await this.maybeTriggerSummarizer(sessionId, live, state);

		// Persist if summarizer wasn't triggered
		if (live.pendingTurns.length > 0) {
			await this.persist(sessionId, state);
		}
	}

	/**
	 * Returns the current session state, preferring the on-disk state when it
	 * exists. Never serves stale in-memory state over a correct disk file:
	 * stats the disk file on every call (cheap) and only re-reads/parses when
	 * its mtime changed; otherwise the in-memory cache is served.
	 */
	getCachedState(sessionId: string): SessionState | null {
		const live = this.sessions.get(sessionId);
		const diskPath = join(this.projectDir, this.config.storageDir, `${sessionId}.json`);
		try {
			// statSync is cheap; only re-read and parse when the file changed.
			const mtimeMs = statSync(diskPath).mtimeMs;
			if (!live || live.lastMtimeMs !== mtimeMs) {
				const raw = readFileSync(diskPath, "utf-8");
				const diskState = JSON.parse(raw) as SessionState;
				if (diskState && typeof diskState.currentTask === "string") {
					if (live) {
						live.state = diskState;
						live.lastMtimeMs = mtimeMs;
					} else {
						this.sessions.set(sessionId, {
							state: diskState,
							pendingTurns: [],
							lastSummarizerCall: 0,
							messageCount: 0,
							createdAt: Date.now(),
							lastMtimeMs: mtimeMs,
						});
					}
					return diskState;
				}
			}
		} catch {
			// No disk file (or unreadable) — fall through to cache.
			if (live) live.lastMtimeMs = -1; // fuerza re-read si el archivo reaparece
		}
		return live?.state ?? null;
	}

	/**
	 * Returns a list of all session states from disk (for tool display).
	 */
	async getAllStates(): Promise<SessionState[]> {
		// First, flush all live sessions to disk
		for (const [sid, live] of this.sessions) {
			await this.persist(sid, live.state);
		}
		return this.store.listAllStates();
	}

	/**
	 * Persists state to disk (async, fire-and-forget safe).
	 * Guard: never overwrite a correct on-disk state with stale in-memory state.
	 * If the disk state is newer (updatedAt), abort the stale write, reload
	 * from disk, and re-write the disk state.
	 */
	async persist(sessionId: string, state: SessionState): Promise<void> {
		try {
			const diskState = await this.store.read(sessionId);
			// Fallback: if disk is newer than live state, disk was fixed externally.
			const memTime = new Date(state.updatedAt).getTime();
			if (diskState) {
				const diskTime = new Date(diskState.updatedAt).getTime();
				const diskNewer = !Number.isNaN(memTime) && !Number.isNaN(diskTime) && diskTime > memTime;
				if (diskNewer) {
					const log = getLogger();
					const taskPreview = diskState.currentTask.slice(0, 80);
					log.debug(
						`persist: disk has authoritative state for ${sessionId} (currentTask: ${taskPreview}); reloading from disk`,
					);
					const live = this.sessions.get(sessionId);
					if (live) live.state = diskState;
					await this.store.write(sessionId, diskState);
					return;
				}
			}
			await this.store.write(sessionId, state);
		} catch (err) {
			const log = getLogger();
			log.error(
				`Failed to persist session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	/**
	 * Removes archived sessions older than the given number of days.
	 */
	async pruneArchived(days: number): Promise<number> {
		return this.store.pruneOlderThan(days);
	}

	/**
	 * Triggers the LLM summarizer if conditions are met.
	 * Captures a snapshot of pending turns (capped at MAX_TURNS_PER_SUMMARY)
	 * and processes them through the serial LLM queue. Processed turns are
	 * removed from the pending array on success; on failure they remain for retry.
	 */
	private async maybeTriggerSummarizer(
		sessionId: string,
		live: LiveSession,
		state: SessionState,
	): Promise<void> {
		if (!this.config.autoSummary) return;
		if (live.pendingTurns.length === 0) return;

		// Throttle: respect interval
		const now = Date.now();
		if (now - live.lastSummarizerCall < this.config.summarizerInterval) return;

		// Snapshot: copy up to MAX_TURNS_PER_SUMMARY turns (don't remove yet)
		// This prevents batch blowup when many sessions queue up simultaneously
		const turnsSnapshot = live.pendingTurns.slice(0, MAX_TURNS_PER_SUMMARY);

		// Don't trigger on every single message; wait for at least a pair (user + assistant)
		if (turnsSnapshot.length < 2) return;

		const log = getLogger();
		log.debug(
			`Triggering summarizer for session ${sessionId} (${turnsSnapshot.length} of ${live.pendingTurns.length} pending turns)`,
		);

		try {
			const result = await incrementalSummarize(state, turnsSnapshot, this.config);

			if (result) {
				this.mergeStateUpdate(state, result);

				// Enforce max state tokens
				if (this.config.maxStateTokens > 0) {
					const stateStr = JSON.stringify(state);
					const approxTokens = Math.ceil(stateStr.length / 4);
					if (approxTokens > this.config.maxStateTokens) {
						compressOldEpisodes(state, this.config.maxEpisodes);
						log.info(`State compressed: ${approxTokens} tokens → reduced`);
					}
				}
			}

			// On success: remove processed turns. Remaining turns stay for next cycle.
			live.pendingTurns.splice(0, turnsSnapshot.length);
			live.lastSummarizerCall = now;
			await this.persist(sessionId, state);
		} catch (err) {
			log.warn(`Summarizer error: ${err instanceof Error ? err.message : String(err)}`);
			// Don't clear pending turns on failure — retry next time
		}
	}

	/**
	 * Merges a partial state update from the summarizer into the current state.
	 * Only overwrites fields that are present in the update.
	 */
	private mergeStateUpdate(state: SessionState, update: Partial<SessionState>): void {
		if (typeof update.currentTask === "string") state.currentTask = update.currentTask;
		if (typeof update.currentObjective === "string")
			state.currentObjective = update.currentObjective;
		if (typeof update.mainTopic === "string") state.mainTopic = update.mainTopic;
		if (typeof update.activeEpisodeId === "string") state.activeEpisodeId = update.activeEpisodeId;

		if (Array.isArray(update.decisions)) state.decisions = update.decisions;
		if (Array.isArray(update.pendingTasks)) state.pendingTasks = update.pendingTasks;
		if (Array.isArray(update.importantFiles)) state.importantFiles = update.importantFiles;
		if (Array.isArray(update.knownErrors)) state.knownErrors = update.knownErrors;
		if (Array.isArray(update.risks)) state.risks = update.risks;
		if (Array.isArray(update.nextSteps)) state.nextSteps = update.nextSteps;
		if (Array.isArray(update.conclusions)) state.conclusions = update.conclusions;
		if (Array.isArray(update.episodes)) state.episodes = update.episodes;
	}

	/**
	 * Applies simple heuristic updates to the state without calling the LLM.
	 * This provides basic state management even when the summarizer is unavailable.
	 */
	private async applyHeuristicUpdates(state: SessionState, text: string): Promise<void> {
		const now = new Date().toISOString();
		const activeEp = state.activeEpisodeId;

		// Detect task mention
		const taskMatch = text.match(/tarea\s+(actual|nueva|siguiente):\s*(.+)/i);
		if (taskMatch) {
			state.currentTask = taskMatch[2].trim();
		}

		// Detect objective mention
		const objMatch = text.match(/objetivo\s+(actual|nuevo|siguiente):\s*(.+)/i);
		if (objMatch) {
			state.currentObjective = objMatch[2].trim();
		}

		// Detect file mentions — require path separators or backticks to avoid false positives
		// e.g. "src/logger.ts" ✓, "`logger.ts`" ✓, "Node.js" ✗
		const fileMatches = text.matchAll(/(?:^|[\s`'/(\\])([\w./\\-]+\.\w+)/g);
		for (const match of fileMatches) {
			const filePath = match[1].replace(/[`']/g, "");
			// Only add if it looks like a source file with a valid extension
			if (
				/\.(ts|js|tsx|jsx|py|rs|go|java|css|json|md|yaml|yml|toml|vue|svelte)$/i.test(filePath) &&
				!TECH_EXCLUSIONS.test(filePath) &&
				!state.importantFiles.some((f) => f.path === filePath)
			) {
				state.importantFiles.push({
					path: filePath,
					reason: "Mencionado en conversación",
					episode: activeEp,
				});
			}
		}
	}

	/**
	 * Extracts conclusions and next steps from assistant responses heuristically.
	 */
	private extractConclusionsFromAssistant(state: SessionState, text: string): void {
		const now = new Date().toISOString();
		const activeEp = state.activeEpisodeId;

		// Pattern for conclusions
		const conclusionPatterns = [
			/(?:hemos|he|ya)\s+(decidido|acordado|concluido|resuelto)\s+(?:que\s+)?(.+?)(?:\.|$)/i,
			/decisión:\s*(.+?)(?:\.|$)/i,
			/conclusión:\s*(.+?)(?:\.|$)/i,
			/(?:la|una)\s+decisión\s+(importante|clave|final)\s+(es|fue|será)\s*(.+?)(?:\.|$)/i,
			/quedamos\s+en\s+(?:que\s+)?(.+?)(?:\.|$)/i,
		];

		for (const pattern of conclusionPatterns) {
			const match = text.match(pattern);
			if (match) {
				const decisionText = (match[2] || match[1] || match[3] || "").trim();
				if (decisionText.length > 10) {
					state.decisions.push({
						text: decisionText,
						episode: activeEp,
						timestamp: now,
					});
					state.conclusions.push({
						text: decisionText,
						episode: activeEp,
					});
				}
			}
		}

		// Pattern for next steps
		const nextStepPatterns = [
			/(?:siguiente|próximo|próximos?)\s+(paso|tarea|acción|item)[:\s]+(.+?)(?:\.|$)/i,
			/pendiente:\s*(.+?)(?:\.|$)/i,
			/(?:falta|queda|resta)\s+(?:por\s+)?(?:hacer|implementar|completar|revisar)\s*(.+?)(?:\.|$)/i,
		];

		for (const pattern of nextStepPatterns) {
			const match = text.match(pattern);
			if (match) {
				const stepText = (match[2] || match[1] || "").trim();
				if (stepText.length > 5) {
					state.nextSteps.push({
						text: stepText,
						episode: activeEp,
					});
				}
			}
		}

		// Pattern for error detection
		const errorMatch = text.match(/(?:error|problema|bug|fallo|issue)[:\s]+(.+?)(?:\.|$)/i);
		if (errorMatch) {
			const errText = errorMatch[1].trim();
			if (errText.length > 10) {
				state.knownErrors.push({
					error: errText,
					context: "Detectado automáticamente",
					episode: activeEp,
				});
			}
		}
	}
}
