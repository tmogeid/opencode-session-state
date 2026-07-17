/**
 * SessionStateTool — custom tool registered via @opencode-ai/plugin/tool.
 *
 * Allows the AI (and user via /session-state command) to inspect and
 * manage the session state.
 *
 * Actions:
 * - "ver" (default): full state formatted as text
 * - "resumen": summary of active episode
 * - "episodios": list all episodes
 * - "limpiar": remove archived sessions >30 days
 */

import { tool } from '@opencode-ai/plugin/tool';
import type { SessionManager } from '../session-manager.js';
import { formatStateAsXml } from '../context-injector.js';
import { getLogger } from '../logger.js';

/**
 * Creates the session_state tool definition.
 *
 * @param sessionManager - The session manager instance
 * @param projectDir - Absolute path to the project directory
 */
export function createSessionStateTool(
  sessionManager: SessionManager,
  projectDir: string
) {
  return tool({
    description:
      'Muestra o gestiona el estado actual de la sesión de OpenCode. ' +
      'Incluye tarea activa, episodios, decisiones tomadas, tareas pendientes, ' +
      'archivos importantes, errores conocidos y próximos pasos. ' +
      'Usar sin argumentos para ver el estado completo.',
    args: {
      action: tool.schema
        .string()
        .optional()
        .describe(
          "Acción: 'ver' (estado completo, default), 'resumen' (episodio activo), 'episodios' (lista), 'limpiar' (archivadas >30d)"
        ),
    },
    async execute(args, context) {
      const log = getLogger();
      const action = (args.action as string | undefined) ?? 'ver';
      const sessionId = context.sessionID;

      log.info(`Tool session_state called: action=${action} session=${sessionId}`);

      try {
        switch (action) {
          case 'resumen':
            return await handleResumen(sessionManager, sessionId);
          case 'episodios':
            return await handleEpisodios(sessionManager, sessionId);
          case 'limpiar':
            return await handleLimpiar(sessionManager);
          case 'ver':
          default:
            return await handleVer(sessionManager, sessionId, projectDir);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`Tool session_state error: ${msg}`);
        return {
          title: 'Error',
          output: `Error al obtener el estado de la sesión: ${msg}`,
          metadata: { error: msg },
        };
      }
    },
  });
}

async function handleVer(
  sm: SessionManager,
  sessionId: string,
  projectDir: string
): Promise<string> {
  let state = sm.getCachedState(sessionId);

  // If not in cache, try loading from disk
  if (!state) {
    state = await sm.getOrCreate(sessionId);
  }

  const xml = formatStateAsXml(state);
  if (!xml) {
    return '## Estado de Sesión\n\nLa sesión actual no tiene información significativa todavía. Los datos se recopilan automáticamente a medida que avanza la conversación.';
  }

  const activeEp = state.episodes.find((e) => e.id === state.activeEpisodeId);
  const epStatus = activeEp?.endedAt ? '✅ Cerrado' : '🔄 Activo';

  // Build a readable markdown output
  const lines: string[] = [
    '## Estado de Sesión',
    '',
    `**ID:** \`${sessionId}\``
  ];

  if (state.currentTask) lines.push(`**Tarea Actual:** ${state.currentTask}`);
  if (state.currentObjective) lines.push(`**Objetivo:** ${state.currentObjective}`);
  if (state.mainTopic) lines.push(`**Tema Principal:** ${state.mainTopic}`);

  if (activeEp) {
    lines.push('');
    lines.push(`**Episodio Activo:** ${activeEp.title} (${epStatus})`);
    if (activeEp.summary) lines.push(`> ${activeEp.summary}`);
  }

  if (state.decisions.length > 0) {
    lines.push('');
    lines.push(`**Decisiones (${state.decisions.length}):**`);
    for (const d of state.decisions.slice(-5)) {
      lines.push(`- ${d.text}`);
    }
  }

  if (state.pendingTasks.length > 0) {
    lines.push('');
    lines.push(`**Tareas Pendientes (${state.pendingTasks.length}):**`);
    for (const t of state.pendingTasks) {
      lines.push(`- ${t.text}`);
    }
  }

  if (state.importantFiles.length > 0) {
    lines.push('');
    lines.push(`**Archivos Importantes (${state.importantFiles.length}):**`);
    for (const f of state.importantFiles) {
      lines.push(`- \`${f.path}\`: ${f.reason}`);
    }
  }

  if (state.knownErrors.length > 0) {
    lines.push('');
    lines.push(`**Errores Conocidos (${state.knownErrors.length}):**`);
    for (const e of state.knownErrors) {
      lines.push(`- ${e.error}`);
    }
  }

  if (state.nextSteps.length > 0) {
    lines.push('');
    lines.push(`**Próximos Pasos (${state.nextSteps.length}):**`);
    for (const s of state.nextSteps) {
      lines.push(`- ${s.text}`);
    }
  }

  lines.push('');
  lines.push(`_Sesión creada: ${new Date(state.createdAt).toLocaleString()}_`);
  lines.push(`_Última actualización: ${new Date(state.updatedAt).toLocaleString()}_`);
  lines.push(`_Episodios totales: ${state.episodes.length}_`);
  lines.push(`_Proyecto: \`${projectDir}\`_`);

  return lines.join('\n');
}

async function handleResumen(
  sm: SessionManager,
  sessionId: string
): Promise<string> {
  const state = sm.getCachedState(sessionId) ?? await sm.getOrCreate(sessionId);
  const activeEp = state.episodes.find((e) => e.id === state.activeEpisodeId);

  if (!activeEp) {
    return 'No hay un episodio activo.';
  }

  const lines: string[] = [
    '## Resumen del Episodio Activo',
    '',
    `**${activeEp.title}**`,
    `**ID:** ${activeEp.id}`,
    `**Inicio:** ${new Date(activeEp.startedAt).toLocaleString()}`,
    activeEp.endedAt ? `**Fin:** ${new Date(activeEp.endedAt).toLocaleString()}` : '**Estado:** Activo',
    '',
  ];

  if (activeEp.summary) {
    lines.push(`> ${activeEp.summary}`);
    lines.push('');
  }

  if (state.currentTask) lines.push(`**Tarea:** ${state.currentTask}`);
  if (state.currentObjective) lines.push(`**Objetivo:** ${state.currentObjective}`);

  return lines.join('\n');
}

async function handleEpisodios(
  sm: SessionManager,
  sessionId: string
): Promise<string> {
  const state = sm.getCachedState(sessionId) ?? await sm.getOrCreate(sessionId);

  if (state.episodes.length === 0) {
    return 'No hay episodios registrados.';
  }

  const lines: string[] = [
    '## Episodios de la Sesión',
    '',
    `Total: ${state.episodes.length}`,
    '',
  ];

  for (const ep of state.episodes) {
    const status = ep.endedAt ? '✅ Cerrado' : '🔄 Activo';
    const duration = ep.endedAt
      ? ` (${Math.round((new Date(ep.endedAt).getTime() - new Date(ep.startedAt).getTime()) / 60000)} min)`
      : '';
    lines.push(`### ${ep.title} ${status}${duration}`);
    lines.push(`**Tema:** ${ep.topic || '(sin especificar)'}`);
    if (ep.summary) lines.push(`> ${ep.summary}`);
    lines.push('');
  }

  return lines.join('\n');
}

async function handleLimpiar(
  sm: SessionManager
): Promise<string> {
  const removed = await sm.pruneArchived(30);
  return removed > 0
    ? `Se eliminaron ${removed} sesiones archivadas con más de 30 días.`
    : 'No hay sesiones archivadas antiguas que limpiar.';
}
