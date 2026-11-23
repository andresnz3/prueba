# Manifiesto del paquete de auditoría

El ZIP contiene este manifiesto, `INFORME_COMPLETO.md`, `DIFFS_Y_COMMITS.md` y `ARCHIVOS_RELEVANTES/`. Las rutas son relativas al proyecto original `C:\Proyectos\proyecto 1`. SHA-256 corresponde a la copia de evidencia. Las copias de tests con contraseñas de fixture se sanitizaron únicamente en literales de valores; se verificó sintaxis y mismo número de líneas. Las demás copias coinciden byte a byte con el archivo del árbol de trabajo al preparar el paquete.

| Archivo dentro del paquete | Ruta original | Propósito / clasificación | SHA-256 de evidencia |
|---|---|---|---|
| `ARCHIVOS_RELEVANTES/api-client.js` | `api-client.js` | Integración de aplicación / contexto técnico | `fd508b4a34890033708c1b53e725df76db15eec0b50db0902a6cebe978ec8d36` |
| `ARCHIVOS_RELEVANTES/app.js` | `app.js` | Interfaz local/conectada | `bed7a9e4186ebdede6bd4297b89757ee89127d22ffa6e70016e61fdeca66485a` |
| `ARCHIVOS_RELEVANTES/backend/package.json` | `backend/package.json` | Manifiesto/lockfile de dependencias | `5cc0d70e4f94cb70e829a450496f916b0cd29b1fa0e966eec6b6f635a13d70ad` |
| `ARCHIVOS_RELEVANTES/backend/package-lock.json` | `backend/package-lock.json` | Manifiesto/lockfile de dependencias | `37a3cd424be477fde093816ed417e792e15b1c25396c7b8c50819031d15e30bc` |
| `ARCHIVOS_RELEVANTES/backend/scripts/test-integration.cjs` | `backend/scripts/test-integration.cjs` | Integración aislada y limpieza de base temporal | `219ae09ad1e7b138c84c9f3a5f4024551d340a218fa6844cbf9734fcdda7e998` |
| `ARCHIVOS_RELEVANTES/backend/src/app.js` | `backend/src/app.js` | Integración de aplicación / contexto técnico | `b2e22fc6dca8cfa20ecb093644be673a5c8285af2287146885c952d0069a3361` |
| `ARCHIVOS_RELEVANTES/backend/src/config/auth.js` | `backend/src/config/auth.js` | Autorización, sesión, usuarios, licencias y auditoría | `979b6ca58501998856ee74f69e3bc4e083c662fa14db0e236a4792b07822373e` |
| `ARCHIVOS_RELEVANTES/backend/src/config/database.js` | `backend/src/config/database.js` | Integración de aplicación / contexto técnico | `d4a7a3c195d298f05f15ac58f467bc1a099f81453bf155441e0d9a6e4570e1f8` |
| `ARCHIVOS_RELEVANTES/backend/src/middleware/authentication.js` | `backend/src/middleware/authentication.js` | Autorización, sesión, usuarios, licencias y auditoría | `647eab72986f77803e2c001a60a679b687dfb2311663923acfc2d256226161ae` |
| `ARCHIVOS_RELEVANTES/backend/src/middleware/errors.js` | `backend/src/middleware/errors.js` | Integración de aplicación / contexto técnico | `327245555de47ec4251f0f8c16b34687c2e8e8edd9d92295fe7f73d404b89122` |
| `ARCHIVOS_RELEVANTES/backend/src/middleware/validation.js` | `backend/src/middleware/validation.js` | Integración de aplicación / contexto técnico | `4dd22308d5371dc8dc46d5e3292531608b36a6d659aca163c9090295e157aab9` |
| `ARCHIVOS_RELEVANTES/backend/src/repositories/auth.js` | `backend/src/repositories/auth.js` | Autorización, sesión, usuarios, licencias y auditoría | `fec62c2b807237c8605375e5dcb25aab3607c964eabea07d108cc4ba4c030e1c` |
| `ARCHIVOS_RELEVANTES/backend/src/routes/auth.js` | `backend/src/routes/auth.js` | Autorización, sesión, usuarios, licencias y auditoría | `7b848bb317d20736d80beee58e8d0029f84082f30dc6f92d7ba9f1bb38b8a2a8` |
| `ARCHIVOS_RELEVANTES/backend/src/routes/inventory.js` | `backend/src/routes/inventory.js` | Categorías, inventario y compras | `0373da8eb0f2256743a9e878249cfcd6975fe78fd72f31a2fdc88ac959775543` |
| `ARCHIVOS_RELEVANTES/backend/src/routes/system-admin.js` | `backend/src/routes/system-admin.js` | Autorización, sesión, usuarios, licencias y auditoría | `a00de959092f1b4be0f96b90446be748c089125501cf870bc5890f5ba02f478d` |
| `ARCHIVOS_RELEVANTES/backend/src/services/auth.js` | `backend/src/services/auth.js` | Autorización, sesión, usuarios, licencias y auditoría | `e12da0a6a7cb50a71d589037fb3a644f80e23d1e9b4e48dc7917239e8373494c` |
| `ARCHIVOS_RELEVANTES/backend/src/services/bootstrap.js` | `backend/src/services/bootstrap.js` | Integración de aplicación / contexto técnico | `15b7ca7c7cfc54a21719a74406b94741109ca5f452a1909fde5de95bbd9e0867` |
| `ARCHIVOS_RELEVANTES/backend/src/services/business-plans.js` | `backend/src/services/business-plans.js` | Autorización, sesión, usuarios, licencias y auditoría | `317566418e8fcfd5f4a3144ad508ff8b1af0529620ec8cb133a4de30e395fa77` |
| `ARCHIVOS_RELEVANTES/backend/src/services/inventory.js` | `backend/src/services/inventory.js` | Categorías, inventario y compras | `87fd8e471496c0565f903c1abf5df4e711eea4ff6f4d6ed3d7752284ec653cd7` |
| `ARCHIVOS_RELEVANTES/backend/src/services/inventory-values.js` | `backend/src/services/inventory-values.js` | Categorías, inventario y compras | `363cc93033625a83c80f0036f127148641870132037c1c96f0e082658f4e575d` |
| `ARCHIVOS_RELEVANTES/backend/src/services/local-licenses.js` | `backend/src/services/local-licenses.js` | Autorización, sesión, usuarios, licencias y auditoría | `d271f85b3f7375568fe0c37ae4367fde7738853a88c5133248e6dae829177fc9` |
| `ARCHIVOS_RELEVANTES/backend/src/services/product-category-values.js` | `backend/src/services/product-category-values.js` | Categorías, inventario y compras | `3aa6cb113b418269dac5e86959de1c70259f48bbec07e23ed93b97a73ce25381` |
| `ARCHIVOS_RELEVANTES/backend/src/services/schema-migrations.js` | `backend/src/services/schema-migrations.js` | Integración de aplicación / contexto técnico | `b971f2ac8c2e947fc592096d748e976d792c2f1828ae5de33467ceb23aafb466` |
| `ARCHIVOS_RELEVANTES/backend/src/services/system-admin.js` | `backend/src/services/system-admin.js` | Autorización, sesión, usuarios, licencias y auditoría | `e9387b8a695304ef63f8fd9cfd4d8535420f25f30221a6232c9a8c5d153ebf64` |
| `ARCHIVOS_RELEVANTES/backend/src/services/system-admin-access.js` | `backend/src/services/system-admin-access.js` | Autorización, sesión, usuarios, licencias y auditoría | `b6407f166d3dcd054a4f94e35985c1cb82d874471f8b1964e1d0b0c90c120eb1` |
| `ARCHIVOS_RELEVANTES/backend/src/services/tokens.js` | `backend/src/services/tokens.js` | Autorización, sesión, usuarios, licencias y auditoría | `2316233a26ededa7dbbe62473946b64a4d1ab3855160984b9e447cd55f59072b` |
| `ARCHIVOS_RELEVANTES/backend/src/services/users.js` | `backend/src/services/users.js` | Autorización, sesión, usuarios, licencias y auditoría | `b9d9e816279dabbd0959e8306ab85058f54dfff1a03ec213b98b077bcb243338` |
| `ARCHIVOS_RELEVANTES/backend/tests/auth-security.test.cjs` | `backend/tests/auth-security.test.cjs` | Prueba; fixture sanitizado si contiene contraseña literal | `e95a1474540d50c9526851fa8e6a41f4e23f80c0e46a493d10e58dae22a84a34` |
| `ARCHIVOS_RELEVANTES/backend/tests/integration/auth.test.cjs` | `backend/tests/integration/auth.test.cjs` | Prueba; fixture sanitizado si contiene contraseña literal | `de96e90abd07c1baf76213ef1c0b015e2a9395059efd1f2570a2e4f621e7d953` |
| `ARCHIVOS_RELEVANTES/backend/tests/integration/product-categories.test.cjs` | `backend/tests/integration/product-categories.test.cjs` | Prueba; fixture sanitizado si contiene contraseña literal | `ac22fe0a265e77471c0aae2f002ca639d348312b0babeb0d552ab0712580032c` |
| `ARCHIVOS_RELEVANTES/backend/tests/integration/schema-migrations.test.cjs` | `backend/tests/integration/schema-migrations.test.cjs` | Prueba; fixture sanitizado si contiene contraseña literal | `401063aa060d4a7c0646f49d9096bc184c26a36989b455c2e7e7d4d562879465` |
| `ARCHIVOS_RELEVANTES/backend/tests/product-category-values.test.cjs` | `backend/tests/product-category-values.test.cjs` | Prueba; fixture sanitizado si contiene contraseña literal | `12d74b844a6ac34932eeee31ded48e21ee537187fa46c4105e21ea90dfaebe12` |
| `ARCHIVOS_RELEVANTES/backend/tests/schema-migrations.test.cjs` | `backend/tests/schema-migrations.test.cjs` | Prueba; fixture sanitizado si contiene contraseña literal | `111542daed035997491306652bf1a7d439abfa68e88b55e416a9cff4a7f81bb4` |
| `ARCHIVOS_RELEVANTES/backend/tests/system-admin-access.test.cjs` | `backend/tests/system-admin-access.test.cjs` | Prueba; fixture sanitizado si contiene contraseña literal | `832fe13c6f16c79cc42b0ce3327c1a06b0599e8d01ba8e0195e9ae03439459d3` |
| `ARCHIVOS_RELEVANTES/connected-auth.js` | `connected-auth.js` | Autorización, sesión, usuarios, licencias y auditoría | `f8b37f054d5e26e9aaf85571ceeb4de26921d8592c45c2045cb9ec381b82171c` |
| `ARCHIVOS_RELEVANTES/connected-inventory.js` | `connected-inventory.js` | Categorías, inventario y compras | `538042d558090876b1d19b4123b483c14a00395ac58477ae301d21ec3278edf9` |
| `ARCHIVOS_RELEVANTES/connected-purchases.js` | `connected-purchases.js` | Categorías, inventario y compras | `9700afd1350087c32d54fa3e15b14177cccdde9eec71d97bd910a4a22dfff887` |
| `ARCHIVOS_RELEVANTES/database/migrations/021_business_product_categories.sql` | `database/migrations/021_business_product_categories.sql` | Migración y documentación de esquema | `d412cd557dc1359c6000a6b4cd9d6edc64ccb5e229e87e4a41e411cc0b68f93c` |
| `ARCHIVOS_RELEVANTES/database/migrations/README.md` | `database/migrations/README.md` | Migración y documentación de esquema | `3042148d1488863899b9f9b5af67731d2244c4faa219898bfa482465ab709fdf` |
| `ARCHIVOS_RELEVANTES/index.html` | `index.html` | Interfaz local/conectada | `634816693be92c2856717d52418bf361a31ccd69d5b1a1687608ba2a9d7be7b7` |
| `ARCHIVOS_RELEVANTES/package.json` | `package.json` | Manifiesto/lockfile de dependencias | `94e81f5eaee7759dc140136720618ec5138968a1f2295e409af7cbe6404756e8` |
| `ARCHIVOS_RELEVANTES/package-lock.json` | `package-lock.json` | Manifiesto/lockfile de dependencias | `f735154f66e15dd6259cc3bf349e634b095305b333aff8c33d61d7384d516de4` |
| `ARCHIVOS_RELEVANTES/styles.css` | `styles.css` | Interfaz local/conectada | `4004a7b05a86399ffbf5b6d77125e1e2e70b88607c53484f992016340cf82cd2` |
| `ARCHIVOS_RELEVANTES/tests/product-categories.spec.cjs` | `tests/product-categories.spec.cjs` | Prueba; fixture sanitizado si contiene contraseña literal | `56b25a9efb5e2eac1a8c30c3ae6188f100d9980d5fbfb357d16b92451d71a0b4` |
| `ARCHIVOS_RELEVANTES/tests-connected/admin.spec.cjs` | `tests-connected/admin.spec.cjs` | Prueba; fixture sanitizado si contiene contraseña literal | `0ccd7bb020f8ec821ca6eddd0c6d6c8a19c850c8a494c0c5ce2863e0c7254ccf` |
| `ARCHIVOS_RELEVANTES/tests-connected/auth.spec.cjs` | `tests-connected/auth.spec.cjs` | Prueba; fixture sanitizado si contiene contraseña literal | `f014a7a53dcd8aca8c19362583d7abe20e16b88b870c2bd26963ce97211e4a7f` |
| `ARCHIVOS_RELEVANTES/tests-connected/product-categories.spec.cjs` | `tests-connected/product-categories.spec.cjs` | Prueba; fixture sanitizado si contiene contraseña literal | `a1832e3641539b1d1bf71827561d5214fe96c2343d823d37184f0b7309bd6ef4` |

## Exclusiones y revisión de seguridad

Se excluyeron `.env`, configuraciones con valores secretos, credenciales reales, cookies, sesiones, llaves/certificados privados, respaldos de bases, datos comerciales, `node_modules`, `.git` completo, binarios innecesarios y scripts de despliegue. Los lockfiles contienen metadatos de paquetes. Se revisaron las copias en busca de claves privadas, URLs MySQL con credenciales, bearer tokens y asignaciones de secretos conocidos; no hubo coincidencias. Los datos que quedan son fixtures sintéticos.

Las pruebas sanitizadas son evidencia para lectura, no copias ejecutables equivalentes: los literales de contraseñas ficticias se sustituyeron por `[REDACTED_TEST_FIXTURE]`. No se modificó ningún original.
