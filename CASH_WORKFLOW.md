# Caja local y conectada: venta directa o centralizada

Fecha: 3 de octubre de 2026.

## Implementación

En Caja, el selector del negocio ofrece **Venta directa** y **Caja centralizada** en ambas modalidades. Venta directa conserva el cobro desde Punto de Venta. En caja centralizada, el botón pasa a **Enviar a Caja**; prepara una orden pendiente sin factura, descuento/reserva de stock ni dinero. Un usuario autorizado para Caja revisa y cobra la orden.

El modo local guarda `salesFlow` en `posSystemConfig` (localStorage) y las órdenes en la tabla Dexie `saleOrders`. La versión 10 de Dexie añade esa tabla conservando las tablas anteriores. El módulo `local-cash-flow.js` se detiene inmediatamente en modo conectado: no lee ni escribe operaciones conectadas en Dexie. El flujo conectado conserva MySQL, sesión autenticada, configuración por negocio e idempotencia del backend; requiere la migración 003 existente, sin nueva migración SQL.

El cobro local se confirma en una transacción Dexie que incluye factura, stock, Kardex, cuenta del cliente cuando corresponde, caja, orden y auditoría. Comprueba nuevamente caja abierta, estado y disponibilidad de productos, precios, descuento y estado pendiente de la orden. Un segundo cobro concurrente no genera otra factura. Un fallo al guardar auditoría revierte los cambios financieros. Cancelar una orden solo cambia su estado y registra auditoría.

Caja revisa el precio vigente antes de cobrar. Si cambia el total desde la preparación, muestra el estimado y el actual; si cambia después de revisar, rechaza el cobro y pide revisar nuevamente. La venta conserva vendedor y cajero. Caja recarga las órdenes al entrar, incluidas las preparadas en otra pestaña del mismo navegador.

Efectivo nace confirmado y suma una sola vez al esperado físico. Tarjeta y transferencia nacen pendientes, aparecen en Caja y pueden confirmarse allí con usuario y fecha. Confirmar no aumenta el efectivo físico. Las ventas conservan el turno para cualquier medio. Los movimientos asociados a una venta se confirman junto con ella; sus correcciones/anulaciones se gestionan desde la factura, evitando editar dinero de una factura desde un movimiento genérico. Una venta bancaria ya confirmada requiere un flujo de reembolso externo antes de anularla, igual que el modo conectado.

Venta directa y cobro de órdenes exigen caja abierta. Se conserva el mensaje exacto **Debes abrir caja antes de facturar o cobrar**, incluyendo cierre ocurrido después de revisar el cobro. Preparar o cancelar una orden no requiere caja abierta. El cambio de flujo exige caja cerrada y sin órdenes pendientes, igual que el backend existente. Guardar o restablecer los demás datos del negocio conserva el flujo vigente.

El crédito y los abonos locales existentes siguen funcionando y mantienen su validación de caja. No se habilitan clientes/crédito/abonos conectados ni compras conectadas en esta tarea. PHASE54.md conserva únicamente el análisis inicial de la solicitud anterior.

## Skill y revisión de interfaz

Skill utilizada: [.agents/skills/emil-design-eng/SKILL.md](.agents/skills/emil-design-eng/SKILL.md). Se reutilizan modales, estilos, permisos y componentes del proyecto. El modal local conserva foco y errores de campo accesibles; los botones tienen tipos explícitos. No se agregan animaciones de cobro.

| Before | After | Why |
| --- | --- | --- |
| Selector de flujo visible solo en conectado | Venta directa / Caja centralizada en ambos modos | Permitir trabajar con órdenes sin backend |
| Venta local siempre cobraba desde POS | Enviar a Caja cuando el negocio activa centralizada | Distinguir preparación de facturación |
| Efectivo local pendiente; pagos bancarios sin confirmación de venta | Efectivo confirmado y tarjeta/transferencia pendientes confirmables | Registrar el estado real sin inflar efectivo |
| Lectura local tardía podía restablecer el selector | Selector deshabilitado durante la lectura | Conservar la selección del usuario |
| Confirmar conectado podía pulsarse durante recotización | Botón deshabilitado hasta obtener el precio vigente; foco restaurado después | Evitar perder un clic mientras cambia la cotización |
| No existía revisión de cobro de órdenes locales | Total, detalle, medio, recibido y error accesible en escritorio y móvil | Revisar y corregir antes de confirmar |

Capturas finales revisadas: `test-results/local-order-1280.png` y `test-results/local-order-390.png`. Controles visibles sin desbordamiento horizontal. La inspección detectó dos etiquetas con acentos dañados por la herramienta de edición; quedaron corregidas y se regeneraron las capturas.

## Archivos

- `app.js`: tabla Dexie adicional, puente al cobro local transaccional, conservación de configuración, confirmación de movimientos de venta y conciliación.
- `local-cash-flow.js` (nuevo): configuración, órdenes, recotización, cobro, cancelación y confirmación local.
- `index.html`: selector común, etiquetas y modal de cobro local.
- `connected-sales.js`: etiqueta Enviar a Caja y bloqueo/foco durante recotización.
- `scripts/build-static.cjs`, `backend/scripts/test-connected.cjs`: allowlist pública ampliada para el módulo local.
- `tests/local-cash-flow.spec.cjs` (nuevo): 15 casos de flujos, estados de pago, recarga, caja cerrada, precios, concurrencia, rollback, pestañas y accesibilidad.
- `tests-connected/sales.spec.cjs`: etiqueta actualizada y tres regresiones de caja cerrada para pedidos CASH/CARD/TRANSFER, con aislamiento Dexie.
- `tests/login.spec.cjs`: una expectativa sustituida por el efectivo confirmado al cobrar.
- `CASH_WORKFLOW.md`, `PHASE53.md`: informe y alcance actualizado. `dist` regenerado con los 12 archivos públicos permitidos.

## Pruebas y correcciones

Se conservaron todos los casos anteriores. La prueba de Caja que antes pulsaba Confirmar sobre efectivo ahora comprueba que ya está confirmado y que no ofrece esa acción. Este cambio de expectativa corresponde expresamente al requisito solicitado; sus comprobaciones de importe, crédito, abonos y efectivo permanecen.

La primera ejecución completa detectó regresiones de identificadores numéricos de clientes y formato de auditoría; se corrigió el producto sin eliminar ni relajar pruebas. Las pruebas nuevas detectaron la carrera del selector al cargar Caja; se corrigió bloqueando el control durante la lectura. El caso conectado de efectivo ahora captura el recibido después de la cotización inicial, sin repetir innecesariamente la selección del mismo método. No se aumentaron tiempos ni se forzaron clics.

| Comprobación | Resultado |
| --- | --- |
| ESLint completo | 0 errores, 0 advertencias |
| Backend unitario | 57/57 aprobadas |
| Integración MySQL aislada | 90/90 aprobadas; base temporal eliminada |
| Navegador local y fixtures HTTP conectados | 169/169 aprobadas, 3.5 minutos; 154 anteriores + 15 nuevas |
| Regresiones nuevas de pedidos conectados | 3/3 aprobadas; base temporal eliminada |
| Navegador conectado completo | 65/65 aprobadas, 2.0 minutos; 62 anteriores + 3 nuevas; base temporal eliminada |
| Regresión final de configuración y flujo local | 22/22 aprobadas, 29.0 segundos, tras conservar datos/moneda al guardar el flujo inicial |
| Build público | 12 archivos permitidos, idénticos a sus fuentes |
| git diff --check | Sin errores; avisos habituales LF/CRLF |
| database/schema.sql | Sin diferencias |

Comandos: `eslint .`; `npm test --prefix backend`; `npm run test:integration --prefix backend`; `playwright test --workers=2 --reporter=line --output=test-results-cash-flow-final`; `npm run test:frontend --prefix backend`; `node scripts/build-static.cjs`; comparación exacta de allowlist/contenido de dist; `git diff --check`. Los servidores de pruebas sirven solo dist.

## Prueba manual

1. Entrar en local con un usuario autorizado para Caja. Con caja cerrada y sin órdenes pendientes, ir a Caja, escoger Caja centralizada y Guardar flujo.
2. Ir a Venta, agregar un producto y pulsar Enviar a Caja. Verificar que no hay factura ni cambio de stock. Recargar y comprobar que la orden sigue pendiente en Caja.
3. Intentar Cobrar con caja cerrada: debe aparecer el mensaje obligatorio. Abrir Caja, pulsar Cobrar, revisar total vigente y pagar en efectivo. Verificar factura, stock, movimiento confirmado y efectivo esperado.
4. Preparar otras órdenes y cobrarlas con tarjeta y transferencia. En Caja, confirmar cada pago y comprobar que el efectivo esperado permanece igual.
5. Preparar y cancelar una orden: stock, facturas y dinero deben permanecer sin cambios. Cerrar Caja y volver a Venta directa. El botón será Procesar / Cobrar Venta.
6. En conectado, repetir la selección del flujo y el circuito con la cuenta existente y el backend habilitado con 003. Revisar atribución de vendedor/cajero y confirmar tarjeta/transferencia desde Caja. No se escriben órdenes ni ventas en Dexie.

No se hicieron commits ni despliegues, no se cambiaron cuentas existentes, no se modificó database/schema.sql y no se aplicaron migraciones a la base principal. La validación usa datos de prueba; no se realizó una venta real.

La revisión final corrigió el guardado inicial del flujo para preservar moneda y datos predeterminados después de recargar. Se repitieron las 22 pruebas afectadas de configuración y flujo local sobre ese build. Todas las bases MySQL temporales de las ejecuciones se eliminaron, incluidas las suites fallidas. El servidor público temporal de esta tarea se detuvo tras verificar.


## Corrección de moneda en configuraciones antiguas

La palabra `undefined` aparecía porque algunas preferencias locales antiguas solo guardaban `salesFlow`, sin `currency`. La lectura ahora completa los campos predeterminados y repara monedas ausentes, vacías o inválidas; conserva datos del negocio, flujo de caja y una moneda personalizada válida. No borra ventas ni almacenamiento local. El carrito vacío también se actualiza con la moneda cargada al iniciar.

Skill aplicada: [emil-design-eng](.agents/skills/emil-design-eng/SKILL.md).

| Before | After | Why |
| --- | --- | --- |
| Importes mostraban `undefined` cuando faltaba la moneda. | Los importes usan `C$` por defecto o la moneda válida configurada, incluso tras recargar. | Completar preferencias parciales evita interpolar un valor inexistente. |

Validación específica: seis regresiones nuevas de moneda; 28/28 pruebas de configuración, moneda y flujo local; 3/3 regresiones conectadas con base MySQL temporal eliminada; ESLint y comparación exacta del build público aprobadas.
Validación final de esta corrección: suite completa local y fixtures conectados, 175/175 aprobadas (3.7 minutos). Sin commits ni migraciones.
