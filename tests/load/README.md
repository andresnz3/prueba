# Pruebas de carga locales aisladas

`compose.yaml`, `seed.cjs` y `k6-pos.js` forman un banco temporal para medir la carga del modo conectado. Compose usa nombres de proyecto y volúmenes independientes, MySQL 8.4.13 y una base `pos_auth_test_<24 hex>`. Solo publica Nginx en `127.0.0.1`; MySQL permanece en una red interna.

La preparación crea diez negocios ficticios Premium con diez usuarios cada uno (un administrador y nueve vendedores), productos con existencias amplias y una caja abierta. Cada usuario virtual inicia sesión, comprueba su identidad y negocio, consulta catálogo, clientes, proveedores, caja y reportes según sus permisos, y luego realiza ventas ficticias. El guion también comprueba el aislamiento entre negocios y reenvía operaciones con la misma clave para revisar la idempotencia.

Las contraseñas de prueba son aleatorias y se escriben solo en archivos temporales privados. El cliente k6 separa los `403` esperados del rol vendedor y los `503` controlados por saturación; cualquier otro error se considera inesperado. El modo `human` añade pausas aleatorias de uno a tres segundos. El modo `burst` omite esas pausas y se utiliza solo para una ráfaga breve.

`LOAD_AUTH_RATE_MAX` ajusta el límite únicamente en el backend temporal. El generador comparte una IP de origen; este ajuste evita confundir el límite por IP con la capacidad de la base al simular cien usuarios. Las reglas normales de autenticación no cambian.

Para una nueva corrida, genere credenciales aleatorias en `private.env`, use un nombre aleatorio de proyecto y base, aplique las migraciones oficiales solo dentro del stack temporal y compruebe las etiquetas antes de borrar sus recursos. No reutilice estas cuentas ni sus datos en producción. Conserve los resúmenes de carga si necesita comparar mediciones posteriores.
