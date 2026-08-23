# Changelog

## v1.1.4

- fix: consistencia disco↔memoria — getCachedState relee el estado en disco en cada acceso (disco autoritativo sobre cache); persist aborta escrituras stale cuando el disco es más nuevo o fue corregido externamente, recargando desde disco. Fix menor: string de versión del log actualizada.
