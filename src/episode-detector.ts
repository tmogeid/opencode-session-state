/**
 * EpisodeDetector — detects topic changes in the conversation
 * and automatically creates new episodes when a meaningful shift occurs.
 *
 * Detection methods:
 * 1. Pattern-based: explicit topic-change phrases
 * 2. Task-based: new task or objective mentioned
 * 3. File-based: switch to a completely different file/area
 */

import type { Episode, SessionState } from "./state-store.js";
import { getLogger } from "./logger.js";

/** Patterns that explicitly signal a topic change */
const TOPIC_CHANGE_PATTERNS: RegExp[] = [
  /vamos?\s+a\s+(hablar|cambiar|tratar|ver|abordar)/i,
  /cambiando\s+de\s+tema/i,
  /pasemos?\s+a/i,
  /ahora\s+(hablemos|veamos|trabajemos|pasemos|abordemos)/i,
  /nuev[oa]\s+(tarea|tema|objetivo|proyecto|fase|etapa)/i,
  /dejemos?\s+(esto|eso)/i,
  /por\s+(ahora|el\s+momento)\s+(dejemos|dejémoslo)/i,
  /¿?(siguiente|próxim[oa])\s+(paso|tarea|fase|etapa|punto)/i,
  /pasamos?\s+a\s+otr[oa]/i,
  /otr[oa]\s+(tema|tarea|asunto|cosa)/i,
  /cambio\s+de\s+(tema|tarea|enfoque)/i,
  /retomamos?\s+(el|la|lo)\s+(que|de)/i,
];

/** Patterns that signal a new task or objective */
const TASK_CHANGE_PATTERNS: RegExp[] = [
  /tarea\s+(actual|nueva|siguiente):\s*(.+)/i,
  /objetivo\s+(actual|nuevo|siguiente):\s*(.+)/i,
  /ahora\s+(voy\s+a|vamos\s+a)\s+(trabajar|implementar|desarrollar|crear|hacer)/i,
  /empecemos?\s+con\s+(el|la|lo)\s+(siguiente|nuev[oa])/i,
  /lo\s+(que\s+sigue|siguiente)\s+es/i,
  /procedo\s+a/i,
  /paso\s+(a|siguiente)/i,
];

/** File path patterns to detect which file is being worked on */
const FILE_PATTERN = /(?:^|[\s`'/(\\])([\w./\\-]+\.\w+)/g;

/** Technology/product names that look like files but aren't */
const TECH_EXCLUSIONS =
  /^(Node|React|Vue|Angular|Next|Nuxt|Vite|Astro|Svelte|Solid|Bun|Deno|Express|Koa|Fastify|jQuery|Lodash|Axios|TypeScript|JavaScript|ESLint|Prettier|Webpack|Rollup|Turbopack|PostCSS|Babel|Tailwind|Prisma|Supabase|Firebase|Docker|Kubernetes|Terraform|Ansible|Webpack|Vitest|Jest|Mocha|Cypress|Playwright|Storybook|Chromatic|Stripe|GraphQL|Apollo|Relay|Redux|Zustand|Jotai|XState|Zod|Yup)\.\w+$/i;

export interface TopicChangeResult {
  detected: boolean;
  type: "topic_change" | "task_change" | "file_change" | null;
  confidence: number;
  newTopic?: string;
  newTask?: string;
  newFile?: string;
}

/**
 * Detects whether the latest message represents a topic change.
 *
 * @param newMessage - The latest user message text (plain text, no tool output)
 * @param activeEpisode - The currently active episode
 * @param importantFiles - Files currently tracked in the session state
 * @returns Detection result with confidence score
 */
export function detectTopicChange(
  newMessage: string,
  activeEpisode: Episode,
  importantFiles: Array<{ path: string; reason: string }>,
): TopicChangeResult {
  const log = getLogger();

  // 1. Check explicit topic change phrases
  for (const pattern of TOPIC_CHANGE_PATTERNS) {
    const match = newMessage.match(pattern);
    if (match) {
      log.debug(`Topic change detected via pattern: "${match[0]}"`);
      return {
        detected: true,
        type: "topic_change",
        confidence: 0.8,
        newTopic: extractNewTopic(newMessage),
      };
    }
  }

  // 2. Check task change patterns
  for (const pattern of TASK_CHANGE_PATTERNS) {
    const match = newMessage.match(pattern);
    if (match) {
      log.debug(`Task change detected: "${match[0]}"`);
      return {
        detected: true,
        type: "task_change",
        confidence: 0.7,
        newTask: match[2] || extractNewTopic(newMessage),
      };
    }
  }

  // 3. Check file change (completely different file from current set)
  if (importantFiles.length > 0) {
    const fileMatches = newMessage.matchAll(FILE_PATTERN);
    for (const fileMatch of fileMatches) {
      const mentionedFile = fileMatch[1].replace(/[`']/g, "");
      // Skip technology names and very short matches
      if (TECH_EXCLUSIONS.test(mentionedFile) || mentionedFile.length < 3) {
        continue;
      }
      const isNewFile = !importantFiles.some(
        (f) => f.path.includes(mentionedFile) || mentionedFile.includes(f.path),
      );
      if (
        isNewFile &&
        !newMessage.toLowerCase().includes("mismo") &&
        !newMessage.toLowerCase().includes("continu")
      ) {
        log.debug(`New file detected: ${mentionedFile}`);
        return {
          detected: true,
          type: "file_change",
          confidence: 0.5,
          newFile: mentionedFile,
        };
      }
    }
  }

  return {
    detected: false,
    type: null,
    confidence: 0,
  };
}

/**
 * Creates a new episode based on a topic change detection.
 *
 * @param state - Current session state
 * @param detection - Topic change detection result
 * @param messages - Recent messages (for summary generation)
 * @returns Updated session state with new episode
 */
export function applyTopicChange(
  state: SessionState,
  detection: TopicChangeResult,
  _messages: string[],
): SessionState {
  const log = getLogger();

  // Close the current active episode
  const currentEp = state.episodes.find((e) => e.id === state.activeEpisodeId);
  if (currentEp) {
    currentEp.endedAt = new Date().toISOString();
    currentEp.summary = generateEpisodeSummary(currentEp, _messages);
  }

  // Create new episode
  episodeCounter++;
  const epId = `ep${episodeCounter}`;
  const now = new Date().toISOString();

  const newEpisode: Episode = {
    id: epId,
    title:
      detection.newTask ||
      detection.newTopic ||
      detection.newFile ||
      `Episodio ${episodeCounter}`,
    topic: detection.newTopic || detection.newTask || "",
    startedAt: now,
    endedAt: null,
    summary: "",
    priority: state.episodes.length, // Newest has highest priority number
  };

  state.episodes.push(newEpisode);
  state.activeEpisodeId = epId;
  state.currentTask = detection.newTask || state.currentTask;

  log.info(`New episode created: "${newEpisode.title}" (${epId})`);
  return state;
}

/**
 * Compresses old episodes when the state exceeds the maximum allowed tokens.
 * Removes the oldest, lowest-priority episode summaries while keeping metadata.
 *
 * @param state - Current session state
 * @param maxEpisodes - Maximum number of episodes to keep
 */
export function compressOldEpisodes(
  state: SessionState,
  maxEpisodes: number,
): void {
  if (state.episodes.length <= maxEpisodes) return;

  const log = getLogger();

  // Sort by priority (ascending — oldest/lowest first)
  const sorted = [...state.episodes].sort((a, b) => a.priority - b.priority);

  // Episodes to compress: all except the `maxEpisodes` most recent
  const toCompress = sorted.slice(0, sorted.length - maxEpisodes);

  for (const ep of toCompress) {
    log.debug(`Compressing episode: "${ep.title}" (${ep.id})`);
    ep.summary = `[Comprimido] ${ep.summary.slice(0, 200)}`;
    // Remove references to this episode from other state fields
    // (decisions, tasks, etc.) — they stay but reference the compressed ep
  }

  // Keep only the top `maxEpisodes` episodes
  state.episodes = sorted.slice(-maxEpisodes);
}

let episodeCounter = 0;

function extractNewTopic(message: string): string | undefined {
  // Try to extract a meaningful topic from the message
  const clean = message
    .replace(/^(vamos a|ahora|pasemos a|cambiando a|nuevo|siguiente)\s*/i, "")
    .replace(/[:.!,;].*$/, "")
    .trim();
  return clean.length > 3 ? clean.slice(0, 80) : undefined;
}

function generateEpisodeSummary(episode: Episode, messages: string[]): string {
  if (messages.length === 0) return episode.summary;
  // Simple summary: just note what was accomplished
  return episode.summary || `Trabajo en: ${episode.title}`;
}
