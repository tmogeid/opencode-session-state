/**
 * StateStore — persists session state as individual JSON files.
 *
 * Files are stored at: <projectRoot>/.session-state/<sessionId>.json
 * Each session gets its own file, fully independent.
 */

import { readFile, writeFile, unlink, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getLogger } from './logger.js';

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

let episodeCounter = 0;

/**
 * Creates a new empty session state for the given session ID.
 */
export function createEmptyState(sessionId: string): SessionState {
  episodeCounter++;
  const epId = `ep${episodeCounter}`;
  const now = new Date().toISOString();
  return {
    version: 1,
    sessionId,
    createdAt: now,
    updatedAt: now,
    currentTask: '',
    currentObjective: '',
    mainTopic: '',
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
        title: 'Inicio de sesión',
        topic: '',
        startedAt: now,
        endedAt: null,
        summary: '',
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
      const data = await readFile(this.filePath(sessionId), 'utf-8');
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
    await writeFile(this.filePath(sessionId), data, 'utf-8');
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
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''));
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
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
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
