# Etapa 3: revisión previa de créditos y abonos históricos

Fecha: 17 de octubre de 2026, America/Managua. Base: `pos_multitenant`. Destino identificado por auditorías: negocio **5, Prueba De Migracion**. Paquete: `prueba-compras.json`, POS DISTRIBUIDORA, exportado el 15 de octubre de 2026 a las 14:35:45.665 UTC.

**Dictamen:** SQL 010 es compatible con el esquema inspeccionado. Las tres facturas de Diana y sus abonos no existen en el destino. La conciliación reconstruye C$106.10 facturados y pagados, con saldo C$0.00. La aplicación real sigue pendiente de autorización y de confirmar expresamente el otro origen histórico presente en el destino.

## Método y límites

Las consultas a la principal se hicieron mediante una conexión dedicada, con `SET TRANSACTION READ ONLY`, `START TRANSACTION WITH CONSISTENT SNAPSHOT` y cierre con `ROLLBACK`. Se leyeron metadatos, auditorías y datos del destino; no se ejecutaron DDL, INSERT, UPDATE, DELETE ni bloqueos FOR UPDATE sobre la principal. No se crearon sesiones, cambiaron cuentas ni invocaron endpoints de importación reales.

La conciliación usa el cálculo puro del producto y una reproducción **offline** del servicio de preparación sobre la copia de datos leída. La identidad administrativa del harness es un fixture, sin autoridad sobre el backend real: no es una sesión autenticada ni una autorización de escritura. No se encontró sesión administrativa vigente para realizar una comprobación autenticada real. La proyección de columnas de SQL 010 se hizo exclusivamente en memoria y se distingue del estado actual.

No se modificó código funcional, pruebas existentes, Dexie ni `database/schema.sql`. No se hizo commit, despliegue ni trabajo nuevo de CxP o caja histórica. Las escrituras de pruebas ocurrieron exclusivamente en bases temporales `pos_auth_test_*` validadas.

## Compatibilidad del SQL 010

- MySQL real: **8.0.46**; tablas examinadas InnoDB.
- Existen `sales`, `customer_payments`, `migration_sales_references` y las columnas de anclaje `status`, `source_sale_id`, `sale_id`.
- No existen las cinco columnas nuevas ni la tabla `migration_credit_payment_references`: no se detectó aplicación parcial de 010.
- Los dos índices nuevos no colisionan con los existentes. Los nombres de las dos claves foráneas nuevas están disponibles.
- `businesses.id`, `customer_payments.business_id` e `id` usan BIGINT UNSIGNED; existe la clave única compuesta `(business_id,id)` requerida por la nueva referencia.
- Las relaciones actuales separan negocios; la relación de abonos a venta también incluye cliente. Las restricciones de importes/tipo de venta son compatibles con CREDIT/CREDIT, importes positivos y las asignaciones propuestas.
- Los campos `cash_session_id` permiten NULL; `customer_payments.status` admite POSTED/VOID/PENDING. Los IDs originales caben en VARCHAR(100) y conservan decimales como texto.
- No hay triggers en el esquema principal. Las 28 referencias de ventas del destino tienen venta correspondiente; no se encontraron huérfanas.
- Comprobación adicional: se clonaron **solo las definiciones de las 27 tablas reales**, sin registros, a `pos_auth_test_6db46d3f67ba4a6fae31ec53`; los cuatro enunciados de SQL 010 se ejecutaron correctamente allí. La base se eliminó.

SQL 010 no es idempotente ni atómico: el DDL produce confirmaciones implícitas. Una interrupción requiere inspección por enunciado, sin repetir todo el archivo. Añadir columnas con DEFAULT 0 asigna esa marca a filas existentes; no reclasifica como históricas las ventas anteriormente importadas. El índice nuevo puede requerir bloqueos de metadatos durante la aplicación. La prueba de compatibilidad no mide esa duración bajo carga real.

## Datos y conflictos

Diana corresponde de forma única al cliente **7** del destino. Su `opening_balance` es **0.00**; todos los clientes del destino tienen saldo inicial cero. No se creará otro cliente ni deuda inicial.

| Factura original | ID local de venta | Abono local | Total | Aplicado | Saldo |
| --- | --- | --- | ---: | ---: | ---: |
| 14 | 1791566528809.0999 | 1791589247499 | C$25.00 | C$25.00 | C$0.00 |
| 15 | 1791568268165.8977 | 1791589262785 | C$43.70 | C$43.70 | C$0.00 |
| 16 | 1791568270913.1567 | 1791589274443 | C$37.40 | C$37.40 | C$0.00 |
| Total | | | **C$106.10** | **C$106.10** | **C$0.00** |

Destino: **28 ventas, todas CASH; 0 ventas CREDIT; 0 abonos de clientes; 28 referencias de ventas**. De ellas, 24 corresponden a POS DISTRIBUIDORA y cuatro al origen anterior Prueba De Migrar. Las auditorías de la importación de 24 ventas mencionan expresamente que se omitieron las facturas de crédito 14, 15 y 16.

No coinciden sus IDs de origen con referencias existentes. Tampoco existen los números internos previstos `MIG-14-44ccb9eafe612e5269afa710f704`, `MIG-15-44ccb9ea24a6de56f397d28ba25b` y `MIG-16-44ccb9eab992524bbe7c57fb7aef`, ni candidatos por combinación exacta de fecha e importe. No hay abonos a duplicar porque la tabla del destino está vacía. Coincidir solo en monto con una venta de contado no constituye identidad documental.

**Conflicto real pendiente:** el destino mezcla dos orígenes. La preparación produce `OTHER_ORIGIN` y `sourceOriginConflict.required=true`. No es una duplicación demostrada de Diana; requiere revisión y confirmación expresa `confirmDifferentSource=true` antes de importar.

## Conciliación y efectos previstos

El paquete contiene tres abonos de clientes y cuatro de proveedores. Solo los tres primeros pertenecen a esta etapa. Sus estados locales `pendiente` ya reducen la deuda: deben guardarse como **POSTED**, con `source_status=pendiente`, sin ingreso nuevo de caja. No deben volver a cobrarse ni confirmarse como pendientes.

Saldo declarado de Diana: 0.00; deuda sin factura: 0.00; saldo reconstruido: 0.00; diferencia: **0.00**. Las correspondencias de clientes y productos son únicas y las asignaciones de los tres abonos cubren exactamente sus facturas.

| Preparación | Resultado |
| --- | --- |
| Esquema actual real | `schema=false`, `eligible=false`, `canImport=false`; bloqueo por falta de SQL 010 |
| Proyección offline después de 010 | Todos los gates verdaderos; 3 facturas y 3 abonos importables, 0 ya importados; persiste confirmación por otro origen |

La segunda fila no demuestra que 010 esté aplicada ni autoriza importación. Los prerrequisitos de importación básica e inventario inicial del origen constan en auditorías; no es necesario repetir esas etapas.

El importador escribe únicamente ventas, detalles, abonos, referencias y auditoría, dentro de una transacción. No actualiza clientes, productos, stock, secuencias documentales ni usa el servicio de venta/cobro operativo. Ventas y abonos nuevos llevarían `is_historical=TRUE` y `cash_session_id=NULL`. Caja excluye esas marcas de operaciones y colecciones; no se crean movimientos pendientes de cobro. La integración verifica también su exclusión de Caja.

Línea base del destino, recomprobada sin cambios: **2 movimientos de inventario/Kardex, 0 sesiones de Caja, 0 movimientos de Caja, 55 detalles de venta** (serían 59 después de las cuatro líneas históricas propuestas). Stocks: producto 7 = 8.000; 8 = 0.000; 9 = 0.000; 10 = 26.000. El cotejo de stock entre lecturas coincide. La importación propuesta agrega historia financiera y detalles; el incremento esperado en inventario, Kardex, Caja y saldos iniciales es **cero**.

## Navegador y verificaciones

Skill aplicada: `.agents/skills/emil-design-eng/SKILL.md`, para revisar estados, mensajes y prevención de acciones incorrectas. No se hicieron cambios de interfaz ni se alteraron expectativas de pruebas.

Los casos enfocados pasan: **5/5** de vista previa (incluye paquete real, escritorio y móvil, errores de lectura, origen distinto y respuestas tardías) y **1/1** de importación/reintento conectado en MySQL temporal, sin cambios operativos.

| Comprobación | Resultado de esta etapa |
| --- | --- |
| ESLint completo | 0 errores/advertencias |
| Backend unitario | 133 aprobadas, 0 fallos, 1 omitida por archivo anterior ausente |
| Integración MySQL temporal | 109 aprobadas, 0 fallos, 1 omitida; base eliminada |
| Navegador conectado completo | 56 aprobadas, 34 fallidas, sin omitidas; base eliminada |
| Navegador local completo | 173 aprobadas, 34 fallidas, 1 omitida; 5 casos de créditos aprobados también en la corrida completa |
| Build público | 22 archivos permitidos, idénticos a fuentes; sin archivos adicionales |
| git diff --check | Sin errores; avisos LF/CRLF |
| database/schema.sql | Sin diferencias |

| Before | After | Why |
| --- | --- | --- |
| Historial espera C$104.77 y muestra C$79.77 en la suite compartida | Caso aislado aprobado 1/1; revisar filtros y fixtures compartidos | La diferencia C$25.00 coincide con la factura de otro periodo; compara reporte sin filtro con vista filtrada |
| Ticket fraccionario busca spans de C$5.01 | Snapshot muestra ambos C$5.01 en strong | Selector ligado al marcado anterior; no evidencia redondeo a C$5.00 |
| Fixtures HTTP del POS dejan #app oculto | Registrar fallo antes de entrar al flujo | No alcanza el importador; el caso conectado real de prueba autentica y completa el flujo |
| Descargas/reportes agotan tiempo; otros casos fallan en clientes y conteos | Mantener pendiente el diagnostico funcional separado | No descartarlos como simples cambios de texto; no aparecen en los seis casos de creditos historicos |
| Crédito operativo espera `Saldo Pendiente`; ticket muestra `Saldo pendiente` | Registrar discrepancia textual; no cambiar durante esta auditoría | Ese fallo no demuestra error de deuda ni duplicación histórica; la prueba se detiene en la etiqueta |
| Inventario y gastos esperan la palabra `MySQL` en alertas que ahora usan mensajes de usuario | Separar fallos de expectativas de los controles financieros | No afecta la preparación histórica; no permite afirmar que las verificaciones posteriores de esos casos hayan corrido |
| Dashboard intenta leer JSON de un archivo que comienza con `PK` | Registrar incompatibilidad de formato de exportación | XLSX se está interpretando como JSON; es ajeno a la importación de créditos |
| Exportaciones esperan tres botones y encuentran cinco | Registrar expectativa/selector desactualizado para revisión propia | No prueba un error contable |
| Compras históricas espera dos importables y obtiene uno | Mantener pendiente su diagnóstico funcional | Es otro importador; no clasificarlo como simple texto ni avanzar a CxP |

Listado completo de casos fallidos y mensajes: `.codex/credit-stage3-local-failures.json` y `.codex/credit-stage3-connected-failures.json`. Las pruebas se ejecutaron con un worker por suite; los errores no se atribuyen automáticamente a concurrencia ni a CDN sin evidencia específica.

Los fallos generales preceden a cualquier cambio funcional de esta auditoría. Sin una línea base del mismo commit no se atribuye su origen histórico con certeza. No se declara toda la aplicación aprobada solo porque pasan los casos de créditos.

## Riesgos y pasos propuestos, todavía sin ejecutar

1. Obtener autorización explícita que identifique `pos_multitenant`, SQL 010, destino **5**, paquete exacto y aceptación del origen anterior **Prueba De Migrar**. Separar aprobación del DDL y de la importación si el usuario lo prefiere.
2. Antes de escribir, revalidar en modo lectura esquema y ausencia de duplicados; conservar SHA-256 del paquete: `13a33f5ea223cd65e200bdcd1ae457e7e1f82140eeca5985041d92d2e2fd9583`. Volver a leer stock, saldos y conteos para detectar cambios posteriores a este snapshot.
3. Programar ventana sin operaciones concurrentes y obtener respaldo íntegro consistente de esquema/datos, con restauración comprobada. El DDL no se revierte con ROLLBACK. No se generó ni restauró un respaldo real en esta etapa.
4. Aplicar exclusivamente los cuatro enunciados de `database/migrations/010_local_credit_migration.sql`, por orden, en conexión cuyo `SELECT DATABASE()` confirme `pos_multitenant`. No ejecutar migraciones anteriores ni el runner de pruebas contra la principal. Si falla un enunciado, detenerse, inspeccionar y diseñar recuperación; no repetir ciegamente.
5. Verificar las cinco columnas, dos índices, tabla nueva y sus claves; confirmar que los conteos y saldos operativos no cambiaron. Reiniciar backend solo si corresponde al proceso de operación y usar el build público verificado.
6. Con sesión **real autenticada** de administración del sistema, CSRF y destino 5, ejecutar de nuevo la vista previa del paquete exacto. Exigir las tres facturas, tres abonos, C$106.10/C$106.10/C$0.00 y ningún bloqueo, además de la confirmación explícita por origen distinto.
7. Solo bajo autorización de importación, invocar una vez `POST /api/system-admin/migration/credit` con destino, paquete y confirmación de origen requeridos por su contrato. La transacción debe crear exactamente 3 ventas, 4 detalles, 3 abonos, 3 referencias de venta, 3 referencias de abono y auditoría; no ejecutar importadores básico, inventario, ventas generales o compras de nuevo.
8. Verificar cliente 7 sin deuda inicial ni saldo nuevo; cada factura totalmente pagada, cada abono POSTED/histórico sin sesión de caja y con estado original pendiente; IDs/fechas/importes conservados, referencias completas y actor real en auditoría. La atribución de las facturas usa el administrador activo destino elegido por el código (actualmente ID 5), no reconstruye al vendedor original.
9. Comparar stocks, movimientos de inventario/Kardex, sesiones/movimientos de Caja y secuencias con el respaldo de control: ninguna diferencia por esta importación. Revisar que Caja no muestre estas facturas o abonos como operaciones cobrables. Comprobar idempotencia mediante vista previa: 3 facturas/3 grupos ya importados. Un reintento de escritura solo si hace falta y está autorizado; no repetirlo como prueba innecesaria en producción.
10. Si hay anomalías, suspender nuevas escrituras y preservar evidencia. No borrar ni corregir registros manualmente sin autorización de recuperación. Mantener CxP y caja histórica fuera de este alcance.

Riesgos restantes: cambios reales después del snapshot, confirmación de mezcla de orígenes, duración/bloqueos y posible aplicación parcial del DDL, sesión real pendiente y fallos generales de navegador. La simulación no sustituye la verificación posterior al DDL ni concede autoridad de negocio desde el paquete.

Evidencia local sin credenciales: `.codex/credit-stage3-readonly.json`, `.codex/credit-stage3-simulation.json`, `.codex/credit-stage3-schema-clone.log` y resultados de pruebas con prefijo `credit-stage3-`.
