# Productos e inventario: contrato de la fase 5.2

No se modifica database/schema.sql ni se requiere una migracion nueva. Se utilizan products, inventory_movements y audit_logs, junto con las sesiones y autorizaciones existentes. No se importan productos de Dexie ni se modifican usuarios reales.

Todas las rutas llevan /api. IDs BIGINT se transmiten como cadenas decimales. Los valores DECIMAL se devuelven como cadenas exactas; las escrituras aceptan cadenas decimales o numeros finitos representables con la precision documentada. No se truncan decimales adicionales ni se aceptan notacion exponencial, NaN, campos desconocidos, businessId/business_id, userId ni deleted como autoridad de escritura.

| Metodo / ruta | Permiso | Resultado |
| --- | --- | --- |
| GET /catalog/products?limit=100&offset=0&search=texto | Sesion; acceso a Ventas | Catalogo activo, precios y stock; sin costos, margenes ni impuesto privado |
| GET /products?limit=100&offset=0&search=texto | ADMIN o permiso inventory | Productos propios, incluidos inactivos; excluye archivados |
| GET /products/:id | ADMIN o permiso inventory | Producto propio y revision |
| GET /products/:id/stock | ADMIN o permiso inventory | productId, businessId, stock, minStock y revision |
| POST /products | ADMIN o permiso inventory + CSRF | 201; producto y movimiento INITIAL si stock es distinto de cero |
| PATCH /products/:id | ADMIN o permiso inventory + CSRF | Producto editado; requiere revision y al menos un campo |
| POST /products/:id/movements | ADMIN o permiso inventory + CSRF | 201; ajuste o merma y producto actualizado |
| GET /inventory/movements?productId=ID&limit=100&offset=0&maxId=ID | ADMIN o permiso inventory | Historial propio, mas reciente primero; filtros productId/maxId opcionales |

limit: 1 a 100. offset: 0 a 9999999. search: hasta 180 caracteres, si se proporciona no puede estar vacio. maxId fija el limite superior del historial: tomar el primer ID de la primera pagina y reutilizarlo en las siguientes para evitar desplazamientos por movimientos nuevos. El frontend aplica este mecanismo y recorre todas las paginas.

## Cuerpos y campos

POST /products requiere barcode, name, category, cost, marginRetail, marginWholesale, retailPrice, wholesalePrice, stock y minStock. Opcionales: active (true), image (null), taxRate (0.0000). PATCH admite esos mismos campos junto con revision; nunca permite cambiar el negocio ni el identificador del producto.

- barcode: maximo 100 caracteres; name: 180; category: 100. Se recortan espacios exteriores y se rechazan caracteres de control.
- cost, retailPrice, wholesalePrice: 0 a 9999999999.99, dos decimales.
- stock, minStock: 0 a 999999999.999, tres decimales.
- marginRetail, marginWholesale: -999.9999 a 999.9999; porcentajes comerciales, cuatro decimales.
- taxRate: 0 a 999.9999, cuatro decimales; se conserva al editar aunque el formulario no lo muestre.
- active: booleano.
- image: null o referencia privada /api/product-images/<businessId>/<nombre-aleatorio>.jpg. Fotografias binarias se cargan por separado; Base64 y URLs externas nuevas se rechazan. El JSON de productos vuelve al limite general configurable, 16 KiB por defecto. Contrato, almacenamiento y operacion en PRODUCT_IMAGES.md.

La interfaz conserva sus formulas costo + costo * margen / 100 y margen inverso por precio. El servidor guarda los precios y margenes explicitamente recibidos, sin volver a calcularlos ni sustituir un precio manual. En frontend los decimales se convierten a Number para mostrar los mismos campos existentes; las escrituras del formulario envian sus cadenas, y la aritmetica de stock del servidor utiliza enteros BigInt escalados.

POST /products/:id/movements requiere type, quantity y reason (hasta 500 caracteres):

- ADJUSTMENT: quantity distinto de cero, positivo o negativo.
- WASTE: quantity positivo; el servidor registra el delta negativo.

INITIAL y MANUAL_EDIT son generados por el servidor. No se aceptan movimientos SALE, PURCHASE ni sus anulaciones en esta etapa. La interfaz mantiene Ajuste positivo y Merma y permite hasta tres decimales en modo conectado; el modo local conserva sus controles originales.

## Integridad y seguridad

Todas las consultas usan el negocio y usuario de req.auth; ninguna escritura permite elegirlos desde el navegador. Sesion activa y permiso inventory se verifican al entrar y dentro de la transaccion, despues de obtener los bloqueos y antes del commit. Se respeta el limite absoluto de sesion y el vencimiento del permiso. Una autorizacion para purchases u otro modulo no habilita inventory. El catalogo de Ventas no permite modificar stock ni obtener costos.

El servicio reutiliza repo.tenant, que bloquea el negocio y revalida la sesion, y SELECT FOR UPDATE para el producto. Stock, movimiento y auditoria se confirman juntos o se revierten juntos. El usuario responsable se guarda en inventory_movements.user_id; las claves compuestas existentes comprueban el negocio.

La clave unica de MySQL protege los codigos de barras incluso cuando hay solicitudes simultaneas, productos inactivos o archivados. La colacion existente tambien considera iguales las variantes de mayusculas/acentos. Inactivar no elimina productos, stock ni historial. No hay endpoint de borrado.

revision es SHA256 de la representacion persistida del producto y updated_at; es una precondicion de edicion, no una credencial. Se compara con la fila bloqueada. Un formulario obsoleto devuelve 409 PRODUCT_CONFLICT y debe volver a abrirse tras consultar el inventario. Los ajustes envian deltas, que se aplican al stock actual bloqueado, evitando perdidas de actualizaciones.

Errores publicos: 400 INVALID_INPUT/STOCK_LIMIT, 401 INVALID_SESSION, 403 MODULE_FORBIDDEN/CSRF_FAILED, 404 PRODUCT_NOT_FOUND, 409 BARCODE_EXISTS/PRODUCT_CONFLICT/INSUFFICIENT_STOCK/PRODUCT_ARCHIVED/RETRY_OPERATION, 413 limite JSON, 415 JSON_REQUIRED y 500 INTERNAL_ERROR o 503 DATABASE_UNAVAILABLE. Sin SQL, stack ni credenciales.

## Limites de esta etapa

El bloqueo del negocio serializa las operaciones de cada negocio para priorizar integridad; limita el rendimiento bajo cargas altas y debe revisarse antes de una escala mayor. No hay sincronizacion offline, suscripcion a cambios ni reenvio automatico por errores de red. Actualizar inventario, navegar nuevamente al modulo o recargar consulta el servidor.

Una respuesta perdida puede corresponder a una escritura confirmada. El frontend elimina el listado antiguo y exige actualizar antes de otra escritura tras un error ambiguo. Comprobar el Kardex antes de repetir un ajuste. No se implementa idempotencia distribuida; no debe habilitarse una cola automatica sin incorporarla.

El proveedor opcional del formulario local no tiene columna ni relacion en products. Esta oculto, deshabilitado y explicitamente excluido de la validacion del formulario en modo conectado; no se descarta silenciosamente un valor enviado: la API rechaza supplier como campo desconocido. La integracion futura de proveedores debera definir su relacion y justificar una migracion si corresponde. El modo local conserva su proveedor.
