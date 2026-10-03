# Fotografias de productos conectados

## Diagnostico y decision de infraestructura

El selector anterior usaba FileReader.readAsDataURL sin compresion. Base64 incrementa los bytes aproximadamente un tercio. La validacion anterior rechazaba textos de imagen superiores a 65000 bytes como INVALID_INPUT antes de llegar a MySQL, cuya columna products.image es TEXT. Productos tenia una excepcion JSON de 96 KiB; una fotografia mayor tambien podia devolver 413. No era necesario ampliar la columna ni elevar el limite general.

Se conserva products.image y se guarda una referencia relativa corta. No hay migracion SQL. Un adaptador guarda JPEG normalizados en un directorio privado independiente, por negocio. El backend es la unica via de lectura: no se publica ese directorio mediante Express.static, Netlify ni Nginx. La configuracion rechaza directorios dentro del repositorio para impedir exposicion incluso al servir la raiz con http-server.

El modo local conserva FileReader, Base64 e IndexedDB sin nuevos limites de imagen. Fotografias conectadas anteriores no se migran ni se borran automaticamente. Se pueden consultar y editar sus otros campos conservando image; al seleccionar otra fotografia se sustituye por la referencia nueva.

## API

| Metodo y ruta | Acceso | Contrato |
| --- | --- | --- |
| POST /api/product-images | Sesion + inventory + X-CSRF-Token | Cuerpo binario; Content-Type image/jpeg, image/png o image/webp. Devuelve 201 con image y businessId |
| GET /api/product-images/:businessId/:name | Sesion de ese negocio | JPEG con no-store; debe estar referenciado por un producto no archivado. Un vendedor solo ve fotografias de productos activos salvo permiso inventory vigente |

El frontend obtiene CSRF y usa cookies como en las otras escrituras. Mantiene File y una vista previa blob solo en memoria; no usa Base64 ni escribe fotografias conectadas en Dexie. Sube la foto y despues crea/edita el producto con la referencia. Editar sin foto nueva omite image y conserva la anterior. Reintentar un formulario rechazado por codigo duplicado reutiliza la carga ya confirmada, sin subir otra copia.

El servidor valida el negocio de la referencia y la existencia del archivo dentro de la transaccion de productos. Los nombres son aleatorios de 128 bits y no dependen del nombre original. Referencias de otro negocio, traversal, rutas externas y archivos inexistentes se rechazan. La descarga vuelve a verificar sesion y pertenencia del producto; conocer el nombre no concede acceso. Las cargas se auditan y se comprueba la autorizacion antes y despues del trabajo, como en inventario.

## Limites y mensajes

- Entrada: JPEG, PNG o WebP estatico, hasta 8 MiB, hasta 40 millones de pixeles. Se contrastan firma, MIME y decodificacion real. SVG, GIF, HEIC, formatos falsos, archivos vacios o danados no se aceptan.
- Salida: JPEG, orientacion corregida, transparencia sobre fondo blanco, hasta 1024 x 1024 sin ampliar, sin EXIF/ICC ni metadatos originales. Calidad 82; si hace falta se reduce a 800 x 800 y calidad 65. Maximo 512 KiB.
- JSON del producto: limite configurable anterior, 16 KiB por defecto; no se incluye el archivo. Solo el endpoint de carga binaria admite 8 MiB.
- Proteccion de recursos: dos cargas por instancia y dos conversiones simultaneas por proceso; treinta intentos por usuario/negocio y minuto, 150 por IP. Los contadores son acotados y locales al proceso. Cuota fija de 256 MiB por negocio, incluidos archivos sin referencia, comprobada bajo bloqueo del negocio.

Errores publicos especificos: IMAGE_TOO_LARGE (413), IMAGE_FORMAT_INVALID (415), IMAGE_INVALID/IMAGE_DIMENSIONS_LIMIT/IMAGE_REQUIRES_UPLOAD/IMAGE_REFERENCE_INVALID (400), IMAGE_NOT_FOUND (404), IMAGE_QUOTA_EXCEEDED (409), IMAGE_BUSY/TOO_MANY_ATTEMPTS (429), IMAGE_STORAGE_UNAVAILABLE (503). Sesion, CSRF y permisos conservan 401/403. No se revelan rutas fisicas, detalles de Sharp ni errores del sistema de archivos. Los mensajes del formulario permiten distinguir estos casos de INVALID_INPUT.

La conversion utiliza Sharp con failOn=warning y limite de pixeles; las opciones siguen la documentacion oficial: https://sharp.pixelplumbing.com/api-constructor/ y https://sharp.pixelplumbing.com/api-output/ . No se conserva el archivo original.

## Operacion local y futuro Contabo

Instalar dependencias con npm.cmd ci --prefix backend y reiniciar npm.cmd run dev --prefix backend. Regenerar el frontend con node scripts/build-static.cjs y recargar el navegador con Ctrl+F5. Por defecto, desarrollo almacena imagenes en <directorio del usuario>/.pos/product-images/<businessId>/, fuera del proyecto; no requiere editar .env.

IMAGE_STORAGE_DIR permite una ruta ABSOLUTA privada distinta. Es obligatoria en NODE_ENV=production. Ejemplo futuro: /var/lib/pos/product-images, persistente entre despliegues y escribible solo por la cuenta del servicio. Directorios nuevos usan permisos 0700 y archivos 0600 donde el sistema los aplica. En Windows comprobar permisos de la cuenta del backend. .env.example solo contiene ejemplos, no credenciales.

Antes de desplegar en Contabo hay que preparar ese directorio/volumen y respaldarlo junto con MySQL. Restaurar solo MySQL deja referencias sin fotografias. El proxy debe admitir 8 MiB especificamente para la carga y no exponer archivos directamente; los limites de las otras rutas no deben ampliarse. No se aprovisiono infraestructura ni se desplego nada en esta etapa. El adaptador permite sustituir almacenamiento local por objetos/S3 despues; multiples servidores requeriran almacenamiento compartido y revisar los limites por proceso.

La carga y el alta del producto son dos solicitudes. Fotografias de formularios cancelados, respuestas perdidas o sustituciones pueden quedar sin referencia; no se sirven y siguen consumiendo cuota. No hay eliminacion automatica de esos archivos ni cola de reintentos; su mantenimiento debe incorporarse antes de una operacion de larga duracion. No borrar archivos manualmente sin contrastar todas las referencias del negocio y disponer de respaldo. Si falla una transaccion durante la carga se intenta eliminar el archivo recien creado. Imagenes ya vinculadas no se borran al inactivar productos.

Las pruebas generan bases pos_auth_test_* y carpetas temporales pos-images-test-* independientes de este directorio. Sus nombres y destinos de limpieza se verifican; no utilizan fotografias, cuentas ni datos reales.

## Archivos de esta correccion

Creados: src/config/images.js, src/services/product-images.js, src/routes/product-images.js, tests/product-images.test.cjs, tests/integration/product-images.test.cjs, tests/helpers/image-fixtures.cjs, ../tests-connected/product-images.spec.cjs y este contrato.

Modificados: src/config/environment.js, src/app.js, src/services/inventory.js, src/services/inventory-values.js, src/routes/inventory.js, src/middleware/errors.js, package.json, package-lock.json, .env.example, .gitignore, scripts/test-connected.cjs, scripts/test-integration.cjs, ../api-client.js, ../app.js, ../connected-inventory.js y documentacion de inventario/fase. Dependencia nueva: Sharp 0.35.5. Se regenera dist; no contiene backend ni fotografias.

## Validacion final

| Comprobacion | Resultado |
| --- | --- |
| ESLint completo | 64 archivos; 0 errores y 0 advertencias |
| Backend unitario | 47/47 aprobadas; 41 anteriores + 6 de fotografias |
| MySQL temporal | 60/60 resultados: 29 escenarios auth + 20 inventario + 8 fotografias + 3 contenedores |
| Frontend local existente | 124/124 aprobadas, 4.0 minutos |
| Navegador conectado/fotografias | 37/37 aprobadas, 1.0 minuto; incluye una prueba adicional de foto local |
| Build publico | 9 archivos permitidos; sin fotografias, backend ni secretos |
| git diff --check | Sin errores |

Cero fallos en las ejecuciones finales. Bases y carpetas temporales eliminadas; no se alteraron datos, cuentas ni fotografias reales. No se modificaron pruebas anteriores para aprobar. No hay migraciones, despliegues ni commits.

Comandos ejecutados desde la raiz:

~~~powershell
.\node_modules\.bin\eslint.cmd .
npm.cmd test --prefix backend
npm.cmd run test:integration --prefix backend
.\node_modules\.bin\playwright.cmd test --workers=1 --reporter=line
npm.cmd run test:frontend --prefix backend
~~~
