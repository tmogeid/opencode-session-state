# opencode-session-state

Mantiene el estado de sesion entre compactaciones, cambios de modelo y sesiones largas.

## Indice

- [Descripcion](#descripcion)
- [Requisitos](#requisitos)
- [Instalacion y Registro](#instalacion-y-registro)
- [Hooks y Efecto en Runtime](#hooks-y-efecto-en-runtime)
- [Herramienta session_state](#herramienta-session_state)
- [Persistencia](#persistencia)
- [Configuracion](#configuracion)
- [Limitaciones](#limitaciones)
- [Tipos](#tipos)
- [Compatibilidad v1 y v2](#compatibilidad-v1-y-v2)
- [Licencia](#licencia)
- [Autoria y Enlaces](#autoria-y-enlaces)

## Descripcion

`opencode-session-state` es un plugin para OpenCode disenado para conservar el contexto operativo y la continuidad de las tareas a lo largo de ciclos de trabajo extensos. Detecta transiciones tematicas organizando la actividad en episodios, genera resúmenes incrementales y reinyecta el estado estructurado antes de cada llamada al modelo, manteniendo la coherencia tras compactaciones de contexto.

## Requisitos

- OpenCode con soporte para la API de plugins v2 (verificado localmente con OpenCode CLI 2.1.1).
- `@opencode-ai/plugin` `>= 1.18.3` (version minima que expone el subpath `./v2/promise`).
- Node.js `>= 18`.

## Instalacion y Registro

### 1. Instalacion del paquete

Instalacion global mediante npm:

```bash
npm install -g opencode-session-state
```

O clonando el repositorio para desarrollo e instalacion local:

```bash
git clone https://github.com/tmogeid/opencode-session-state
cd opencode-session-state
npm install
npm run build
```

### 2. Registro en OpenCode

Agrega el plugin a la seccion `plugin` en `opencode.json` (archivo global en `~/.config/opencode/opencode.json` o local al proyecto):

```json
{
  "plugin": ["opencode-session-state"]
}
```

Para personalizar opciones de ejecucion, registra una tupla con el nombre y la configuracion deseada:

```json
{
  "plugin": [
    [
      "opencode-session-state",
      {
        "logging": "info",
        "maxEpisodes": 4
      }
    ]
  ]
}
```

### 3. Registro del comando interactivo

Para habilitar el comando `/session-state` en la interfaz de OpenCode, copia el archivo de definicion:

En Linux y macOS:

```bash
cp commands/session-state.md ~/.config/opencode/commands/
```

En Windows (PowerShell):

```powershell
Copy-Item commands\session-state.md $env:USERPROFILE\.config\opencode\commands\
```

## Hooks y Efecto en Runtime

El entrypoint v2 (`index.js`) registra los siguientes cuatro hooks en el ciclo de vida de OpenCode:

| Hook                                   | Metodo de registro v2            | Efecto en runtime                                                                                                                                                                                              |
| -------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat.message`                         | `ctx.session.hook("prompt")`     | Captura los mensajes de texto del usuario. Garantiza la inicializacion o recuperacion del estado de la sesion y procesa el contenido para actualizar la deteccion de episodios.                                |
| `event`                                | `ctx.event.subscribe`            | Escucha eventos del ciclo de vida (`session.created`, `session.deleted`, `session.idle`). Inicializa estructuras de datos al crear una sesion y sincroniza el estado en disco al quedar inactivo o eliminarse. |
| `experimental.chat.messages.transform` | `ctx.session.hook("context")`    | Inserta el bloque de estado en formato XML al final (`tail`) del arreglo de mensajes salientes, garantizando la persistencia del contexto sin invalidar el prefijo de prompt-cache.                            |
| `experimental.session.compacting`      | `ctx.session.hook("compaction")` | Inserta un snapshot del estado activo dentro del contexto de compactacion (`output.context`), preservando tareas, decisiones y contexto historico en el resumen resultante.                                    |

Los hooks `experimental.chat.system.transform` y `experimental.compaction.autocontinue` no se registran en este entrypoint v2.

## Herramienta session_state

El plugin registra la herramienta `session_state`, permitiendo que el modelo inspeccione y administre el estado actual de la sesion. La herramienta acepta el parametro opcional `action` con cuatro operaciones disponibles:

- `ver`: Muestra el estado completo estructurado de la sesion (opcion por defecto si se omite el parametro). Incluye objetivo activo, lista de episodios, decisiones adoptadas, tareas pendientes, archivos modificados y errores identificados.
- `resumen`: Muestra exclusivamente el texto de resumen acumulado del episodio actual.
- `episodios`: Devuelve la lista de episodios registrados en la sesion actual junto con sus identificadores y marcas de tiempo.
- `limpiar`: Elimina del almacenamiento local las sesiones archivadas con una antiguedad mayor a 30 dias.

Ejemplo de llamada de herramienta por parte del modelo:

```json
{
  "action": "ver"
}
```

Ejemplo de invocacion directa desde el comando interactivo:

```text
/session-state ver
/session-state resumen
/session-state episodios
/session-state limpiar
```

## Persistencia

El estado de cada sesion se almacena exclusivamente en el disco local dentro del directorio del proyecto activo:

```text
<projectRoot>/.session-state/<sessionId>.json
```

El plugin no utiliza MemPalace ni ningun servicio externo; toda la persistencia es estrictamente local al proyecto.

## Configuracion

### Variables de entorno

El motor de resumen incremental puede consultar proveedores de modelos compatibles mediante variables de entorno genericas. Configura la credencial correspondiente segun el proveedor deseado:

- `OPENCODE_ZEN_API_KEY`: Clave para servicios de inferencia OpenCode Zen.
- `OPENROUTER_API_KEY`: Clave para enrutamiento de modelos mediante OpenRouter.
- `OPENAI_API_KEY`: Clave para proveedores con interfaz compatible con OpenAI.
- `NVIDIA_API_KEY`: Clave para catalogo de inferencia NVIDIA NIM.

### Opciones en opencode.json

Las opciones se especifican en el segundo elemento de la declaracion del plugin:

| Parametro        | Tipo    | Valor por defecto  | Proposito                                                                            |
| ---------------- | ------- | ------------------ | ------------------------------------------------------------------------------------ |
| `model`          | string  | `"big-pickle"`     | Identificador del modelo utilizado para la generacion incremental de resúmenes.      |
| `temperature`    | number  | `0.1`              | Temperatura de muestreo para las llamadas de resumen.                                |
| `maxEpisodes`    | number  | `4`                | Cantidad maxima de episodios conservados en el estado activo antes de consolidacion. |
| `maxStateTokens` | number  | `5000`             | Limite estimado de tokens para el bloque de estado inyectado en el contexto.         |
| `logging`        | string  | `"info"`           | Nivel de registro en terminal (`debug`, `info`, `warn`, `error`).                    |
| `storageDir`     | string  | `".session-state"` | Nombre de la carpeta local dentro del proyecto donde se persisten los estados.       |
| `injection`      | boolean | `true`             | Determina si el estado se inyecta automaticamente en cada turno de conversacion.     |
| `autoSummary`    | boolean | `true`             | Determina si el motor de resumen incremental por LLM se ejecuta automaticamente.     |

## Limitaciones

- No sincroniza el estado entre distintas maquinas ni instancias remotas.
- No comparte estado entre proyectos diferentes; cada proyecto mantiene su propio directorio `.session-state` de forma aislada.
- No expone datos de la sesion fuera del directorio local del proyecto.
- No utiliza MemPalace ni bases de datos remotas.

## Tipos

Las declaraciones de tipos publicadas (`dist/index.d.ts`) corresponden al contrato de dominio v1 y a las estructuras internas de estado, no a la superficie de hooks v2 del runtime de OpenCode.

## Compatibilidad v1 y v2

El entrypoint publicado y soportado es el v2 (`index.js`). El entrypoint v1 (`dist/plugin.js`) permanece incluido en el paquete por compatibilidad de distribucion previa, pero no constituye un punto de entrada soportado en esta version v2.

## Licencia

Este proyecto esta licenciado bajo los terminos de la GNU General Public License v3.0:
[https://www.gnu.org/licenses/gpl-3.0](https://www.gnu.org/licenses/gpl-3.0)

## Autoria y Enlaces

- **Autor**: Diego / `tmogeid`
- **Repositorio**: [https://github.com/tmogeid/opencode-session-state](https://github.com/tmogeid/opencode-session-state)
- **Seguimiento de problemas (Issues)**: [https://github.com/tmogeid/opencode-session-state/issues](https://github.com/tmogeid/opencode-session-state/issues)
- **Versiones publicadas (Releases)**: [https://github.com/tmogeid/opencode-session-state/releases](https://github.com/tmogeid/opencode-session-state/releases)
