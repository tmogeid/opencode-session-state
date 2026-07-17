/**
 * ContextInjector — formats session state as structured XML
 * for injection into the system prompt via experimental.chat.system.transform.
 *
 * The XML is intentionally clean, compact, and easy for LLMs to parse.
 * Output is always a push to output.system[], never blocking or modifying
 * existing content.
 */

import type { SessionState, Episode, Decision, PendingTask, ImportantFile, KnownError, NextStep, Risk, Conclusion } from './state-store.js';

const INJECTION_HEADER = '<session_state>';
const INJECTION_FOOTER = '</session_state>';

/**
 * Formats the session state as an XML string for system prompt injection.
 * Returns null if the state is empty (no meaningful info to inject).
 *
 * @param state - The current session state
 * @returns XML string or null if state is essentially empty
 */
export function formatStateAsXml(state: SessionState): string | null {
  // Skip if state is essentially empty (brand new session with no info)
  if (
    !state.currentTask &&
    !state.currentObjective &&
    state.decisions.length === 0 &&
    state.pendingTasks.length === 0 &&
    state.episodes.length <= 1
  ) {
    return null;
  }

  const parts: string[] = [INJECTION_HEADER];

  // Current context
  if (state.currentTask) {
    parts.push(`  <current_task>${escapeXml(state.currentTask)}</current_task>`);
  }
  if (state.currentObjective) {
    parts.push(`  <current_objective>${escapeXml(state.currentObjective)}</current_objective>`);
  }
  if (state.mainTopic) {
    parts.push(`  <main_topic>${escapeXml(state.mainTopic)}</main_topic>`);
  }

  // Active episode
  const activeEp = state.episodes.find((e) => e.id === state.activeEpisodeId);
  if (activeEp) {
    parts.push('  <active_episode>');
    parts.push(`    <title>${escapeXml(activeEp.title)}</title>`);
    if (activeEp.summary) {
      parts.push(`    <summary>${escapeXml(activeEp.summary)}</summary>`);
    }
    parts.push('  </active_episode>');
  }

  // Episodes list (compact)
  if (state.episodes.length > 1) {
    parts.push('  <episodes>');
    for (const ep of state.episodes) {
      const status = ep.endedAt ? 'closed' : 'active';
      parts.push(
        `    <episode id="${escapeXml(ep.id)}" status="${status}" priority="${ep.priority}">` +
        `<title>${escapeXml(ep.title)}</title></episode>`
      );
    }
    parts.push('  </episodes>');
  }

  // Key decisions (compact)
  if (state.decisions.length > 0) {
    parts.push('  <decisions>');
    // Show only last 5 decisions
    const recent = state.decisions.slice(-5);
    for (const d of recent) {
      parts.push(`    <decision>${escapeXml(d.text)}</decision>`);
    }
    parts.push('  </decisions>');
  }

  // Pending tasks
  if (state.pendingTasks.length > 0) {
    parts.push('  <pending_tasks>');
    for (const t of state.pendingTasks) {
      parts.push(`    <task>${escapeXml(t.text)}</task>`);
    }
    parts.push('  </pending_tasks>');
  }

  // Important files
  if (state.importantFiles.length > 0) {
    parts.push('  <important_files>');
    for (const f of state.importantFiles) {
      parts.push(`    <file path="${escapeXml(f.path)}">${escapeXml(f.reason)}</file>`);
    }
    parts.push('  </important_files>');
  }

  // Known errors
  if (state.knownErrors.length > 0) {
    parts.push('  <known_errors>');
    for (const e of state.knownErrors) {
      parts.push(`    <error>${escapeXml(e.error)}</error>`);
    }
    parts.push('  </known_errors>');
  }

  // Risks
  if (state.risks.length > 0) {
    parts.push('  <risks>');
    for (const r of state.risks) {
      parts.push(`    <risk mitigation="${escapeXml(r.mitigation)}">${escapeXml(r.text)}</risk>`);
    }
    parts.push('  </risks>');
  }

  // Next steps
  if (state.nextSteps.length > 0) {
    parts.push('  <next_steps>');
    for (const s of state.nextSteps) {
      parts.push(`    <step>${escapeXml(s.text)}</step>`);
    }
    parts.push('  </next_steps>');
  }

  // Conclusions
  if (state.conclusions.length > 0) {
    parts.push('  <conclusions>');
    for (const c of state.conclusions) {
      parts.push(`    <conclusion>${escapeXml(c.text)}</conclusion>`);
    }
    parts.push('  </conclusions>');
  }

  parts.push(INJECTION_FOOTER);

  return parts.join('\n');
}

/**
 * Estimates the token count of the XML injection (approximate).
 */
export function estimateInjectionTokens(xml: string): number {
  // Rough estimate: ~4 chars per token for XML
  return Math.ceil(xml.length / 4);
}

/**
 * Escapes special XML characters.
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
