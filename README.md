# opencode-session-state

[![npm version](https://img.shields.io/npm/v/opencode-session-state.svg)](https://www.npmjs.com/package/opencode-session-state)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
[![Node.js >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](https://nodejs.org/)

Plugin para [OpenCode](https://opencode.ai) que mantiene un estado inteligente de la sesión para preservar contexto tras compactaciones, cambios de modelo o sesiones largas.

## Por qué

OpenCode y otros agentes LLM pierden contexto tras compactar la ventana, cambiar de modelo, o en sesiones largas. Este plugin:

- Detecta automáticamente cambios de tema y crea **episodios**
- Resume de forma incremental (nunca relee toda la conversación)
- Inyecta el estado en el system prompt antes de cada petición
- Preserva el contexto durante las compactaciones
- Expone una herramienta `session_state` para inspeccionar el estado

## Instalación

Hay dos métodos equivalentes. Elige según tu flujo de trabajo.

### Método A — Via npm (recomendado para usuarios finales)

```bash
npm install -g opencode-session-state
```

Añade el plugin a tu `opencode.json` (global en `~/.config/opencode/opencode.json` o de proyecto):

```json
{
  "plugin": [
    ["opencode-session-state", {
      "model": "big-pickle",
      "apiBaseUrl": "https://opencode.ai/zen/v1",
      "temperature": 0.1,
      "logging": "info"
    }]
  ]
}
```

Copia el comando `/session-state` a tu directorio de comandos:

```bash
# Linux/macOS:
cp node_modules/opencode-session-state/commands/session-state.md ~/.config/opencode/commands/

# Windows (PowerShell):
Copy-Item node_modules/opencode-session-state/commands/session-state.md $env:USERPROFILE\.config\opencode\commands\
```

Reinicia OpenCode.

### Método B — Via GitHub (desarrollo/contribuidores)

```bash
git clone https://github.com/tmogeid/opencode-session-state.git
cd opencode-session-state
npm install
npm run build
```

Enlaza en `opencode.json` con la ruta absoluta al `dist/index.js`:

```json
{
  "plugin": [
    ["/ruta/absoluta/a/opencode-session-state/dist/index.js", {
      "model": "big-pickle",
      "apiBaseUrl": "https://opencode.ai/zen/v1",
      "temperature": 0.1,
      "logging": "info"
    }]
  ]
}
```

Copia el comando `/session-state`:

```bash
# Linux/macOS:
cp commands/session-state.md ~/.config/opencode/commands/

# Windows (PowerShell):
Copy-Item commands\session-state.md $env:USERPROFILE\.config\opencode\commands\
```

Reinicia OpenCode.

## Modelos recomendados

El plugin usa un LLM para resumir incrementalmente la conversación. Hay dos opciones recomendadas:

### Big Pickle en OpenCode Zen (recomendado)

- **Model ID**: `big-pickle`
- **Endpoint**: `https://opencode.ai/zen/v1`
- **Precio**: Gratis (stealth model, tiempo limitado)
- **Cómo obtener la API key**:
  1. Visita [opencode.ai/auth](https://opencode.ai/auth)
  2. Inicia sesión y crea una API key
  3. La key tendrá formato `sk-...`
  4. Configúrala como variable de entorno:

```bash
# Linux/macOS:
export OPENCODE_ZEN_API_KEY=sk-...

# Windows (PowerShell sesión actual):
$env:OPENCODE_ZEN_API_KEY='sk-...'

# Windows (persistente):
[Environment]::SetEnvironmentVariable('OPENCODE_ZEN_API_KEY', 'sk-...', 'User')
```

- **Privacidad**: Durante el periodo free, los datos pueden usarse para mejorar el modelo

Configuración de ejemplo:

```json
{
  "plugin": [
    ["opencode-session-state", {
      "model": "big-pickle",
      "apiBaseUrl": "https://opencode.ai/zen/v1"
    }]
  ]
}
```

### poolside/laguna-xs-2.1:free en OpenRouter (alternativa)

- **Model ID**: `poolside/laguna-xs-2.1:free`
- **Endpoint**: `https://openrouter.ai/api/v1`
- **Precio**: Gratis (OpenRouter free tier)
- **Cómo obtener la API key**:
  1. Visita [openrouter.ai/keys](https://openrouter.ai/keys)
  2. Crea una cuenta y genera una API key
  3. Configúrala: `export OPENROUTER_API_KEY=sk-or-...`

```json
{
  "plugin": [
    ["opencode-session-state", {
      "model": "poolside/laguna-xs-2.1:free",
      "apiBaseUrl": "https://openrouter.ai/api/v1"
    }]
  ]
}
```

### Comparativa

| Característica | Big Pickle (Zen) | poolside (OpenRouter) |
|----------------|------------------|------------------------|
| Precio | Gratis (limitado) | Gratis (free tier) |
| Default v1.0.2 | No | Sí |
| Default v1.0.3+ | Sí | No |
| Env var | `OPENCODE_ZEN_API_KEY` | `OPENROUTER_API_KEY` |
| Optimizado para coding | Sí (stealth model) | Sí |

## API Key

El plugin busca la API key en este orden:

1. `apiKey` explícita en la config del plugin
2. `OPENROUTER_API_KEY` (env var)
3. `OPENCODE_ZEN_API_KEY` (env var)
4. `NVIDIA_API_KEY` (env var, legacy)
5. `OPENAI_API_KEY` (env var, fallback)

Mejor usar env vars que pasar la key directamente en la config (por seguridad).

## Configuración

Todas las opciones configurables:

| Opción | Tipo | Default | Descripción |
|--------|------|---------|-------------|
| `model` | string | `poolside/laguna-xs-2.1:free` | Modelo LLM para resúmenes |
| `apiBaseUrl` | string | `https://openrouter.ai/api/v1` | URL base de la API |
| `apiKey` | string | (env vars) | API key explícita |
| `temperature` | number | `0.1` | Temperatura del modelo |
| `maxTokens` | number | `2000` | Tokens máximos por llamada |
| `maxEpisodes` | number | `4` | Máximo de episodios |
| `maxStateTokens` | number | `5000` | Máximo tokens del estado |
| `logging` | string | `info` | Nivel: `debug`, `info`, `warn`, `error` |
| `storageDir` | string | `.session-state` | Directorio para archivos |
| `injection` | boolean | `true` | Inyectar estado en system prompt |
| `autoSummary` | boolean | `true` | Resumen automático via LLM |
| `summarizerInterval` | number | `30000` | Intervalo mínimo (ms) |

## Cómo funciona

```
Mensaje usuario → chat.message hook → SessionManager:
  1. Encola turno en pendingTurns
  2. Detecta cambio de tema → crea episodio
  3. Aplica heurísticas (archivos, errores, decisiones)
  4. Cada 30s y ≥2 turnos → LLM resume incremental
     → mergeStateUpdate + persistencia a disco

Respuesta asistente → event/message.updated → SessionManager:
  1. Encola respuesta
  2. Extrae conclusiones heurísticas
  3. Trigger summarizer si aplica

Antes de cada prompt → system.transform hook:
  → formatStateAsXml(state) → inyecta en system prompt
```

## Estado de sesión

Archivos JSON individuales en `.session-state/<sessionId>.json`:

| Campo | Descripción |
|-------|-------------|
| `currentTask` | Tarea actual detectada |
| `currentObjective` | Objetivo actual |
| `mainTopic` | Tema principal del episodio |
| `episodes[]` | Lista de episodios |
| `decisions[]` | Decisiones tomadas |
| `pendingTasks[]` | Tareas pendientes |
| `importantFiles[]` | Archivos mencionados |
| `knownErrors[]` | Errores conocidos |
| `risks[]` | Riesgos identificados |
| `nextSteps[]` | Próximos pasos |
| `conclusions[]` | Conclusiones |

## Herramienta `session_state`

| Acción | Descripción |
|--------|-------------|
| `ver` (default) | Estado completo formateado |
| `resumen` | Episodio activo actual |
| `episodios` | Lista de todos los episodios |
| `limpiar` | Eliminar sesiones archivadas >30 días |

## Logs

Los logs van a `.session-state/logs/<YYYY-MM-DD>.log`:

- `DEBUG`/`INFO` → solo archivo (no molesta al TUI)
- `WARN` → `console.warn` (silencioso en UI)
- `ERROR` → `console.warn` + toast notification

## Hooks de OpenCode

| Hook | Propósito |
|------|-----------|
| `tool` | Herramienta `session_state` |
| `chat.message` | Mensajes del usuario |
| `event` | Lifecycle de sesiones |
| `experimental.chat.system.transform` | Inyectar estado |
| `experimental.session.compacting` | Preservar en compactación |
| `experimental.compaction.autocontinue` | Continuar post-compactación |

## Arquitectura del código

```
src/
├── index.ts              # Entry point — hooks
├── config.ts             # Configuración defaults + merge
├── logger.ts             # Logging archivo + toast
├── state-store.ts        # Persistencia JSON por sesión
├── session-manager.ts    # Orquestador principal
├── episode-detector.ts   # Detección cambios de tema
├── summarizer.ts         # LLM incremental summarization
├── context-injector.ts   # Formateo XML para system prompt
└── tools/
    └── session-state.ts  # Herramienta ver/resumen/episodios/limpiar
```

## Licencia

[GPL-3.0](./LICENSE) — Copyright (c) 2026 tmogeid

## Repositorio

- **Código**: [github.com/tmogeid/opencode-session-state](https://github.com/tmogeid/opencode-session-state)
- **Issues**: [github.com/tmogeid/opencode-session-state/issues](https://github.com/tmogeid/opencode-session-state/issues)
- **npm**: [npmjs.com/package/opencode-session-state](https://www.npmjs.com/package/opencode-session-state)
