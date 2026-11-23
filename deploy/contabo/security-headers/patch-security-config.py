#!/usr/bin/env python3
"""Narrow, fail-closed patcher for the public SoftVentaWeb security headers."""
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

POLICY = (
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; "
    "form-action 'self'; script-src 'self'; script-src-attr 'unsafe-inline'; "
    "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
    "media-src 'self' blob: mediastream:; font-src 'self' data:; "
    "connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'"
)
POLICY_MARKER = "map $host $pos_content_security_policy {"
HSTS_LINE = 'header >Strict-Transport-Security "max-age=31536000"'
HSTS_COMMENT = "# softventa-security-headers:hsts-v1"
SECURITY_HEADERS_MARKER = "# softventa-security-headers:public-v1"
HSTS_RE = re.compile(r"(?i)strict-transport-security")
PUBLIC_RESPONSE_HEADERS = {
    "Content-Security-Policy": POLICY,
    "Strict-Transport-Security": "max-age=31536000",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-Frame-Options": "DENY",
}


def _nginx_block(text: str, locator: str) -> tuple[int, int, str]:
    matches = list(re.finditer(locator, text, re.M))
    if len(matches) != 1:
        raise ValueError(f"Se esperaba una única ubicación Nginx: {locator}")
    start = matches[0].start()
    opening = text.find("{", matches[0].start(), matches[0].end())
    if opening < 0:
        raise ValueError("Bloque Nginx sin apertura")
    depth, quoted, escaped = 0, False, False
    for index in range(opening, len(text)):
        char = text[index]
        if escaped:
            escaped = False
            continue
        if char == "\\" and quoted:
            escaped = True
            continue
        if char == '"':
            quoted = not quoted
            continue
        if quoted:
            continue
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                end = index + 1
                return start, end, text[start:end]
    raise ValueError("Bloque Nginx sin cierre")


def _ensure_one_line(block: str, line: str, anchor: str) -> str:
    match = re.search(r"\badd_header\s+([^\s]+)", line)
    if not match:
        raise ValueError("Directiva add_header inválida")
    field = re.escape(match.group(1))
    occurrences = block.count(line)
    if occurrences == 1:
        return block
    if occurrences > 1 or re.search(rf"(?im)^\s*add_header\s+{field}\b", block):
        raise ValueError("Hay una política de cabeceras distinta o duplicada")
    if anchor not in block:
        raise ValueError("Falta el punto de inserción esperado en Nginx")
    return block.replace(anchor, anchor + "\n" + line, 1)


def _nginx_directives(block: str) -> list[str]:
    """Return non-comment directives with normalized whitespace."""
    opening = block.find("{")
    closing = block.rfind("}")
    if opening < 0 or closing <= opening:
        raise ValueError("el bloque Nginx no tiene llaves balanceadas")
    directives = []
    for raw in block[opening + 1 : closing].splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        directives.append(re.sub(r"[ \t]+", " ", line))
    return directives


def _validate_forwarded_proto_map(text: str) -> tuple[int, int, str]:
    locator = r"^\s*map\s+\$http_x_forwarded_proto\s+\$pos_forwarded_proto\s*\{"
    try:
        start, end, block = _nginx_block(text, locator)
    except ValueError:
        raise ValueError("map de X-Forwarded-Proto ausente o duplicado") from None
    expected = ["~*^https$ https;", "default $scheme;"]
    if sorted(_nginx_directives(block)) != sorted(expected):
        raise ValueError("map de X-Forwarded-Proto tiene reglas no aprobadas")
    return start, end, block


def _validate_csp_map(text: str) -> bool:
    locator = r"^\s*map\s+\$host\s+\$pos_content_security_policy\s*\{"
    matches = list(re.finditer(locator, text, re.M))
    if not matches:
        if POLICY_MARKER in text:
            raise ValueError("marcador CSP presente pero el mapa está incompleto")
        return False
    if len(matches) != 1:
        raise ValueError("mapa CSP duplicado o sin el marcador aprobado")
    _, _, block = _nginx_block(text, locator)
    if _nginx_directives(block) != [f'default "{POLICY}";']:
        raise ValueError("mapa CSP existente no coincide con la política revisada")
    return True


def nginx_profile(text: str) -> str:
    """Emit a safe structural summary without returning active config contents."""
    source_maps = list(re.finditer(
        r"(?m)^\s*map\s+\$http_x_forwarded_proto\s+(\$[A-Za-z_][A-Za-z0-9_]*)\s*\{",
        text,
    ))
    proto_detail = "map=missing" if not source_maps else "map=duplicate" if len(source_maps) != 1 else "map=unparsed"
    proto = "unsupported"
    if len(source_maps) == 1:
        output_var = source_maps[0].group(1)
        locator = rf"^\s*map\s+\$http_x_forwarded_proto\s+{re.escape(output_var)}\s*\{{"
        try:
            _, _, proto_block = _nginx_block(text, locator)
            rules = _nginx_directives(proto_block)
            https_rule = any(rule in ("~*^https$ https;", "https https;", '"https" https;') for rule in rules)
            safe_default = any(rule in ("default $scheme;", "default http;") for rule in rules)
            exact_rules = len(rules) == 2 and https_rule and safe_default
            proto = "valid" if output_var == "$pos_forwarded_proto" and exact_rules else "unsupported"
            rule_classes = []
            for rule in rules:
                tokens = rule.rstrip(";").split()
                if len(tokens) < 2:
                    rule_classes.append("malformed")
                    continue
                if tokens[0] == "default":
                    key_class, value = "default", tokens[-1]
                else:
                    key_class = "https-regex" if tokens[0] == "~*^https$" else "https-exact" if tokens[0] in ("https", '"https"') else "other-key"
                    value = tokens[-1]
                value_class = {"https": "https", "http": "http", "$scheme": "scheme"}.get(value)
                if value_class is None:
                    value_class = "other-variable" if value.startswith("$") else "other-literal"
                rule_classes.append(f"{key_class}-to-{value_class}")
            proto_detail = (
                f"map=single;output={'expected' if output_var == '$pos_forwarded_proto' else 'other'};"
                f"rules={len(rules)};https_to_https={'yes' if https_rule else 'no'};"
                f"safe_default={'yes' if safe_default else 'no'};"
                f"extra_rules={max(0, len(rules) - int(https_rule) - int(safe_default))};"
                f"rule_classes={','.join(rule_classes) if rule_classes else 'none'}"
            )
        except ValueError:
            proto_detail = "map=single;block=unparsed"
    try:
        csp = "exact" if _validate_csp_map(text) else "absent"
    except ValueError:
        csp = "unsupported"
    api_detail = "location=missing"
    try:
        api_locations = list(re.finditer(r"(?m)^\s*location\s+(?:(\^~)\s+)?(/api/?)(?:\s+|\s*\{)", text))
        prefix_locations = [m for m in api_locations if m.group(2) == "/api/"]
        if len(prefix_locations) != 1:
            api_detail = f"locations={len(api_locations)};api_prefix={'missing' if not prefix_locations else 'multiple'}"
            api_proxy = "unsupported"
        else:
            location = prefix_locations[0]
            modifier = "^~" if location.group(1) == "^~" else "plain"
            locator = rf"^\s*location\s+(?:\^~\s+)?/api/\s*\{{"
            _, _, api = _nginx_block(text, locator)
            directives = _nginx_directives(api)
            proxy_lines = [line for line in directives if re.match(r"^proxy_pass\s+", line)]
            if not proxy_lines:
                target = "missing"
            elif proxy_lines == ["proxy_pass http://backend:3000;"]:
                target = "backend-3000-no-uri"
            elif len(proxy_lines) == 1 and re.fullmatch(r"proxy_pass http://backend:3000/[^;]*;", proxy_lines[0]):
                target = "backend-3000-uri-suffix"
            elif len(proxy_lines) == 1 and proxy_lines[0].startswith("proxy_pass http://"):
                target = "other-http-upstream"
            else:
                target = "other-or-duplicate"
            proto_headers = [line for line in directives if re.match(r"^proxy_set_header X-Forwarded-Proto\s+", line)]
            proto_header = "missing" if not proto_headers else "pos-forwarded-proto" if proto_headers == ["proxy_set_header X-Forwarded-Proto $pos_forwarded_proto;"] else "other"
            api_proxy = "valid" if modifier == "^~" and target == "backend-3000-no-uri" and proto_header == "pos-forwarded-proto" else "unsupported"
            api_detail = f"locations={len(api_locations)};api_prefix={modifier};upstream={target};forwarded_proto={proto_header}"
    except ValueError:
        api_proxy = "unsupported"
        api_detail = "api_block=unparsed"
    webp = "present" if re.search(r"(?im)^\s*location\s+~\*[^\n]*webp[^\n]*\{", text) else "absent"
    fallback = "present" if "try_files $uri $uri/ /index.html;" in text else "absent"
    offline = "present" if re.search(r"(?m)^\s*location\s*=\s*/offline\.html\s*\{", text) else "absent"
    generic_html = "present" if re.search(r"(?m)^\s*location\s+~\*\s+\\\.html\$\s*\{", text) else "absent"
    hsts = "present" if re.search(r"(?im)^\s*add_header\s+Strict-Transport-Security\b", text) else "absent"
    cache = "present" if re.search(r"(?im)^\s*(?:add_header\s+Cache-Control|expires)\b", text) else "absent"
    gzip_match = re.search(r"(?im)^\s*gzip\s+(on|off)\s*;", text)
    gzip = gzip_match.group(1).lower() if gzip_match else "not-in-default-conf"
    core_matches_rc6 = proto == "valid" and api_proxy == "valid" and fallback == "present" and offline == "present"
    profile = "softventa-branding" if core_matches_rc6 and webp == "present" else "rc6-compatible" if core_matches_rc6 else "divergent-unverified"
    if csp == "exact":
        profile += "+csp"
    return (
        f"NGINX_ACTIVE_PROFILE={profile}; proto_map={proto}({proto_detail}); "
        f"api_proxy={api_proxy}({api_detail}); "
        f"webp={webp}; fallback={fallback}; offline={offline}; generic_html={generic_html}; "
        f"csp={csp}; nginx_hsts={hsts}; cache={cache}; gzip={gzip}"
    )


def _nginx_block_at(text: str, start: int) -> str:
    opening = text.find("{", start)
    if opening < 0:
        raise ValueError("location sin bloque")
    depth, quoted, escaped, comment = 0, False, False, False
    for index in range(opening, len(text)):
        char = text[index]
        if comment:
            if char == "\n":
                comment = False
            continue
        if escaped:
            escaped = False
            continue
        if char == "\\" and quoted:
            escaped = True
            continue
        if char == '"':
            quoted = not quoted
            continue
        if quoted:
            continue
        if char == "#":
            comment = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start : index + 1]
    raise ValueError("location sin cierre")


def _safe_location_summary(section: str) -> list[str]:
    summaries = []
    locator = re.compile(r"(?m)^\s*location\s+([^{}\n]+?)\s*\{")
    for match in locator.finditer(section):
        header = re.sub(r"\s+", " ", match.group(1).strip())
        modifier = "plain"
        route = header
        for candidate in ("^~", "=", "~*", "~"):
            if route.startswith(candidate + " "):
                modifier = candidate
                route = route[len(candidate) :].strip()
                break
        if route in ("/api", "/api/"):
            route_class = "api"
        elif "/api" in route:
            route_class = "api-pattern"
        elif route == "/":
            route_class = "root"
        else:
            route_class = "other"
        try:
            directives = _nginx_directives(_nginx_block_at(section, match.start()))
        except ValueError:
            summaries.append(f"{route_class}:{modifier}:unparsed")
            continue
        proxies = [line for line in directives if re.match(r"^proxy_pass\s+", line)]
        if not proxies:
            proxy_class = "static"
        elif proxies == ["proxy_pass http://backend:3000;"]:
            proxy_class = "backend-3000"
        elif len(proxies) == 1 and proxies[0].startswith("proxy_pass http://"):
            proxy_class = "http-upstream"
        elif len(proxies) == 1 and proxies[0].startswith("proxy_pass https://"):
            proxy_class = "https-upstream"
        elif len(proxies) == 1 and "unix:" in proxies[0]:
            proxy_class = "unix-upstream"
        else:
            proxy_class = "other-or-duplicate"
        forwarded = [line for line in directives if re.match(r"^proxy_set_header X-Forwarded-Proto\s+", line)]
        if not forwarded:
            forwarded_class = "missing"
        elif forwarded == ["proxy_set_header X-Forwarded-Proto $scheme;"]:
            forwarded_class = "scheme"
        elif forwarded == ["proxy_set_header X-Forwarded-Proto $pos_forwarded_proto;"]:
            forwarded_class = "mapped-variable"
        elif forwarded == ["proxy_set_header X-Forwarded-Proto $http_x_forwarded_proto;"]:
            forwarded_class = "incoming-header"
        else:
            forwarded_class = "other-or-duplicate"
        summaries.append(f"{route_class}:{modifier}:{proxy_class}:xfp-{forwarded_class}")
    return summaries


def nginx_t_profile(dump: str) -> str:
    """Summarize nginx -T without returning directive contents or secret values."""
    markers = list(re.finditer(r"(?m)^# configuration file ([^:\r\n]+):\s*$", dump))
    if not markers:
        raise ValueError("nginx -T no reportó archivos de configuración incluidos")
    sections: list[tuple[str, str]] = []
    for index, marker in enumerate(markers):
        end = markers[index + 1].start() if index + 1 < len(markers) else len(dump)
        name = marker.group(1).strip()
        body = dump[marker.end() : end]
        sections.append((name, body))
    effective = "\n".join(body for _, body in sections)
    safe_paths = [name if name.startswith("/etc/nginx/") else "<external-config>" for name, _ in sections]
    route_parts = []
    api_files = []
    for name, body in sections:
        routes = _safe_location_summary(body)
        if routes:
            safe_name = name if name.startswith("/etc/nginx/") else "<external-config>"
            route_parts.append(f"{safe_name}=" + ",".join(routes))
            if any(route.startswith("api:") or route.startswith("api-pattern:") for route in routes):
                api_files.append(safe_name)
    routes_summary = ";".join(route_parts) if route_parts else "none"
    api_summary = ",".join(sorted(set(api_files))) if api_files else "none-in-nginx-includes"
    return (
        f"NGINX_T=PASS; config_files={len(sections)}; paths={','.join(safe_paths)}; "
        f"api_location_files={api_summary}; routes={routes_summary}; {nginx_profile(effective)}"
    )


def patch_nginx(text: str) -> str:
    if re.search(r"(?im)^\s*add_header\s+Strict-Transport-Security\b", text):
        raise ValueError("Nginx ya contiene HSTS; no se mezclará con el HSTS de Caddy")
    _validate_forwarded_proto_map(text)
    has_csp_map = _validate_csp_map(text)
    if not has_csp_map:
        _, map_end, _ = _validate_forwarded_proto_map(text)
        csp_map = f'{POLICY_MARKER}\n    default "{POLICY}";\n}}'
        text = text[:map_end] + "\n\n" + csp_map + text[map_end:]

    api_start, api_end, api = _nginx_block(text, r"^\s*location \^~ /api/\s*\{")
    for name in ("Strict-Transport-Security", "X-Content-Type-Options", "Referrer-Policy", "X-Frame-Options"):
        directive = f"proxy_hide_header {name};"
        if api.count(directive) > 1:
            raise ValueError(f"Directiva proxy_hide_header duplicada: {name}")
        if directive not in api:
            proxy = "        proxy_pass http://backend:3000;"
            if api.count(proxy) != 1:
                raise ValueError("Falta el proxy_pass esperado del API")
            api = api.replace(proxy, f"        {directive}\n" + proxy, 1)
    if api.count('add_header X-Content-Type-Options "nosniff" always;') != 1:
        raise ValueError("Nginx debe emitir una sola protección nosniff en API")
    if api.count('add_header Referrer-Policy "strict-origin-when-cross-origin" always;') != 1:
        raise ValueError("Nginx debe emitir una sola política Referrer en API")
    if api.count('add_header X-Frame-Options "DENY" always;') != 1:
        raise ValueError("Nginx debe emitir una sola protección de framing en API")
    text = text[:api_start] + api + text[api_end:]

    header_line = "        add_header Content-Security-Policy $pos_content_security_policy always;"
    for locator in (
        r"^\s*location\s*=\s*/index\.html\s*\{",
        r"^\s*location\s*=\s*/offline\.html\s*\{",
    ):
        start, end, block = _nginx_block(text, locator)
        if "/offline.html" in locator:
            block = _ensure_one_line(
                block,
                '        add_header Referrer-Policy "strict-origin-when-cross-origin" always;',
                '        add_header X-Content-Type-Options "nosniff" always;',
            )
            block = _ensure_one_line(
                block,
                '        add_header X-Frame-Options "DENY" always;',
                '        add_header Referrer-Policy "strict-origin-when-cross-origin" always;',
            )
        if '        add_header X-Frame-Options "DENY" always;' in block:
            anchor = '        add_header X-Frame-Options "DENY" always;'
        elif '        add_header Cache-Control ' in block:
            anchor = next(line for line in block.splitlines() if line.startswith('        add_header Cache-Control '))
        else:
            raise ValueError("Falta un ancla segura en el bloque HTML")
        block = _ensure_one_line(block, header_line, anchor)
        text = text[:start] + block + text[end:]

    generic_locator = r"^\s*location\s+~\*\s+\\\.html\$\s*\{"
    generic_matches = list(re.finditer(generic_locator, text, re.M))
    if len(generic_matches) == 0:
        anchor = "    location ~* \\.(?:css|js)$ {"
        if text.count(anchor) != 1:
            raise ValueError("No se encontró el punto seguro para la ubicación HTML genérica")
        generic = (
            "    location ~* \\.html$ {\n"
            '        add_header X-Content-Type-Options "nosniff" always;\n'
            '        add_header Referrer-Policy "strict-origin-when-cross-origin" always;\n'
            '        add_header X-Frame-Options "DENY" always;\n'
            "        add_header Content-Security-Policy $pos_content_security_policy always;\n"
            '        add_header Cache-Control "no-cache" always;\n'
            "        try_files $uri =404;\n"
            "    }\n\n"
        )
        text = text.replace(anchor, generic + anchor, 1)
    elif len(generic_matches) == 1:
        start, end, block = _nginx_block(text, generic_locator)
        block = _ensure_one_line(block, header_line, '        add_header X-Frame-Options "DENY" always;')
        text = text[:start] + block + text[end:]
    else:
        raise ValueError("Hay ubicaciones HTML genéricas duplicadas")

    if text.count("add_header Content-Security-Policy $pos_content_security_policy always;") != 3:
        raise ValueError("La CSP debe aplicarse solo a index, offline y otros HTML")
    if "location ~* \\.html$" not in text:
        raise ValueError("Falta la ubicación para documentos HTML")
    return text


def _caddy_block_ranges(text: str) -> list[tuple[str, int, int, str]]:
    lines = text.splitlines(keepends=True)
    starts: list[tuple[str, int]] = []
    offsets: list[int] = []
    offset = 0
    for line in lines:
        offsets.append(offset)
        stripped = line.strip()
        if stripped.startswith("#"):
            offset += len(line)
            continue
        match = re.match(r"^(www\.softventaweb\.com|softventaweb\.com|http://:8443)\s*\{\s*(?:#.*)?$", stripped)
        if match:
            starts.append((match.group(1), offset))
        offset += len(line)

    ranges: list[tuple[str, int, int, str]] = []
    for name, start in starts:
        start_line_index = max(i for i, pos in enumerate(offsets) if pos == start)
        depth = 0
        quoted = escaped = comment = False
        end = None
        scan_offset = start
        for line in lines[start_line_index:]:
            quoted = escaped = comment = False
            for char in line:
                if comment:
                    break
                if escaped:
                    escaped = False
                    continue
                if char == "\\" and quoted:
                    escaped = True
                elif char == '"':
                    quoted = not quoted
                elif not quoted and char == "#":
                    comment = True
                elif not quoted and char == "{":
                    depth += 1
                elif not quoted and char == "}":
                    depth -= 1
                    if depth == 0:
                        end = scan_offset + len(line)
                        break
            scan_offset += len(line)
            if end is not None:
                break
        if end is None:
            raise ValueError(f"Bloque Caddy sin cierre: {name}")
        ranges.append((name, start, end, text[start:end]))
    return ranges


def _caddy_managed_header_operations(block: str) -> dict[str, int]:
    """Count response header operations managed at the public Caddy edge."""
    managed = {name.lower() for name in PUBLIC_RESPONSE_HEADERS}
    counts: dict[str, int] = {}
    pattern = re.compile(
        r"(?im)^\s*(?:header\s+)?[+?>-]?"
        r"(Content-Security-Policy|Strict-Transport-Security|"
        r"X-Content-Type-Options|Referrer-Policy|X-Frame-Options)\b"
    )
    for match in pattern.finditer(block):
        field = match.group(1).lower()
        if field in managed:
            counts[field] = counts.get(field, 0) + 1
    return counts


def patch_caddy(text: str) -> str:
    """Set one canonical security-header policy on public Caddy sites only."""
    for raw in text.splitlines():
        active = raw.split("#", 1)[0].strip()
        if active and re.match(r"(?i)^import\b", active):
            raise ValueError("Caddyfile contiene imports; se requiere revisar las reglas incluidas")

    ranges = _caddy_block_ranges(text)
    public = {name: [item for item in ranges if item[0] == name]
              for name in ("softventaweb.com", "www.softventaweb.com")}
    if any(len(items) != 1 for items in public.values()):
        raise ValueError("Caddy debe tener un bloque separado para softventaweb.com y www.softventaweb.com")
    recovery = [item for item in ranges if item[0] == "http://:8443"]
    if len(recovery) != 1 or not re.search(r"(?m)^\s*bind\s+127\.0\.0\.1\s*$", recovery[0][3]):
        raise ValueError("No se confirmo el listener privado de recuperacion 127.0.0.1:8443")

    snippet_lines = [
        SECURITY_HEADERS_MARKER,
        "header {",
        *(f'>{name} "{value}"' for name, value in PUBLIC_RESPONSE_HEADERS.items()),
        "}",
    ]

    def patch_site(name: str, block: str) -> str:
        if re.search(r"(?m)^\s*import\s+", block):
            raise ValueError(f"El bloque {name} importa reglas y requiere revision")
        marker_count = block.count(SECURITY_HEADERS_MARKER)
        if marker_count > 1:
            raise ValueError(f"El bloque {name} duplica el marcador de cabeceras")
        if marker_count == 1:
            marker_at = block.index(SECURITY_HEADERS_MARKER)
            suffix = block[marker_at:]
            lines = suffix.splitlines()
            expected = [snippet_lines[0], "\theader {"]
            expected.extend("\t\t" + line for line in snippet_lines[2:-1])
            expected.append("\t}")
            if lines[:len(expected)] != expected:
                raise ValueError(f"El bloque marcado de cabeceras no coincide con la politica aprobada en {name}")
            if _caddy_managed_header_operations(block) != {
                field.lower(): 1 for field in PUBLIC_RESPONSE_HEADERS
            }:
                raise ValueError(f"Hay encabezados duplicados o no aprobados en {name}")
            return block

        # Replace only the exact legacy sample HSTS lines. Any other existing
        # header policy is kept fail-closed for explicit review.
        legacy = {
            'header >Strict-Transport-Security "max-age=31536000"',
            'header >Strict-Transport-Security "max-age=31536000; includeSubDomains"',
        }
        hsts_lines = [line.strip() for line in block.splitlines()
                      if re.search(r"(?i)Strict-Transport-Security", line)]
        if any(line not in legacy for line in hsts_lines) or len(hsts_lines) > 1:
            raise ValueError(f"HSTS existente distinto o duplicado en {name}")
        without_hsts = re.sub(
            r"(?im)^\s*header\s+>Strict-Transport-Security\s+\"max-age=31536000(?:;\s*includeSubDomains)?\"\s*\r?\n",
            "",
            block,
        )
        if _caddy_managed_header_operations(without_hsts):
            raise ValueError(f"El sitio {name} ya define encabezados administrados; requiere revision")
        newline = "\r\n" if "\r\n" in block else "\n"
        indented_lines = ["\t" + snippet_lines[0], "\theader {"]
        indented_lines.extend("\t\t" + line for line in snippet_lines[2:-1])
        indented_lines.append("\t}")
        indented = newline.join(indented_lines) + newline
        first_newline = without_hsts.find("\n")
        if first_newline < 0 or "{" not in without_hsts[:first_newline]:
            raise ValueError(f"No se pudo insertar el bloque de encabezados en {name}")
        return without_hsts[:first_newline + 1] + indented + without_hsts[first_newline + 1:]

    # Reject managed response headers outside the two public site blocks. This
    # keeps recovery on 127.0.0.1:8443 free of HSTS and CSP policy changes.
    public_ranges = [(items[0][1], items[0][2]) for items in public.values()]
    for match in re.finditer(
        r"(?i)\b(?:Content-Security-Policy|Strict-Transport-Security|"
        r"X-Content-Type-Options|Referrer-Policy|X-Frame-Options)\b", text
    ):
        line_start = text.rfind("\n", 0, match.start()) + 1
        if text[line_start:match.start()].lstrip().startswith("#"):
            continue
        if not any(start <= match.start() < end for start, end in public_ranges):
            raise ValueError("Hay un encabezado administrado fuera de los sitios publicos")

    output = text
    for name in ("www.softventaweb.com", "softventaweb.com"):
        current = next(item for item in _caddy_block_ranges(output) if item[0] == name)
        replacement = patch_site(name, current[3])
        output = output[:current[1]] + replacement + output[current[2]:]
    return output

def _public_caddy_hosts(route: dict) -> set[str]:
    hosts: set[str] = set()
    for matcher in route.get("match", []) or []:
        if isinstance(matcher, dict):
            values = matcher.get("host", []) or []
            if isinstance(values, str):
                values = [values]
            hosts.update(value for value in values if isinstance(value, str))
    return hosts


def _iter_caddy_route_handlers(routes: list, inherited_hosts: set[str] | None = None):
    """Yield route host context and handlers, descending through subroutes."""
    inherited_hosts = inherited_hosts or set()
    for route in routes:
        if not isinstance(route, dict):
            continue
        route_hosts = _public_caddy_hosts(route) or inherited_hosts
        handlers = route.get("handle", []) or []
        if not isinstance(handlers, list):
            continue
        for handler in handlers:
            if not isinstance(handler, dict):
                continue
            yield route_hosts, handler
            nested = handler.get("routes")
            if handler.get("handler") == "subroute" and isinstance(nested, list):
                yield from _iter_caddy_route_handlers(nested, route_hosts)


def _set_caddy_response_headers(handler: dict) -> None:
    response = handler.setdefault("response", {})
    if not isinstance(response, dict):
        raise ValueError("Caddy response header handler no tiene una estructura aprobada")
    current_set = response.setdefault("set", {})
    if not isinstance(current_set, dict):
        raise ValueError("Caddy response headers set no tiene una estructura aprobada")
    for existing in list(current_set):
        if existing.lower() in {name.lower() for name in PUBLIC_RESPONSE_HEADERS}:
            del current_set[existing]
    for bucket_name in ("add",):
        bucket = response.get(bucket_name, {})
        if bucket and not isinstance(bucket, dict):
            raise ValueError("Caddy response header add no tiene una estructura aprobada")
        for existing in list(bucket or {}):
            if existing.lower() in {name.lower() for name in PUBLIC_RESPONSE_HEADERS}:
                del bucket[existing]
    if "delete" in response:
        deleted = response.get("delete", []) or []
        if not isinstance(deleted, list):
            raise ValueError("Caddy response header delete no tiene una estructura aprobada")
        response["delete"] = [
            name for name in deleted
            if not isinstance(name, str) or name.lower() not in {field.lower() for field in PUBLIC_RESPONSE_HEADERS}
        ]
    for name, value in PUBLIC_RESPONSE_HEADERS.items():
        current_set[name] = [value]
    response["deferred"] = True


def patch_caddy_json_config(source: dict) -> dict:
    """Normalize public response headers in active Caddy JSON without changing routes."""
    try:
        output = json.loads(json.dumps(source))
    except (TypeError, ValueError) as exc:
        raise ValueError("Caddy JSON no pudo copiarse de forma segura") from exc
    servers = output.get("apps", {}).get("http", {}).get("servers")
    if not isinstance(servers, dict) or not servers:
        raise ValueError("Caddy JSON no contiene servidores HTTP")
    public_servers = []
    for server_name, server in servers.items():
        listen = server.get("listen", []) if isinstance(server, dict) else []
        if any(isinstance(address, str) and address.endswith(":443") for address in listen):
            public_servers.append((server_name, server))
    if not public_servers:
        raise ValueError("No se encontró un servidor HTTPS público de Caddy")
    required_hosts = {"softventaweb.com", "www.softventaweb.com"}
    covered: set[str] = set()
    patched_routes = 0
    for _, server in public_servers:
        routes = server.get("routes")
        if not isinstance(routes, list):
            raise ValueError("Servidor HTTPS de Caddy sin rutas estructuradas")
        for route in routes:
            if not isinstance(route, dict):
                raise ValueError("Ruta Caddy no tiene una estructura aprobada")
            hosts = _public_caddy_hosts(route)
            target_hosts = hosts & required_hosts
            if not target_hosts:
                continue
            if hosts - required_hosts:
                raise ValueError("Una ruta HTTPS mezcla SoftVentaWeb con hosts no aprobados")
            handlers = route.get("handle")
            if not isinstance(handlers, list) or not handlers:
                raise ValueError("Ruta pública Caddy sin cadena de handlers modificable de forma segura")
            header_handlers = [item for item in handlers if isinstance(item, dict) and item.get("handler") == "headers"]
            if len(header_handlers) > 1:
                raise ValueError("Ruta pública contiene varios handlers de encabezados; requiere revisión")
            if header_handlers:
                header_handler = header_handlers[0]
                _set_caddy_response_headers(header_handler)
            else:
                handlers.insert(0, {
                    "handler": "headers",
                    "response": {
                        "set": {name: [value] for name, value in PUBLIC_RESPONSE_HEADERS.items()},
                        "deferred": True,
                    },
                })
            covered.update(target_hosts)
            patched_routes += 1
    if covered != required_hosts:
        missing = ",".join(sorted(required_hosts - covered)) or "unknown"
        raise ValueError("No se cubrieron ambos hosts públicos: " + missing)
    return output


def caddy_topology_profile(source: dict) -> str:
    """Validate the approved live Caddy topology and print no config values."""
    servers = source.get("apps", {}).get("http", {}).get("servers")
    if not isinstance(servers, dict) or not servers:
        raise ValueError("Caddy JSON no contiene servidores HTTP")
    public_servers = []
    recovery_servers = []
    recovery_listener_exact = False
    for server in servers.values():
        if not isinstance(server, dict):
            continue
        listen = server.get("listen", []) or []
        if any(isinstance(item, str) and (item.endswith(":443") or item == "https-443") for item in listen):
            public_servers.append(server)
        if any(item == "127.0.0.1:8443" for item in listen if isinstance(item, str)):
            recovery_servers.append(server)
            recovery_listener_exact = recovery_listener_exact or listen == ["127.0.0.1:8443"]

    public_routes = [
        (hosts, handler)
        for server in public_servers
        for hosts, handler in _iter_caddy_route_handlers(server.get("routes", []) or [])
    ]
    public_hosts = {
        host for hosts, _ in public_routes for host in hosts
        if host in {"softventaweb.com", "www.softventaweb.com"}
    }
    required_hosts = {"softventaweb.com", "www.softventaweb.com"}
    mixed_public_host = any(hosts & required_hosts and hosts - required_hosts for hosts, _ in public_routes)
    apex_frontend_proxy = any(
        "softventaweb.com" in hosts
        and handler.get("handler") == "reverse_proxy"
        and any(
            isinstance(upstream, dict) and upstream.get("dial") == "127.0.0.1:8080"
            for upstream in (handler.get("upstreams", []) or [])
        )
        for hosts, handler in public_routes
    )
    www_redirect = any(
        "www.softventaweb.com" in hosts
        and handler.get("handler") == "static_response"
        and handler.get("status_code") == 308
        and any(
            isinstance(value, str) and value.lower().startswith("https://softventaweb.com")
            for key, values in (handler.get("headers", {}) or {}).items()
            if key.lower() == "location"
            for value in (values if isinstance(values, list) else [values])
        )
        for hosts, handler in public_routes
    )
    public_upstreams = [
        upstream.get("dial", "").lower()
        for hosts, handler in public_routes
        if hosts & required_hosts and handler.get("handler") == "reverse_proxy"
        for upstream in (handler.get("upstreams", []) or []) if isinstance(upstream, dict)
    ]
    direct_backend = any(target in ("backend:3000", "127.0.0.1:3000") for target in public_upstreams)
    public_upstream_set = set(public_upstreams)
    recovery_ok = any(
        handler.get("handler") == "reverse_proxy"
        and any(
            isinstance(upstream, dict) and upstream.get("dial") == "127.0.0.1:8080"
            for upstream in (handler.get("upstreams", []) or [])
        )
        for server in recovery_servers
        for _, handler in _iter_caddy_route_handlers(server.get("routes", []) or [])
    )
    if not (
        public_hosts == {"softventaweb.com", "www.softventaweb.com"}
        and not mixed_public_host and apex_frontend_proxy and www_redirect and recovery_ok
        and public_upstream_set == {"127.0.0.1:8080"} and recovery_listener_exact
    ) or direct_backend:
        raise ValueError("La topologia Caddy no coincide con HTTPS publico y recuperacion loopback aprobados")
    return (
        "CADDY_TOPOLOGY=PASS; https_hosts=2; public_upstream=frontend-loopback; "
        "www_redirect=apex; recovery=127.0.0.1:8443; direct_backend=no"
    )


def self_test() -> None:
    base = (
        "map $http_x_forwarded_proto $pos_forwarded_proto {\n"
        "    ~*^https$ https;\n    default $scheme;\n}\n\n"
        "server {\n    location ^~ /api/ {\n"
        '        add_header X-Content-Type-Options "nosniff" always;\n'
        '        add_header Referrer-Policy "strict-origin-when-cross-origin" always;\n'
        '        add_header X-Frame-Options "DENY" always;\n'
        "        proxy_set_header X-Forwarded-Proto $pos_forwarded_proto;\n"
        "        proxy_pass http://backend:3000;\n    }\n"
        "    location = /index.html {\n        add_header X-Frame-Options \"DENY\" always;\n        try_files $uri =404;\n    }\n"
        "    location = /offline.html {\n        add_header X-Frame-Options \"DENY\" always;\n        try_files $uri =404;\n    }\n"
        "    location ~* \\.(?:css|js)$ {\n        try_files $uri =404;\n    }\n"
        "    location ~* \\.(?:svg|png|ico|woff2)$ {\n        add_header Cache-Control \"no-cache\" always;\n        try_files $uri =404;\n    }\n"
        "    location / {\n        try_files $uri $uri/ /index.html;\n    }\n}\n"
    )
    patched = patch_nginx(base)
    assert "webp" not in patched
    assert patched.count("proxy_hide_header ") == 4
    assert patched.count("add_header Content-Security-Policy") == 3
    assert "add_header Strict-Transport-Security" not in patched
    assert patch_nginx(patched) == patched

    branding = base.replace(
        r"location ~* \.(?:svg|png|ico|woff2)$",
        r"location ~* \.(?:svg|png|webp|ico|woff2)$",
        1,
    )
    assert branding != base and "webp" in branding
    branding_patched = patch_nginx(branding)
    assert "webp" in branding_patched
    assert 'add_header Cache-Control "no-cache" always;' in branding_patched
    assert "try_files $uri $uri/ /index.html;" in branding_patched
    assert patch_nginx(branding_patched) == branding_patched
    assert "NGINX_ACTIVE_PROFILE=rc6-compatible" in nginx_profile(base)
    assert "NGINX_ACTIVE_PROFILE=softventa-branding" in nginx_profile(branding)
    assert "webp=present" in nginx_profile(branding)
    with_compression = branding.replace("server {", "server {\n    gzip on;", 1)
    assert "gzip on;" in patch_nginx(with_compression)

    formatted = base.replace(
        "map $http_x_forwarded_proto $pos_forwarded_proto {",
        "map  $http_x_forwarded_proto  $pos_forwarded_proto {",
        1,
    ).replace("    default $scheme;", "        default   $scheme;", 1)
    assert patch_nginx(formatted).count("add_header Content-Security-Policy") == 3
    invalid_proto = base.replace("default $scheme;", "default https;", 1)
    assert "proto_map=unsupported" in nginx_profile(invalid_proto)
    assert "NGINX_ACTIVE_PROFILE=divergent-unverified" in nginx_profile(invalid_proto)
    try:
        patch_nginx(invalid_proto)
    except ValueError as exc:
        assert str(exc) == "map de X-Forwarded-Proto tiene reglas no aprobadas"
    else:
        raise AssertionError("el parcheador aceptó reglas de proxy no aprobadas")

    nginx_t_fixture = (
        "# configuration file /etc/nginx/nginx.conf:\n"
        "events {}\nhttp {\n"
        "    map $http_x_forwarded_proto $pos_forwarded_proto {\n"
        "        ~*^https$ $scheme;\n    }\n"
        "    include /etc/nginx/conf.d/*.conf;\n}\n"
        "# configuration file /etc/nginx/conf.d/default.conf:\n"
        "server {\n    location / {\n        try_files $uri /index.html;\n    }\n}\n"
        "# configuration file /etc/nginx/conf.d/api.conf:\n"
        "server {\n    location ^~ /api/ {\n"
        "        proxy_set_header X-Forwarded-Proto $scheme;\n"
        "        proxy_pass http://backend:3000;\n    }\n}\n"
    )
    nginx_t_summary = nginx_t_profile(nginx_t_fixture)
    assert "NGINX_T=PASS; config_files=3" in nginx_t_summary
    assert "api_location_files=/etc/nginx/conf.d/api.conf" in nginx_t_summary
    assert "api:^~:backend-3000:xfp-scheme" in nginx_t_summary
    assert "proxy_pass http://" not in nginx_t_summary
    try:
        nginx_t_profile("nginx: configuration file parse failed")
    except ValueError:
        pass
    else:
        raise AssertionError("nginx -T sin secciones de configuración debe rechazarse")

    caddy = (
        "www.softventaweb.com {\n\tredir https://softventaweb.com{uri} 308\n}\n\n"
        "softventaweb.com {\n\treverse_proxy 127.0.0.1:8080\n}\n\n"
        "http://:8443 {\n\tbind 127.0.0.1\n\treverse_proxy 127.0.0.1:8080\n}\n"
    )
    patched_caddy = patch_caddy(caddy)
    assert patched_caddy.count(SECURITY_HEADERS_MARKER) == 2
    assert patched_caddy.count('>Strict-Transport-Security "max-age=31536000"') == 2
    assert "includeSubDomains" not in patched_caddy
    for name, value in PUBLIC_RESPONSE_HEADERS.items():
        assert patched_caddy.count(f'>{name} "{value}"') == 2
    recovery = next(item[3] for item in _caddy_block_ranges(patched_caddy) if item[0] == "http://:8443")
    assert not _caddy_managed_header_operations(recovery)
    assert patch_caddy(patched_caddy) == patched_caddy
    assert "reverse_proxy 127.0.0.1:8080" in patched_caddy
    assert "redir https://softventaweb.com{uri} 308" in patched_caddy
    stripped_security_blocks = re.sub(
        r"(?m)^\t# softventa-security-headers:public-v1\n\theader \{\n"
        r"(?:\t\t>[^\n]*\n)+\t\}\n",
        "",
        patched_caddy,
    )
    assert stripped_security_blocks == caddy
    legacy_hsts = re.sub(
        r"(?m)^([ \t]*(?:www\.)?softventaweb\.com \{)",
        r'\1\n\theader >Strict-Transport-Security "max-age=31536000; includeSubDomains"',
        caddy,
    )
    normalized_legacy = patch_caddy(legacy_hsts)
    assert "includeSubDomains" not in normalized_legacy
    assert normalized_legacy.count(SECURITY_HEADERS_MARKER) == 2
    for invalid in (
        caddy.replace("http://:8443 {", "http://:8443 {\n\theader Strict-Transport-Security bad"),
        caddy.replace("www.softventaweb.com {", "www.softventaweb.com {\n\theader Strict-Transport-Security bad"),
        caddy.replace("softventaweb.com {", "softventaweb.com {\n\timport security-snippet"),
        "import global-security\n" + caddy,
        caddy.replace("softventaweb.com {", "softventaweb.com {\n\theader X-Frame-Options DENY"),
    ):
        try:
            patch_caddy(invalid)
        except ValueError:
            continue
        raise AssertionError("patch_caddy debe rechazar HSTS conflictivo/importaciones")

    caddy_json = {
        "apps": {"http": {"servers": {
            "public": {"listen": [":443"], "routes": [
                {"match": [{"host": ["www.softventaweb.com"]}], "handle": [{"handler": "static_response", "status_code": 308, "headers": {"Location": ["https://softventaweb.com{http.request.uri}"]}}]},
                {"match": [{"host": ["softventaweb.com"]}], "handle": [{"handler": "subroute", "routes": [{"handle": [{"handler": "reverse_proxy", "upstreams": [{"dial": "127.0.0.1:8080"}]}]}]}]},
            ]},
            "recovery": {"listen": ["127.0.0.1:8443"], "routes": [{"handle": [{"handler": "reverse_proxy", "upstreams": [{"dial": "127.0.0.1:8080"}]}]},]},
        }}}}
    original_recovery = json.loads(json.dumps(caddy_json["apps"]["http"]["servers"]["recovery"]))
    candidate_json = patch_caddy_json_config(caddy_json)
    public_routes = candidate_json["apps"]["http"]["servers"]["public"]["routes"]
    assert all(route["handle"][0]["handler"] == "headers" for route in public_routes)
    assert all(route["handle"][0]["response"]["deferred"] is True for route in public_routes)
    assert candidate_json["apps"]["http"]["servers"]["recovery"] == original_recovery
    assert caddy_json["apps"]["http"]["servers"]["public"]["routes"][0]["handle"][0]["handler"] == "static_response"
    assert candidate_json["apps"]["http"]["servers"]["public"]["routes"][1]["handle"][1] == caddy_json["apps"]["http"]["servers"]["public"]["routes"][1]["handle"][0]
    assert patch_caddy_json_config(candidate_json) == candidate_json
    topology_profile = caddy_topology_profile(caddy_json)
    assert "https_hosts=2" in topology_profile and "direct_backend=no" in topology_profile
    invalid_topology = json.loads(json.dumps(caddy_json))
    invalid_topology["apps"]["http"]["servers"]["public"]["routes"][0]["handle"][0]["status_code"] = 302
    try:
        caddy_topology_profile(invalid_topology)
    except ValueError:
        pass
    else:
        raise AssertionError("La topologia debe rechazar una redireccion www distinta de 308")
    invalid_topology = json.loads(json.dumps(caddy_json))
    invalid_topology["apps"]["http"]["servers"]["public"]["routes"][1]["handle"][0]["routes"][0]["handle"][0]["upstreams"][0]["dial"] = "backend:3000"
    try:
        caddy_topology_profile(invalid_topology)
    except ValueError:
        pass
    else:
        raise AssertionError("La topologia debe rechazar un proxy publico directo al backend")
    invalid_topology = json.loads(json.dumps(caddy_json))
    invalid_topology["apps"]["http"]["servers"]["public"]["routes"][1]["match"][0]["host"].append("otro-dominio.invalid")
    try:
        caddy_topology_profile(invalid_topology)
    except ValueError:
        pass
    else:
        raise AssertionError("La topologia debe rechazar hosts mezclados en una ruta publica")
    invalid_topology = json.loads(json.dumps(caddy_json))
    del invalid_topology["apps"]["http"]["servers"]["recovery"]
    try:
        caddy_topology_profile(invalid_topology)
    except ValueError:
        pass
    else:
        raise AssertionError("La topologia debe exigir el listener privado de recuperacion")
    missing_www = json.loads(json.dumps(caddy_json))
    missing_www["apps"]["http"]["servers"]["public"]["routes"].pop(0)
    try:
        patch_caddy_json_config(missing_www)
    except ValueError:
        pass
    else:
        raise AssertionError("El parche Caddy JSON debe rechazar cobertura parcial de hosts")
    example_path = Path(__file__).resolve().parents[1] / "Caddyfile.example"
    if example_path.exists():
        example = example_path.read_text(encoding="utf-8")
        assert patch_caddy(example) == example
    print("SECURITY_CONFIG_PATCHER_SELF_TEST=PASS")
    print("NGINX_PROFILE_VARIANT_TEST=PASS")
    print("NGINX_T_INCLUDES_TEST=PASS")
    print("CADDY_JSON_PATCH_TEST=PASS")
    print("CADDYFILE_PUBLIC_EDGE_TEST=PASS")
    print("CADDY_TOPOLOGY_TEST=PASS")


def main(argv: list[str]) -> None:
    if argv == ["--self-test"]:
        self_test()
        return
    if len(argv) == 3 and argv[0] == "patch-nginx":
        src, dest = map(Path, argv[1:])
        try:
            original = src.read_text(encoding="utf-8")
            patched = patch_nginx(original)
            dest.write_text(patched, encoding="utf-8", newline="")
        except (OSError, ValueError) as exc:
            reason = str(exc).replace("\r", " ").replace("\n", " ")
            print(f"NGINX_PATCH=FAIL; REASON={reason}", file=sys.stderr)
            raise SystemExit(2) from None
        print(nginx_profile(original))
        print("NGINX_PATCH=PASS; unrelated routes/proxy/cache directives preserved")
        return
    if len(argv) == 2 and argv[0] == "inspect-nginx":
        try:
            text = sys.stdin.read() if argv[1] == "-" else Path(argv[1]).read_text(encoding="utf-8")
            print(nginx_profile(text))
        except OSError:
            print("NGINX_PROFILE=FAIL; REASON=archivo-no-disponible", file=sys.stderr)
            raise SystemExit(2) from None
        return
    if len(argv) == 2 and argv[0] == "inspect-nginx-t":
        try:
            dump = sys.stdin.read() if argv[1] == "-" else Path(argv[1]).read_text(encoding="utf-8")
            print(nginx_t_profile(dump))
        except (OSError, ValueError) as exc:
            reason = str(exc).replace("\r", " ").replace("\n", " ")
            print("NGINX_T=FAIL; REASON=" + reason, file=sys.stderr)
            raise SystemExit(2) from None
        return
    if len(argv) == 3 and argv[0] == "patch-caddy":
        src, dest = map(Path, argv[1:])
        dest.write_text(patch_caddy(src.read_text(encoding="utf-8")), encoding="utf-8", newline="")
        print("CADDY_PATCH=PASS")
        return
    if len(argv) == 3 and argv[0] == "patch-caddy-json":
        src, dest = map(Path, argv[1:])
        try:
            active = json.loads(src.read_text(encoding="utf-8"))
            candidate = patch_caddy_json_config(active)
            dest.write_text(json.dumps(candidate, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="")
        except (OSError, json.JSONDecodeError, ValueError) as exc:
            reason = str(exc).replace("\r", " ").replace("\n", " ")
            print("CADDY_JSON_PATCH=FAIL; REASON=" + reason, file=sys.stderr)
            raise SystemExit(2) from None
        print("CADDY_JSON_PATCH=PASS; public_hosts=2; response_headers=5; private_listener=unchanged; routes=preserved")
        return
    if len(argv) == 2 and argv[0] == "inspect-caddy-json":
        try:
            source = json.loads(sys.stdin.read() if argv[1] == "-" else Path(argv[1]).read_text(encoding="utf-8"))
            print(caddy_topology_profile(source))
        except (OSError, json.JSONDecodeError, ValueError) as exc:
            reason = str(exc).replace("\r", " ").replace("\n", " ")
            print("CADDY_TOPOLOGY=FAIL; REASON=" + reason, file=sys.stderr)
            raise SystemExit(2) from None
        return
    if len(argv) == 2 and argv[0] == "cache-revision":
        path = Path(argv[1])
        worker = path.read_text(encoding="utf-8")
        matches = list(re.finditer(r"const CACHE_NAME = 'pos-pwa-shell-([a-f0-9]{16})';", worker))
        if len(matches) != 1:
            raise ValueError("No se encontró exactamente un nombre de caché PWA esperado")
        old = matches[0].group(1)
        new = hashlib.sha256((old + "|softventa-security-headers:v1").encode()).hexdigest()[:16]
        path.write_text(worker[:matches[0].start(1)] + new + worker[matches[0].end(1):], encoding="utf-8", newline="")
        print("PWA_CACHE_REVISION=UPDATED")
        return
    raise SystemExit("uso: patch-security-config.py --self-test | inspect-nginx SRC|- | inspect-nginx-t SRC|- | patch-nginx SRC DST | patch-caddy SRC DST | patch-caddy-json SRC DST | inspect-caddy-json SRC|- | cache-revision SW")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except Exception as exc:
        reason = (str(exc) or type(exc).__name__).replace("\r", " ").replace("\n", " ")
        print("SECURITY_CONFIG_PATCH=FAIL; REASON=" + reason, file=sys.stderr)
        raise SystemExit(1)
