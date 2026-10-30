# Modo local instalable y sin conexión

## Requisitos de instalación

- Abrí la dirección HTTPS habitual del POS en el mismo navegador y perfil que utilizarás para trabajar. `localhost` también se considera seguro para pruebas locales; abrir el HTML como archivo (`file://`) no sirve para instalar la aplicación.
- En Edge o Chrome, usá **Instalar aplicación** desde el menú del navegador. La primera visita y la primera activación de licencia requieren conexión.
- La instalación queda asociada al origen completo (protocolo, dominio y puerto) y al perfil del navegador. Cambiar de dominio, puerto, navegador o perfil no traslada los datos de IndexedDB.
- Después de instalar, podés abrir el POS desde el ícono. El shell estático se guarda para abrirse sin red; el modo local sigue leyendo y escribiendo sus datos comerciales en IndexedDB.

## Almacenamiento y límites

Cache Storage contiene únicamente archivos públicos estáticos del build (HTML, CSS, JavaScript, iconos, fuentes y bibliotecas incluidas). El service worker excluye `/api`, otros orígenes y solicitudes que no sean `GET`; nunca guarda respuestas API. Ventas, compras, inventario, contraseñas y autorizaciones de licencia no se guardan en Cache Storage.

Al ingresar al POS local, se solicita al navegador almacenamiento persistente cuando la API está disponible. El rechazo no bloquea el uso. La concesión reduce el riesgo de expulsión automática, pero no protege contra borrado manual del perfil, pérdida del disco, daño del navegador o desinstalación de datos.

El modo conectado continúa dependiendo del servidor y no ofrece operaciones comerciales sin conexión. La activación inicial, una transferencia y la consulta de revocación requieren internet. Una licencia permanente ya activada se verifica localmente y permite seguir usando el POS durante una caída de red; una revocación o transferencia solo llega a esa instalación cuando vuelve a conectarse.

La opción **Mejora a Contabo** exporta un paquete para una migración voluntaria al modo conectado. Es una exportación, no una restauración automática del POS local. Guardá copias JSON periódicas en otra unidad o medio seguro y comprobá que el archivo descargado exista. El navegador no puede recuperar datos si se pierde o se borra el perfil y no existe una copia externa.

## Actualizaciones

Cada build genera una caché identificada por el contenido del shell estático. El service worker nuevo descarga todos sus recursos antes de quedar instalado y no fuerza el cierre ni toma control de pestañas abiertas. El navegador lo activa cuando las páginas controladas de la versión anterior se cierran; luego retira únicamente cachés con el prefijo propio del POS. IndexedDB y los archivos de datos no se modifican durante la actualización.

Para recibir una actualización, conectate y abrí el POS. Cerrá sus pestañas y volvé a abrirlo desde el ícono si el navegador indica que hay una versión nueva. No borres los datos del sitio como método de actualización.

## Limitaciones operativas

- Una PWA instalada puede abrir el shell sin internet después de haberlo visitado y guardado. No puede instalarse antes de esa primera visita.
- Para una computadora de cliente, el origen debe seguir siendo el mismo y estar disponible al menos para instalar/actualizar y activar la licencia. El POS local no necesita que Docker se ejecute en la computadora del cliente una vez que el shell está guardado.
- Probar un ícono en un perfil automatizado verifica caché y persistencia del navegador, pero la instalación real del sistema y el reinicio de Windows deben confirmarse manualmente en el equipo de venta.
