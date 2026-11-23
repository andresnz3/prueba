#!/bin/sh
set -eu

INDEX=/usr/share/nginx/html/index.html
CSS=/usr/share/nginx/html/styles.css
LOGO=/usr/share/nginx/html/assets/pwa/softventaweb-logo.webp
OLD='<div class="login-logo"><div class="logo-icon">POS</div></div>'
NEW='<div class="login-logo"><img class="login-softventa-logo" src="/assets/pwa/softventaweb-logo.webp" alt="SoftVentaWeb" width="220" height="56" fetchpriority="high"></div>'
RULE='.login-softventa-logo { display: block; width: 220px; max-width: 100%; height: auto; max-height: 56px; object-fit: contain; }'

test -s "$INDEX" || { echo 'Falta el index.html activo.' >&2; exit 1; }
test -s "$CSS" || { echo 'Falta el CSS activo.' >&2; exit 1; }
test -s "$LOGO" || { echo 'El logo oficial no existe en la imagen frontend activa.' >&2; exit 1; }

matches="$( (grep -F -o "$OLD" "$INDEX" || true) | wc -l | tr -d '[:space:]')"
test "$matches" = 1 || { echo 'El encabezado antiguo no aparece exactamente una vez; se cancela el overlay.' >&2; exit 1; }
if grep -Fq 'class="login-softventa-logo"' "$INDEX"; then
  echo 'El login ya tiene un logo alternativo; no se aplica otro parche.' >&2
  exit 1
fi

tmp="${INDEX}.login-logo.$$.tmp"
if ! sed "s|$OLD|$NEW|" "$INDEX" > "$tmp"; then
  rm -f "$tmp"
  exit 1
fi
chmod 644 "$tmp"
mv "$tmp" "$INDEX"

if grep -Fq '.login-softventa-logo' "$CSS"; then
  grep -Fq "$RULE" "$CSS" || { echo 'Hay una regla CSS previa incompatible.' >&2; exit 1; }
else
  printf '\n%s\n' "$RULE" >> "$CSS"
fi

new_matches="$( (grep -F -o 'class="login-softventa-logo" src="/assets/pwa/softventaweb-logo.webp"' "$INDEX" || true) | wc -l | tr -d '[:space:]')"
test "$new_matches" = 1 || { echo 'No se pudo verificar el nuevo logo en el login.' >&2; exit 1; }
grep -Fq "$RULE" "$CSS" || { echo 'No se pudo verificar la regla responsive del logo.' >&2; exit 1; }
echo 'LOGIN_LOGO_PATCH=PASS'
