# Librerías alojadas localmente

El POS sirve desde este directorio las bibliotecas del navegador y la fuente Inter. No depende de jsDelivr, cdnjs ni Google Fonts para cargar la aplicación. Las versiones, licencias, fuentes y SHA-256 están en `manifest.json`; los avisos de licencia acompañan a cada distribución.

| Componente | Versión | Nota |
| --- | --- | --- |
| Dexie | 3.2.7 | Conserva la versión mayor 3 que usa la base IndexedDB actual. |
| html5-qrcode | 2.3.8 | Versión estable utilizada por el POS. |
| html2pdf.js | 0.14.0 | Compilada con jsPDF 4.2.1, DOMPurify 3.4.17 y html2canvas 1.4.1. |
| SheetJS XLSX | 0.20.3 | Distribución standalone oficial; evita las versiones afectadas por los avisos de 0.18.5. |
| Inter Variable | 5.3.0 | Subconjuntos Latin y Latin Extended en WOFF2. |

## Actualizar las librerías

1. Revisar la versión estable, licencia y avisos de seguridad en los repositorios o documentación enlazados en `manifest.json`.
2. Descargar y compilar en una carpeta temporal, fijando versiones exactas. No usar rangos `latest` ni agregar etiquetas CDN al HTML.
3. Para `html2pdf.js`, compilar `src/index.js` con las versiones fijadas en el manifiesto. Verificar que el bundle contenga las versiones corregidas de jsPDF y DOMPurify; no copiar un bundle precompilado sin revisar sus dependencias.
4. Para XLSX, descargar la distribución standalone desde la documentación oficial de SheetJS. La versión 0.20.3 se distribuye por el canal oficial de SheetJS.
5. Sustituir los archivos de `vendor/`, conservar las licencias y actualizar `manifest.json`. Recalcular los SHA-256 con `Get-FileHash -Algorithm SHA256`.
6. Ejecutar `npm run check:vendor`, `npm run lint`, las pruebas unitarias, Playwright local y conectado, y reconstruir solo el frontend Docker. Confirmar en el navegador que no se realizan solicitudes a terceros.

Estos archivos forman parte del proyecto y se copian al build público y a Nginx. No se descargan durante el uso del POS.
