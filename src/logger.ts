/**
 * Logger para el Session State Manager.
 * - INFO/DEBUG → archivo .session-state/logs/<sessionId>.log (no molesta al TUI)
 * - WARN → console.warn (silencioso en TUI)
 * - ERROR → console.warn + toast notification (visible pero temporal)
 */

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

export interface Logger {
	debug(msg: string, ...args: unknown[]): void;
	info(msg: string, ...args: unknown[]): void;
	warn(msg: string, ...args: unknown[]): void;
	error(msg: string, ...args: unknown[]): void;
	flush(): void;
}

export interface LoggerOptions {
	/** Minimum log level to output */
	level?: LogLevel;
	/** Absolute path to the log file */
	logFilePath?: string;
	/** Project root (for creating log directory) */
	projectRoot?: string;
	/** Show toast notification for errors */
	showToast?: (message: string, variant: "error" | "warning") => void;
	/** Show WARN messages in the TUI via console.warn (only when logging is enabled) */
	showWarnings?: boolean;
}

let globalLogger: Logger | null = null;

/**
 * Creates a logger that writes to a file + optional toast for errors.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
	const minRank = LEVEL_RANK[options.level ?? "info"] ?? 1;
	const logFilePath = options.logFilePath;

	// Ensure log directory exists
	if (logFilePath) {
		const dir = join(logFilePath, "..");
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}

	function log(lvl: LogLevel, msg: string, args: unknown[]): void {
		if (LEVEL_RANK[lvl] < minRank) return;

		const time = new Date().toISOString().slice(0, 19);
		const line = `[${time}] [${lvl.toUpperCase()}] ${msg}${args.length ? " " + args.map(String).join(" ") : ""}`;

		// Write to file (always, regardless of level)
		if (logFilePath) {
			try {
				appendFileSync(logFilePath, line + "\n", "utf-8");
			} catch {
				// Silently fail if file write fails — don't break the plugin
			}
		}

		// WARN → console.warn solo si showWarnings=true (logging activado en config)
		// ERROR → siempre console.warn + toast (son críticos)
		if (lvl === "warn" && options.showWarnings) {
			console.warn(`[SSM] ${line}`);
		} else if (lvl === "error") {
			console.warn(`[SSM] ${line}`);
			if (options.showToast) {
				options.showToast(msg.slice(0, 120), "error");
			}
		}
	}

	const logger: Logger = {
		debug: (msg, ...args) => log("debug", msg, args),
		info: (msg, ...args) => log("info", msg, args),
		warn: (msg, ...args) => log("warn", msg, args),
		error: (msg, ...args) => log("error", msg, args),
		flush: () => {
			// File writes are synchronous via appendFileSync, no-op
		},
	};

	return logger;
}

/**
 * Sets the global logger instance.
 */
export function setGlobalLogger(logger: Logger): void {
	globalLogger = logger;
}

/**
 * Returns the global logger, creating a default one if not set.
 * Default logger writes to console.warn only (errors).
 */
export function getLogger(): Logger {
	if (!globalLogger) {
		globalLogger = createLogger({ level: "warn" });
	}
	return globalLogger;
}
