/**
 * StateStore — persists session state as individual JSON files.
 *
 * Files are stored at: <projectRoot>/.session-state/<sessionId>.json
 * Each session gets its own file, fully independent.
 */

import { readFile, writeFile, unlink, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { getLogger } from "./logger.js";

/**
 * A single decision recorded during the session.
 */
export interface Decision {
  text: string;
  episode: string;
  timestamp: string;
}

/**
 * A pending task.
 */
export interface PendingTask {
  text: string;
  episode: string;
}

/**
 * An important file reference.
 */
export interface ImportantFile {
  path: string;
  reason: string;
  episode: string;
}

/**
 * A known error or issue.
 */
export interface KnownError {
  error: string;
  context: string;
  episode: string;
}

/**
 * A risk identified.
 */
export interface Risk {
  text: string;
  mitigation: string;
  episode: string;
}

/**
 * A next step or action item.
 */
export interface NextStep {
  text: string;
  episode: string;
}

/**
 * A conclusion reached.
 */
export interface Conclusion {
  text: string;
  episode: string;
}

/**
 * An episode represents a distinct topic or task within a session.
 */
export interface Episode {
  id: string;
  title: string;
  topic: string;
  startedAt: string;
  endedAt: string | null;
  summary: string;
  priority: number;
}

/**
 * Full session state structure persisted to disk.
 */
export interface SessionState {
  version: number;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  currentTask: string;
  currentObjective: string;
  mainTopic: string;
  decisions: Decision[];
  pendingTasks: PendingTask[];
  importantFiles: ImportantFile[];
  knownErrors: KnownError[];
  risks: Risk[];
  nextSteps: NextStep[];
  conclusions: Conclusion[];
  episodes: Episode[];
  activeEpisodeId: string;
}

const EPISODE_ID_PATTERN = /^ep(\d+)$/;

/**
 * Single source of truth for episode numbering: derives the highest
 * `epN` number present in the given episodes.
 */
export function maxEpisodeNumber(episodes: Episode[]): number {
  let max = 0;
  for (const ep of episodes) {
    const m = EPISODE_ID_PATTERN.exec(ep.id);
    if (m) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isSafeInteger(n) && n > max) max = n;
    }
  }
  return max;
}

/**
 * Derives the next unique episode id from the maximum `epN` present,
 * with a collision guard (retries with higher numbers if taken).
 */
export function nextEpisodeId(episodes: Episode[]): string {
  const taken = new Set(episodes.map((e) => e.id));
  let n = maxEpisodeNumber(episodes) + 1;
  let id = `ep${n}`;
  while (taken.has(id)) {
    n++;
    id = `ep${n}`;
  }
  return id;
}

/**
 * Defensive normalization applied when loading state: keeps the FIRST
 * occurrence of each duplicated id, reassigns later duplicates to unique
 * ids, and repoints `activeEpisodeId` to the correct (last, i.e. newest)
 * episode when it matched a duplicated id. Idempotent: returns false and
 * changes nothing when there are no duplicates.
 */
export function normalizeEpisodeIds(state: SessionState): boolean {
  const originalActiveId = state.activeEpisodeId;
  const originalIds = state.episodes.map((e) => e.id);
  const seen = new Set<string>();
  let max = maxEpisodeNumber(state.episodes);
  const taken = new Set(originalIds);
  let changed = false;
  for (const ep of state.episodes) {
    if (!seen.has(ep.id)) {
      seen.add(ep.id);
      continue;
    }
    let n = max + 1;
    let newId = `ep${n}`;
    while (taken.has(newId)) {
      n++;
      newId = `ep${n}`;
    }
    max = n;
    taken.add(newId);
    ep.id = newId;
    seen.add(newId);
    changed = true;
  }
  if (changed) {
    const dupIndices: number[] = [];
    originalIds.forEach((id, i) => {
      if (id === originalActiveId) dupIndices.push(i);
    });
    if (dupIndices.length > 1) {
      state.activeEpisodeId =
        state.episodes[dupIndices[dupIndices.length - 1]].id;
    }
  }
  return changed;
}

/**
 * Creates a new empty session state for the given session ID.
 */
export function createEmptyState(sessionId: string): SessionState {
  const epId = nextEpisodeId([]);
  const now = new Date().toISOString();
  return {
    version: 1,
    sessionId,
    createdAt: now,
    updatedAt: now,
    currentTask: "",
    currentObjective: "",
    mainTopic: "",
    decisions: [],
    pendingTasks: [],
    importantFiles: [],
    knownErrors: [],
    risks: [],
    nextSteps: [],
    conclusions: [],
    episodes: [
      {
        id: epId,
        title: "Inicio de sesión",
        topic: "",
        startedAt: now,
        endedAt: null,
        summary: "",
        priority: 0,
      },
    ],
    activeEpisodeId: epId,
  };
}

/**
 * StateStore provides file-based persistence for session states.
 *
 * Each session is stored as a separate JSON file under the storage directory.
 * Operations are async and non-blocking.
 */
export class StateStore {
  private storageDir: string;

  /**
   * @param baseDir - Absolute path to the project root directory
   * @param storageDirName - Directory name for state files (e.g. ".session-state")
   */
  constructor(baseDir: string, storageDirName: string) {
    this.storageDir = join(baseDir, storageDirName);
  }

  /**
   * Returns the file path for a given session ID.
   */
  private filePath(sessionId: string): string {
    return join(this.storageDir, `${sessionId}.json`);
  }

  /**
   * Reads the state for a session. Returns null if no state exists yet.
   */
  async read(sessionId: string): Promise<SessionState | null> {
    try {
      const data = await readFile(this.filePath(sessionId), "utf-8");
      return JSON.parse(data) as SessionState;
    } catch {
      return null;
    }
  }

  /**
   * Writes (creates or overwrites) the state for a session.
   */
  async write(sessionId: string, state: SessionState): Promise<void> {
    await mkdir(this.storageDir, { recursive: true });
    state.updatedAt = new Date().toISOString();
    const data = JSON.stringify(state, null, 2);
    await writeFile(this.filePath(sessionId), data, "utf-8");
  }

  /**
   * Deletes the state file for a session.
   */
  async delete(sessionId: string): Promise<void> {
    try {
      await unlink(this.filePath(sessionId));
    } catch {
      // File might not exist; that's fine
    }
  }

  /**
   * Checks if a state file exists for the given session.
   */
  exists(sessionId: string): boolean {
    return existsSync(this.filePath(sessionId));
  }

  /**
   * Lists all session IDs that have stored state.
   */
  async listSessions(): Promise<string[]> {
    try {
      const files = await readdir(this.storageDir);
      return files
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/, ""));
    } catch {
      return [];
    }
  }

  /**
   * Returns all stored sessions as an array of state objects.
   */
  async listAllStates(): Promise<SessionState[]> {
    const sessions = await this.listSessions();
    const states: SessionState[] = [];
    for (const sid of sessions) {
      const state = await this.read(sid);
      if (state) states.push(state);
    }
    // Sort by updatedAt descending (most recent first)
    states.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    return states;
  }

  /**
   * Removes state files older than the given number of days.
   * Returns the number of files removed.
   */
  async pruneOlderThan(days: number): Promise<number> {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const sessions = await this.listSessions();
    let removed = 0;
    for (const sid of sessions) {
      const state = await this.read(sid);
      if (state && new Date(state.updatedAt).getTime() < cutoff) {
        await this.delete(sid);
        removed++;
      }
    }
    return removed;
  }
}
