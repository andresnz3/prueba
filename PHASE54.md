# Fase 5.4: clientes, credito y cuentas por cobrar conectadas

## Alcance autorizado

La solicitud del usuario confirma Fase 5.3 cerrada y migracion 003 aplicada. Se autoriza implementar clientes, venta a credito, cuentas por cobrar por factura, abonos e historial. No se autorizan commits, despliegues, cambios de cuentas existentes ni migraciones sobre la base principal. Compras conectadas siguen fuera de alcance.

## Analisis inicial

El workspace estaba limpio al iniciar. Leidos PHASE53.md y la skill .agents/skills/emil-design-eng/SKILL.md.

clients ya contiene nombre, telefono, direccion, limite y estado; falta credit_days. sales admite CREDIT, client_id y due_at. customer_payments admite sale_id y una clave compuesta que garantiza que factura y cliente pertenecen al mismo negocio. cash_movements admite referencia a abonos; audit_logs y pos_operations permiten auditoria e idempotencia.

La autoridad financiera debe permanecer dentro de repo.tenant, que bloquea el negocio y verifica la sesion autenticada. El limite se debe comprobar con el saldo vigente dentro de la transaccion de venta, incluyendo opening_balance existente; nunca con deuda enviada por el navegador. La cotizacion y la escritura deben validar cliente activo, caja abierta, productos activos y stock.

Los abonos deben aplicarse a una factura especifica y usar idempotencia con recuperacion de resultados inciertos. Efectivo crea movimiento confirmado; tarjeta y transferencia crean movimiento pendiente y deben excluirse del efectivo esperado incluso despues de confirmarse. El calculo actual de caja solo identifica el metodo mediante sales; debe incorporar customer_payments para evitar sumar abonos bancarios como efectivo.

La deuda puede derivarse de ventas CREDIT completadas menos abonos POSTED. Se debe definir y documentar si un abono bancario pendiente reserva saldo antes de su confirmacion, preservando el control de sobreabonos y la trazabilidad.

Se preparara 004_connected_credit_accounts.sql sin tocar database/schema.sql y sin aplicarla a la base principal. Las pruebas solo podran aplicar migraciones a bases pos_auth_test_* aleatorias validadas y eliminadas al terminar.

La caja central opcional exige conservar cliente y modalidad de credito en el pedido hasta la recotizacion del cajero; no se debe convertir silenciosamente un pedido de credito en contado.

## Estado

Analisis inicial realizado. Implementacion y validacion pendientes. Este archivo no afirma que la Fase 5.4 este completada.
