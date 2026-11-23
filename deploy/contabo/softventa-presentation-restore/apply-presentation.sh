#!/bin/sh
set -eu

ROOT=/usr/share/nginx/html
INDEX="$ROOT/index.html"
CSS="$ROOT/styles.css"
LANDING="$ROOT/inicio/index.html"
LANDING_SCRIPT="$ROOT/inicio/utm-cleanup.js"
SERVICE_WORKER="$ROOT/service-worker.js"
LOGO="$ROOT/assets/pwa/softventaweb-logo.webp"
PATCH_SCRIPT=/tmp/utm-cleanup.js
PACKAGE_SHA="${1:-}"
OLD_LOGO='<div class="login-logo"><div class="logo-icon">POS</div></div>'
NEW_LOGO='<div class="login-logo"><img class="login-softventa-logo" src="/assets/pwa/softventaweb-logo.webp" alt="SoftVentaWeb" width="220" height="56" fetchpriority="high"></div>'
SCRIPT_TAG='<script src="/inicio/utm-cleanup.js" defer></script>'
LOGO_TMP="${INDEX}.presentation.$$.logo"
TITLE_TMP="${INDEX}.presentation.$$.title"
LANDING_TMP="${LANDING}.presentation.$$.tmp"
SW_TMP="${SERVICE_WORKER}.presentation.$$.tmp"

die() { printf 'DETENIDO: %s\n' "$1" >&2; exit 1; }
cleanup() { rm -f "$LOGO_TMP" "$TITLE_TMP" "$LANDING_TMP" "$SW_TMP"; }
trap cleanup EXIT HUP INT TERM

test -s "$INDEX" || die 'Falta el index.html del frontend activo.'
test -s "$CSS" || die 'Falta el CSS del POS activo.'
test -s "$LANDING" || die 'Falta /inicio/index.html en el frontend activo.'
test -s "$SERVICE_WORKER" || die 'Falta el service worker activo.'
test -s "$LOGO" || die 'No existe el logo oficial SoftVentaWeb en la imagen activa.'
test -s "$PATCH_SCRIPT" || die 'Falta el script local de limpieza UTM.'
printf '%s' "$PACKAGE_SHA" | grep -Eq '^[a-f0-9]{64}$' || die 'El paquete no tiene una huella SHA-256 válida.'
if ! grep -Fq '.login-logo img' "$CSS" &&
   ! grep -Fq '.login-softventa-logo { display: block; width: 220px; max-width: 100%; height: auto; max-height: 56px; object-fit: contain; }' "$CSS"; then
  die 'El CSS activo no contiene ninguno de los dos estilos de logo publicados.'
fi
grep -Fq 'Inicia sesión para continuar' "$INDEX" || die 'Falta el texto de acceso esperado en el login.'

old_logo_count="$( (grep -F -o "$OLD_LOGO" "$INDEX" || true) | wc -l | tr -d '[:space:]')"
if [ "$old_logo_count" = 1 ]; then
  sed "s|$OLD_LOGO|$NEW_LOGO|" "$INDEX" > "$LOGO_TMP" || die 'No se pudo conservar el logo oficial en el login.'
elif [ "$old_logo_count" = 0 ] && grep -Fq 'src="/assets/pwa/softventaweb-logo.webp"' "$INDEX"; then
  cp "$INDEX" "$LOGO_TMP" || die 'No se pudo preparar el HTML del login.'
else
  die 'El bloque del logo no coincide con el formato activo esperado.'
fi

awk '
{
  if (NR > 1) html = html "\n"
  html = html $0
}
END {
  title_count = gsub(/<title>[^<]*<\/title>/, "<title>SoftVentaWeb</title>", html)
  if (title_count != 1) exit 20
  tag_count = split("div p h1 h2 h3 h4 h5 h6 span strong b small", tags, " ")
  for (i = 1; i <= tag_count; i++) {
    tag = tags[i]
    pattern = "<" tag "[^>]*>[[:space:]]*POS Distribuidora[[:space:]]*</" tag "[[:space:]]*>"
    gsub(pattern, "", html)
  }
  if (html ~ />[[:space:]]*POS Distribuidora[[:space:]]*</) exit 21
  printf "%s\n", html
}
' "$LOGO_TMP" > "$TITLE_TMP" || die 'El título o el texto de marca del login no coincide con una estructura segura.'
chmod 644 "$TITLE_TMP"
mv "$TITLE_TMP" "$INDEX"
rm -f "$LOGO_TMP"

script_count="$( (grep -F -o "$SCRIPT_TAG" "$LANDING" || true) | wc -l | tr -d '[:space:]')"
if [ "$script_count" = 0 ]; then
  if grep -Fq '/inicio/utm-cleanup.js' "$LANDING"; then
    die 'La landing ya referencia un script UTM distinto.'
  fi
  awk -v script_tag="$SCRIPT_TAG" '
  {
    line = $0
    if (index(line, "</body>")) {
      body_count++
      sub(/<\/body>/, script_tag "\n</body>", line)
    }
    print line
  }
  END {
    if (body_count != 1) exit 1
  }
  ' "$LANDING" > "$LANDING_TMP" || die 'No se pudo insertar la limpieza UTM en la landing.'
  chmod 644 "$LANDING_TMP"
  mv "$LANDING_TMP" "$LANDING"
elif [ "$script_count" != 1 ]; then
  die 'La referencia a la limpieza UTM aparece varias veces.'
fi

if [ -e "$LANDING_SCRIPT" ]; then
  cmp -s "$PATCH_SCRIPT" "$LANDING_SCRIPT" || die 'Ya existe una limpieza UTM distinta en la landing.'
else
  cp "$PATCH_SCRIPT" "$LANDING_SCRIPT" || die 'No se pudo instalar la limpieza UTM local.'
  chmod 644 "$LANDING_SCRIPT"
fi

grep -Fq '<title>SoftVentaWeb</title>' "$INDEX" || die 'No se aplicó el título del navegador.'
grep -Fq 'src="/assets/pwa/softventaweb-logo.webp"' "$INDEX" || die 'No se conserva el logo oficial del login.'
grep -Fq 'Inicia sesión para continuar' "$INDEX" || die 'No se conserva el texto del formulario.'
grep -Fq "$SCRIPT_TAG" "$LANDING" || die 'La landing no referencia la limpieza UTM local.'
cmp -s "$PATCH_SCRIPT" "$LANDING_SCRIPT" || die 'El script de limpieza UTM no coincide.'
cache_suffix="$(printf '%s' "$PACKAGE_SHA" | cut -c 1-16)"
cache_name="pos-pwa-shell-presentation-$cache_suffix"
awk -v cache_name="$cache_name" '
{
  line = $0
  quote = sprintf("%c", 39)
  if (index(line, "const CACHE_NAME = ") == 1) {
    cache_pattern = "^const CACHE_NAME = " quote "[^" quote "]*" quote ";"
    cache_replacement = "const CACHE_NAME = " quote cache_name quote ";"
    cache_count += sub(cache_pattern, cache_replacement, line)
  }
  if (index(line, "const PRECACHE_URLS = ") == 1) {
    precache_count++
    if (index(line, "\"/inicio/utm-cleanup.js\"") == 0 &&
        sub(/\];$/, ",\"/inicio/utm-cleanup.js\"];", line) != 1) {
      failed = 1
    }
  }
  print line
}
END {
  if (cache_count != 1 || precache_count != 1 || failed) exit 1
}
' "$SERVICE_WORKER" > "$SW_TMP" || die 'No se pudo actualizar la caché estática de la landing.'
chmod 644 "$SW_TMP"
mv "$SW_TMP" "$SERVICE_WORKER"
grep -Fq "const CACHE_NAME = 'pos-pwa-shell-presentation-$cache_suffix';" "$SERVICE_WORKER" || die 'No se invalidó la caché previa de la PWA.'
grep -Fq '"/inicio/utm-cleanup.js"' "$SERVICE_WORKER" || die 'No se precachea el script UTM local.'
grep -Fq "const CACHE_PREFIX = 'pos-pwa-shell-';" "$SERVICE_WORKER" || die 'Cambió el prefijo de caché de la PWA.'
echo 'PRESENTATION_PATCH=PASS'
