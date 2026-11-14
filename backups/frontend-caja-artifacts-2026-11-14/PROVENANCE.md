# Respaldo de artefactos productivos — SoftVenta POS Caja

## Qué contiene y cómo se obtuvo

`frontend-static/` es una reconstrucción exacta, a nivel de archivos estáticos, del shell POS servido actualmente. Se armó desde la captura previa de producción (`BASE-CAPTURE-MANIFEST.sha256`, 46 rutas), se reemplazaron `index.html`, `connected-sales.js` y `service-worker.js` y se agregó `cash-order-search.js` desde los archivos publicados del candidato de Caja. Luego se verificaron los 47 archivos contra respuestas HTTP actuales, comparando SHA-256 de los bytes crudos. Los 43 archivos sin overlay coinciden con la captura base; los 4 del candidato coinciden con los hashes que el usuario verificó en `http://127.0.0.1:8080`.

Los hashes están en `PRODUCTION-FRONTEND-MANIFEST.sha256`. `provenance/Dockerfile.frontend` y `provenance/CANDIDATE-MANIFEST.sha256` conservan la receta/manifest del overlay; no se incluyen dentro de `frontend-static/`.

## Por qué los hashes previos parecían diferentes

La comparación anterior tomó `Invoke-WebRequest.Content`, que PowerShell entrega como texto, y volvió a codificarlo con UTF-8 antes de calcular el hash. Eso no preservó los bytes recibidos: las respuestas no indicaban `charset` en `Content-Type`. Para `connected-sales.js`, el cuerpo crudo fue 63,482 bytes y su re-serialización 63,726; para `index.html`, 200,038 frente a 201,192. En la verificación correcta se hasheó `RawContentStream`. Los cuatro recursos se compararon nuevamente y coinciden exactamente con el candidato y con los hashes suministrados desde Contabo. No hay evidencia de que el servidor hubiera cambiado; el fallo fue el método anterior de hash.

## Imágenes y procedencia backend

Frontend en ejecución informado por el usuario: `sha256:386c44569686da7e8235951344adaa158168cfb94fbe4e411146e8161075149f`.

Backend en ejecución informado por el usuario: `sha256:19d7cfbbf47c47b736fcb24d32c83e239e923ae8a796020a4006cced264fde34`.

El repositorio contiene el `Dockerfile.backend` del overlay `billing-favicon`: construye desde una imagen base y etiqueta `org.softventa.billing-favicon.backend-base-image-id` y `org.softventa.billing-favicon.package-sha256`. El `backend.patch` contiene secciones de diff sin hunks de cambios y el README del overlay describe que no cambia código backend ni esquema. Estas etiquetas identifican imagen base y paquete, no un commit Git. No se obtuvo una exportación de la imagen backend ni hay etiqueta OCI de revisión, por lo que este respaldo no puede identificar su fuente Git.

## Estado de Git y migraciones

El remoto consultado apunta `release/v1.0.0-rc.6` a `ff098283b904e849be6ebe23ac3bbc08443ca733`; el tag limpio contiene migraciones 001–020. El branch local `release/v1.0.0-rc.6` está en `6c25b3aa8a617dfedcf7d67549308775391e4146`, siete commits por delante, incluyendo cambios de categorías y administración. En el árbol local están además los archivos 022 y 023 y modificaciones pendientes, que no se copiaron a este paquete.

El estado productivo 001–022 aplicadas y 023 pendiente proviene de la información del usuario. El código Git exacto que produjo el backend actual no se puede demostrar con la evidencia disponible. No se inventó SHA de origen ni se creó commit/tag `v1.0.0-caja-estable`.

## Exclusiones y limitaciones

No se incluyen imágenes Docker completas, backend fuente/binario, migraciones SQL, `.env`, credenciales, archivos sensibles, clientes, ventas, datos reales ni respaldos MySQL. Tampoco se incluye migración 023, permisos personalizados pendientes ni importación Excel.

Este paquete sí es un respaldo verificable de los 47 artefactos estáticos del POS. No es una reconstrucción Git del sistema completo ni un respaldo de base de datos. Para completar una versión fuente reproducible falta la revisión/origen del backend base o un export de la imagen con metadatos que permitan mapearla a código, además de resolver qué cambios de categoría/administración de la rama local están realmente desplegados.