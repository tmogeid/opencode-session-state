# Changelog

## v2.0.0

- feat: nuevo entrypoint v2 (`index.js`) adaptado a la API v2 de plugins (`@opencode-ai/plugin/v2/promise`).
- feat: mapa `exports` declarado con la condicion `types` primera para que TypeScript resuelva `dist/index.d.ts` con resolucion node16/nodenext, y `main` sin el prefijo `./` para que npm incluya automaticamente el entrypoint.
- feat: registro de hooks v2 (`chat.message`, `event`, `experimental.chat.messages.transform`, `experimental.session.compacting`).
- feat: identificadores de episodio deterministas calculados a partir del estado persistido en lugar de un contador global en memoria de proceso.
- feat: herramienta `session_state` con 4 acciones operativas (`ver`, `resumen`, `episodios`, `limpiar`).
- feat: persistencia de estado estrictamente local al proyecto en `<projectRoot>/.session-state/<sessionId>.json` sin dependencias externas ni servicios remotos.
- docs: documentacion tecnica actualizada y ampliada para la arquitectura OpenCode v2.
- chore: integracion del texto formal de la licencia GNU GPL-3.0 canonica.

## v1.1.5

- feat: configuracion de modelo predeterminado `big-pickle` con endpoint OpenCode Zen en `src/config.ts`.
- fix: incorporacion de funcion `autoRepairJSON` en `src/summarizer.ts` para reparar respuestas JSON truncadas provenientes del LLM (cierre de llaves y corchetes abiertos).
- chore: actualizacion de versiones en `package.json`, `package-lock.json`, `plugin.json` y mensaje de inicializacion en `src/index.ts`. Fecha de publicacion no registrada formalmente en etiquetas del historial git previo al clon base (`960588bb0c8d3299565ee903a7aef393bd340e2f`).

## v1.1.4

- fix: consistencia disco↔memoria — getCachedState relee el estado en disco en cada acceso (disco autoritativo sobre cache); persist aborta escrituras stale cuando el disco es más nuevo o fue corregido externamente, recargando desde disco. Fix menor: string de versión del log actualizada.
