# Reparación de 004 pendiente de aprobación

La inspección de solo lectura de `information_schema` en la base configurada `pos_multitenant` confirmó que todavía faltan todos los cambios de 004:

- `clients.credit_days`, `SMALLINT UNSIGNED NOT NULL DEFAULT 30`, con rango 1–3650.
- `sale_orders.client_id` y `sale_orders.credit_days`, ambos opcionales, con CHECK y FK de cliente por negocio.
- El valor `PENDING` en `customer_payments.status`.

Ya existen `sale_orders`, `sale_order_items`, `pos_operations`, `cash_movements.customer_payment_id`, la FK compuesta al abono y `cash_movements.status`, `confirmed_by_user_id`, `confirmed_at`. Esos elementos son prerrequisitos de 004; no indican que 004 se haya completado.

## Diseño vigente de confirmación

El backend usa `customer_payments.status = POSTED` para abonos confirmados y `PENDING` para tarjeta/transferencia sin confirmar. Efectivo se registra directamente como POSTED y su movimiento de Caja como CONFIRMED. Confirmar tarjeta/transferencia desde Caja cambia el movimiento a CONFIRMED con usuario/fecha y el abono a POSTED en la misma transacción. No requiere columnas `confirmed_*` ni un estado CONFIRMED adicional en `customer_payments`; la información está en el movimiento vinculado.

El servicio de abonos usa `pos_operations` para idempotencia y bloquea la factura dentro de la transacción. Su disponible descuenta tanto los abonos POSTED como las reservas PENDING, impidiendo sobrepago. La reparación conserva esa lógica; no crea, repite ni reclasifica abonos históricos.

## Script preparado

`backend/scripts/repair-credit.cjs` es independiente del ejecutor original. No lee ni repite a ciegas el SQL de 004. Inspecciona columnas, restricciones y claves; genera solamente lo faltante; valida tipos/relaciones/datos antes de aplicar; reinspecciona antes de cada DDL y termina sin operaciones cuando ya está completo. El nuevo PENDING se agrega al final del ENUM para conservar los ordinales de POSTED y VOID. También reconoce el orden de ENUM de la migración original.

Si encuentra tipos, estados, CHECK o FK incompatibles, órdenes parciales con datos ambiguos, sobrepagos, más de un movimiento de ingreso por abono o estados/importe inconsistentes entre abonos y movimientos vinculados, bloquea la aplicación y solicita revisión; no corrige esos datos automáticamente. Las comprobaciones son agregadas y no exponen datos de clientes. No reemplazan una auditoría completa de los datos históricos.

El modo APPLY exige que la base de `.env` coincida con `--expected-database`. Usa un bloqueo asesor para impedir dos reparaciones simultáneas con este ejecutor y limita a cinco segundos la espera por bloqueos de metadatos. Otros procesos no quedan suspendidos por ese bloqueo asesor; aplicar en una ventana sin operaciones de Caja.

Desde la raíz del proyecto, revisar sin cambios:

```powershell
node --env-file=backend/.env backend/scripts/repair-credit.cjs --repair
```

Aplicar **solo después de autorización**:

```powershell
node --env-file=backend/.env backend/scripts/repair-credit.cjs --repair --apply --expected-database=pos_multitenant
```

Verificar después, sin cambios:

```powershell
node --env-file=backend/.env backend/scripts/repair-credit.cjs --verify
```

Ver el esquema completo de solo lectura:

```powershell
node --env-file=backend/.env backend/scripts/repair-credit.cjs --inspect
```

Verificación satisfactoria: `statements`, `blockers` y `dataIssues` vacíos, código de salida 0. Actualmente VERIFY devuelve código 1 y “Esquema incompleto”, como corresponde antes de reparar.

## Riesgos y validación

DDL de MySQL no es transaccional: una interrupción puede dejar cambios parciales, que este ejecutor puede retomar tras reinspección. ALTER puede bloquear o reconstruir tablas según la versión y el tamaño; el plazo de metadatos no limita la duración de la reconstrucción. Mantener un respaldo recuperable antes de aplicar. Los clientes existentes recibirán plazo predeterminado de 30 días al agregar la columna; esto no altera vencimientos de facturas existentes. Si datos históricos incumplen una restricción, no se eliminarán ni cambiarán para forzar la migración.

Se ejecutaron inspección, plan y verificación de solo lectura contra MySQL. El plan devolvió siete DDL propuestos, cero bloqueos y cero inconsistencias detectadas. Las siete pruebas nuevas de la reparación y las 64 pruebas unitarias completas del backend pasaron. ESLint completo y `git diff --check` pasaron. No se ejecutó APPLY, ni se aplicó 004 en bases principales o temporales. La validación de DDL real y la integración/frontend conectado que requieren el esquema reparado quedan pendientes de autorización. No hubo cambios de UI; no se aplicaron skills de diseño.

Archivos de esta tarea: este informe, `backend/scripts/repair-credit.cjs` y `backend/tests/credit-repair.test.cjs`. La migración original, `database/schema.sql`, el código de negocio y los cambios previos del workspace se conservaron. No se hicieron commits.
