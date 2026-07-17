/**
 * Configuration for the Session State Manager plugin.
 * Merges defaults with options passed from opencode.json.
 */

import { getLogger } from './logger.js';

export interface SsmConfig {
  /** Model ID for the summarizer LLM (e.g. "gpt-oss-20b") */
  model: string;

  /** API base URL for the summarizer provider (OpenAI-compatible) */
  apiBaseUrl: string;

  /** API key. Falls back to NVIDIA_API_KEY env var if not set */
  apiKey: string | undefined;

  /** LLM temperature for summarization */
  temperature: number;

  /** Max output tokens per summarizer call */
  maxTokens: number;

  /** Maximum number of episodes before compressing the oldest */
  maxEpisodes: number;

  /** Maximum total tokens for the session state before compression kicks in */
  maxStateTokens: number;

  /** Log level: debug | info | warn | error */
  logging: string;

  /** Directory name inside the project root for storing session state files */
  storageDir: string;

  /** Whether to auto-inject session state into system prompts */
  injectionEnabled: boolean;

  /** Whether to auto-run the LLM summarizer */
  autoSummary: boolean;

  /** Minimum interval in ms between summarizer LLM calls */
  summarizerInterval: number;
}

const DEFAULTS: SsmConfig = {
  model: 'poolside/laguna-xs-2.1:free',
  apiBaseUrl: 'https://openrouter.ai/api/v1',
  apiKey: undefined,
  temperature: 0.1,
  maxTokens: 2000,
  maxEpisodes: 4,
  maxStateTokens: 5000,
  logging: 'info',
  storageDir: '.session-state',
  injectionEnabled: true,
  autoSummary: true,
  summarizerInterval: 30000,
};

/**
 * Resolves the effective config by merging user options over defaults.
 * Tries env vars for the API key when not explicitly provided.
 *
 * @param options - Raw options passed from opencode.json plugin entry
 */
export function resolveConfig(options?: Record<string, unknown>): SsmConfig {
  const log = getLogger();
  const config: SsmConfig = { ...DEFAULTS };

  if (!options) return config;

  if (typeof options.model === 'string') config.model = options.model;
  if (typeof options.apiBaseUrl === 'string') config.apiBaseUrl = options.apiBaseUrl;
  if (typeof options.apiKey === 'string') config.apiKey = options.apiKey;
  if (typeof options.temperature === 'number') config.temperature = options.temperature;
  if (typeof options.maxTokens === 'number') config.maxTokens = options.maxTokens;
  if (typeof options.maxEpisodes === 'number') config.maxEpisodes = options.maxEpisodes;
  if (typeof options.maxStateTokens === 'number') config.maxStateTokens = options.maxStateTokens;
  if (typeof options.logging === 'string') config.logging = options.logging;
  if (typeof options.storageDir === 'string') config.storageDir = options.storageDir;
  if (typeof options.injection === 'boolean') config.injectionEnabled = options.injection;
  if (typeof options.autoSummary === 'boolean') config.autoSummary = options.autoSummary;
  if (typeof options.summarizerInterval === 'number') config.summarizerInterval = options.summarizerInterval;

  // Fall back to env var if no explicit API key
  if (!config.apiKey) {
    config.apiKey = process.env.OPENROUTER_API_KEY ?? process.env.OPENCODE_ZEN_API_KEY ?? process.env.NVIDIA_API_KEY ?? process.env.OPENAI_API_KEY ?? undefined;
    if (!config.apiKey) {
      log.warn('No API key configured. Set OPENROUTER_API_KEY, OPENCODE_ZEN_API_KEY, NVIDIA_API_KEY, or OPENAI_API_KEY env var, or pass apiKey in options.');
    }
  }

  log.info(`Config resolved: model=${config.model} temperature=${config.temperature} maxEpisodes=${config.maxEpisodes} maxStateTokens=${config.maxStateTokens} injection=${config.injectionEnabled} autoSummary=${config.autoSummary}`);
  return config;
}
