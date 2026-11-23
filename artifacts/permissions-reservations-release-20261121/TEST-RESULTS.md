# Verificaciones del paquete

Las pruebas se ejecutaron localmente en el entorno QA aislado, con MySQL 8.4.13 y datos sintéticos. Ninguna consulta o prueba se ejecutó en Contabo. Las etiquetas `sv-softventa-*` son alias locales del mismo par de Image IDs probados.

| Prueba | Resultado |
|---|---:|
| Unitarias de permisos | 6/6 aprobadas |
| MySQL: reservas, concurrencia, catálogo, Productos, reportes, cobro, cancelación, idempotencia, compra, historial y multiempresa | 27/27 aprobadas |
| Reinicio backend con reserva pendiente y cancelación posterior | 3/3 aprobadas |
| Orden de dos productos distintos, reserva y liberación | 3/3 aprobadas |
| MySQL: permisos personalizados + importación Excel/categorías/stock/Kardex | 47/47 aprobadas |
| Playwright Edge: permisos, revocación de sesión, aislamiento y móvil | 29/29 aprobadas |
| Playwright Edge: stock visible, Caja, cancelación, cobro y factura | 14/14 aprobadas |
| Venta directa y crédito en negocio sintético 2 | 5/5 aprobadas |
| Modo local Dexie | 9/9 aprobadas |
| Migration runner `--plan` en QA | solo lectura; 001–022, 024 y 025 aplicadas; 023 ausente |
| SQL preflight/postflight | ambos ejecutados contra MySQL QA aislado, sin mutaciones |
| Exportación/importación del archivo de imágenes | Docker cargó el gzip; IDs coinciden con ambos IDs aprobados |

Las mediciones visuales clave fueron: enviar 2 de 5 unidades dejó 3 disponibles; cancelar devolvió de 3 a 5; cobrar una unidad reservada dejó una disponible después de exactamente un movimiento físico. La prueba de multiartículo reservó simultáneamente una unidad de un producto y dos de otro, y canceló ambas líneas sin alterar su stock físico.

Una corrida intermedia del harness se detuvo porque esperaba HTTP 201 para la cancelación, mientras el endpoint respondió 200 con estado `CANCELLED`. Se corrigió únicamente esa aserción del harness para aceptar 200/201 cuando el resultado confirma cancelación; la repetición final del flujo visual pasó 14/14. Otra repetición pasó 14/14 después de limpiar solo fixtures pendientes creados por ese mismo harness.

Los conteos son suites diferentes y no se suman. Las pruebas no sustituyen el preflight/backup productivo ni la revisión supervisada antes de aplicar migraciones.
