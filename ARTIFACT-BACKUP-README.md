# Backup de artefactos Docker SoftVenta

Este branch conserva los artefactos Docker aprobados del paquete permissions-reservations-release-20261121. Es un respaldo de artefactos; no representa una copia completa del código fuente ni una revisión Git de origen.

- Frontend image ID documentado: sha256:f599b0995c00086ffb0393d020f1e51d180e8f69cab728d8588a80dd427b4288
- Backend image ID documentado: sha256:8858869b8d884bdd1a8397de93d07666055c6afaf5f5fde3e97d689b6ed2c819
- Archivo OCI SHA-256: d8b8a4f13ed906a0b031aeff2d0c6b788eaaf9c245a01f33440397786123190f
- Archivo OCI bytes: 127961416; tracked with Git LFS.
- The original package manifests and hashes are preserved. The two helper scripts referenced by the package manifest are included at `scripts/` without changing their bytes.
- No `.env`, database dump, MySQL data, or ZIP package is included.
- The artifact archive path scan found no environment files, database dump files, private-key files, or database data paths. Image config contains no password/token/secret environment variables.
- This backup must not be described as complete application source or as an independently verified copy of the currently running Contabo containers.
