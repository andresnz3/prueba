[CmdletBinding()]
param(
    [switch]$SelfTest,
    [switch]$PrepareCandidateOnly,
    [switch]$Deploy
)

$ErrorActionPreference = 'Stop'
$Target = 'posadmin@31.220.84.51'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$RemoteHelper = Join-Path $PSScriptRoot 'remote-softventa-landing.sh'
$OverlayDockerfile = Join-Path $PSScriptRoot 'landing-overlay.Dockerfile'
$AllowedFiles = @(
    'inicio/index.html',
    'inicio/styles.css',
    'robots.txt',
    'sitemap.xml',
    'assets/pwa/softventaweb-logo.webp',
    'assets/pwa/favicon-16.png',
    'assets/pwa/favicon-32.png',
    'assets/pwa/favicon-48.png'
)

function Assert-SourcePackage {
    foreach ($relative in $AllowedFiles) {
        $source = Join-Path $ProjectRoot ($relative.Replace('/', '\'))
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            throw "Falta el archivo permitido del paquete: $relative"
        }
    }
    foreach ($supportFile in @($RemoteHelper, $OverlayDockerfile)) {
        if (-not (Test-Path -LiteralPath $supportFile -PathType Leaf)) {
            throw "Falta un archivo de soporte del despliegue: $(Split-Path -Leaf $supportFile)"
        }
    }

    $landing = Get-Content -LiteralPath (Join-Path $ProjectRoot 'inicio/index.html') -Raw
    $css = Get-Content -LiteralPath (Join-Path $ProjectRoot 'inicio/styles.css') -Raw
    $robots = Get-Content -LiteralPath (Join-Path $ProjectRoot 'robots.txt') -Raw
    $sitemap = Get-Content -LiteralPath (Join-Path $ProjectRoot 'sitemap.xml') -Raw
    if ($landing -notmatch '<title>SoftVentaWeb \| Sistema POS para negocios</title>' -or
        $landing -notmatch '<link rel="canonical" href="https://softventaweb\.com/inicio/">' -or
        $landing -notmatch 'href="/">Iniciar sesión</a>') {
        throw 'La landing no cumple el título, canonical o enlace de login esperado.'
    }
    if ($landing -match '<script|<iframe|<object|<embed|src="https?://' -or
        $css -match 'url\([^)]*https?://' -or $css -match '@import\s+(?:url\()?\s*["'']?https?://') {
        throw 'La landing incluye contenido activo o recursos externos no aprobados.'
    }
    foreach ($asset in @('/assets/pwa/softventaweb-logo.webp', '/assets/pwa/favicon-16.png', '/assets/pwa/favicon-32.png', '/assets/pwa/favicon-48.png')) {
        if (-not $landing.Contains($asset)) { throw "La landing no referencia el recurso allowlist esperado: $asset" }
    }
    $dockerfileText = Get-Content -LiteralPath $OverlayDockerfile -Raw
    if ($dockerfileText -notmatch '(?m)^FROM \$\{BASE_IMAGE\}$' -or
        $dockerfileText -notmatch 'org\.softventa\.landing\.base-image-id' -or
        $dockerfileText -notmatch '(?m)^COPY --chmod=644 inicio/index\.html ' -or
        $dockerfileText -notmatch '(?m)^COPY --chmod=644 inicio/styles\.css ' -or
        $dockerfileText -notmatch '(?m)^COPY --chmod=644 robots\.txt ' -or
        $dockerfileText -notmatch '(?m)^COPY --chmod=644 sitemap\.xml ' -or
        $dockerfileText -notmatch '(?m)^COPY --chmod=644 assets/pwa/softventaweb-logo\.webp ' -or
        $dockerfileText -notmatch '(?m)^COPY --chmod=644 assets/pwa/favicon-16\.png ' -or
        $dockerfileText -notmatch '(?m)^COPY --chmod=644 assets/pwa/favicon-32\.png ' -or
        $dockerfileText -notmatch '(?m)^COPY --chmod=644 assets/pwa/favicon-48\.png ' -or
        $dockerfileText -notmatch '(?m)^RUN chmod 755 /usr/share/nginx/html/inicio' -or
        $dockerfileText -notmatch 'chmod 644 /usr/share/nginx/html/inicio/index\.html' -or
        $dockerfileText -notmatch 'chmod 644 /usr/share/nginx/html/inicio/styles\.css' -or
        $dockerfileText -notmatch 'chmod 644 /usr/share/nginx/html/robots\.txt' -or
        $dockerfileText -notmatch 'chmod 644 /usr/share/nginx/html/sitemap\.xml' -or
        $dockerfileText -notmatch 'chmod 644 /usr/share/nginx/html/assets/pwa/softventaweb-logo\.webp' -or
        $dockerfileText -notmatch 'chmod 644 /usr/share/nginx/html/assets/pwa/favicon-16\.png' -or
        $dockerfileText -notmatch 'chmod 644 /usr/share/nginx/html/assets/pwa/favicon-32\.png' -or
        $dockerfileText -notmatch 'chmod 644 /usr/share/nginx/html/assets/pwa/favicon-48\.png' -or
        $dockerfileText -match 'noindex, nofollow') {
        throw 'El overlay Dockerfile no está limitado a la landing y metadatos aprobados.'
    }
    if ($robots -notmatch 'Disallow: /api/' -or $robots -notmatch 'Sitemap: https://softventaweb\.com/sitemap\.xml') {
        throw 'robots.txt no conserva las exclusiones y el sitemap esperados.'
    }
    $sitemapLocations = [regex]::Matches($sitemap, '<loc>[^<]+</loc>')
    if ($sitemapLocations.Count -ne 1) {
        throw 'El sitemap debe contener únicamente la URL pública de la landing.'
    }
    if ($sitemapLocations[0].Value -cne '<loc>https://softventaweb.com/inicio/</loc>' -or $sitemap -match '/api/|system-admin|businesses|users') {
        throw 'El sitemap no está limitado a la landing pública.'
    }
}

function Get-PublicCspBaseline {
    $response = & curl.exe -sS -D - -o NUL --max-time 20 'https://softventaweb.com/' 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo leer la respuesta HTTPS pública de SoftVentaWeb.' }
    $raw = $response -join "`n"
    if ($raw -notmatch '(?im)^HTTP/\S+\s+200\b') { throw 'La página pública no respondió HTTP 200.' }
    $csp = [regex]::Matches($raw, '(?im)^Content-Security-Policy:\s*(.+?)\s*$')
    $hsts = [regex]::Matches($raw, '(?im)^Strict-Transport-Security:\s*(.+?)\s*$')
    if ($csp.Count -ne 1) { throw 'La respuesta pública no contiene exactamente una CSP.' }
    if ($hsts.Count -ne 1) { throw 'La respuesta pública no contiene exactamente un HSTS.' }
    $policy = $csp[0].Groups[1].Value.Trim()
    foreach ($directive in @("default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self'", "font-src 'self'", "connect-src 'self'")) {
        if ($policy -notlike "*$directive*") { throw 'La CSP pública no permite únicamente el origen necesario para esta landing.' }
    }
    if ($policy -match '(?i)(?:script-src|connect-src)[^;]*https?://|unsafe-eval') {
        throw 'La CSP pública difiere de la política estricta esperada.'
    }
    $localCsp = & node.exe -e "process.stdout.write(require(process.argv[1]).readFrontendCsp())" (Join-Path $ProjectRoot 'tests/helpers/security-headers.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo leer la CSP utilizada por la prueba Playwright local.' }
    if (($localCsp -join '').Trim() -cne $policy) {
        throw 'La CSP usada por Playwright local difiere de la política HTTPS activa; no se validará la candidata con una política distinta.'
    }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($policy)
        $cspHash = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally { $sha.Dispose() }
    Write-Host 'PLAYWRIGHT_CSP_MATCH=PASS; local browser tests use the active public policy'
    return $cspHash
}

function Invoke-RemoteLanding {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('--prepare-only', '--deploy')][string]$Mode,
        [Parameter(Mandatory = $true)][string]$CspHash
    )

    $nonce = [Guid]::NewGuid().ToString('N').Substring(0, 16)
    $tempRoot = [System.IO.Path]::GetFullPath($env:TEMP)
    $localStage = Join-Path $tempRoot "pos-softventa-landing-$nonce"
    $remoteStage = "/home/posadmin/.pos-softventa-landing-$nonce"
    $packagePath = Join-Path $localStage 'package.tar.gz'
    $createdStage = $false

    try {
        New-Item -ItemType Directory -Path $localStage | Out-Null
        $createdStage = $true
        New-Item -ItemType Directory -Path (Join-Path $localStage 'inicio') | Out-Null
        New-Item -ItemType Directory -Path (Join-Path $localStage 'assets/pwa') -Force | Out-Null
        foreach ($relative in $AllowedFiles) {
            $source = Join-Path $ProjectRoot ($relative.Replace('/', '\'))
            $destination = Join-Path $localStage ($relative.Replace('/', '\'))
            Copy-Item -LiteralPath $source -Destination $destination
        }

        $dockerfilePath = Join-Path $localStage 'Dockerfile'
        Copy-Item -LiteralPath $OverlayDockerfile -Destination $dockerfilePath

        $tar = Get-Command tar.exe -ErrorAction Stop
        $tarArgs = @('-czf', $packagePath, '-C', $localStage, 'Dockerfile', 'inicio/index.html', 'inicio/styles.css', 'robots.txt', 'sitemap.xml', 'assets/pwa/softventaweb-logo.webp', 'assets/pwa/favicon-16.png', 'assets/pwa/favicon-32.png', 'assets/pwa/favicon-48.png')
        & $tar.Source @tarArgs
        if ($LASTEXITCODE -ne 0) { throw 'No se pudo crear el paquete allowlist.' }

        $archiveEntries = @(& $tar.Source '-tzf' $packagePath | Sort-Object)
        $expectedEntries = @('Dockerfile', 'inicio/index.html', 'inicio/styles.css', 'robots.txt', 'sitemap.xml', 'assets/pwa/softventaweb-logo.webp', 'assets/pwa/favicon-16.png', 'assets/pwa/favicon-32.png', 'assets/pwa/favicon-48.png') | Sort-Object
        if (Compare-Object -ReferenceObject $expectedEntries -DifferenceObject $archiveEntries) {
            throw 'El archivo transferible incluye contenido fuera de la lista aprobada.'
        }
        $packageHash = (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant()
        $helperHash = (Get-FileHash -LiteralPath $RemoteHelper -Algorithm SHA256).Hash.ToLowerInvariant()

        $ssh = (Get-Command ssh.exe -ErrorAction Stop).Source
        $scp = (Get-Command scp.exe -ErrorAction Stop).Source
        $targetStage = "${Target}:$remoteStage/"
        & $ssh -o BatchMode=yes -o StrictHostKeyChecking=yes $Target "mkdir -m 700 -- '$remoteStage'"
        if ($LASTEXITCODE -ne 0) { throw 'No se pudo preparar el directorio temporal remoto.' }
        & $scp -o BatchMode=yes -o StrictHostKeyChecking=yes $packagePath $RemoteHelper $targetStage
        if ($LASTEXITCODE -ne 0) { throw 'No se pudo transferir el paquete temporal por SSH.' }
        & $ssh -o BatchMode=yes -o StrictHostKeyChecking=yes $Target "chmod 600 -- '$remoteStage/package.tar.gz' '$remoteStage/remote-softventa-landing.sh'"
        if ($LASTEXITCODE -ne 0) { throw 'No se pudieron restringir los permisos del paquete remoto.' }

        $remoteMode = if ($Mode -eq '--deploy') { '--deploy' } else { '--prepare-only' }
        $remoteCommand = "sudo -v && sudo /bin/bash '$remoteStage/remote-softventa-landing.sh' '$remoteMode' '$remoteStage/package.tar.gz' '$packageHash' '$helperHash' '$CspHash'"
        & $ssh -tt -o StrictHostKeyChecking=yes $Target $remoteCommand
        $remoteExit = $LASTEXITCODE
        if ($remoteExit -ne 0) { throw "La etapa remota terminó con código $remoteExit. No se asumirá que hubo publicación." }

        & $ssh -o BatchMode=yes -o StrictHostKeyChecking=yes $Target "rm -f -- '$remoteStage/package.tar.gz' '$remoteStage/remote-softventa-landing.sh' && rmdir -- '$remoteStage'" | Out-Null
        if ($LASTEXITCODE -ne 0) { Write-Warning 'La carpeta temporal remota quedó para limpieza manual; no contiene secretos.' }
    }
    finally {
        if ($createdStage) {
            $resolvedStage = [System.IO.Path]::GetFullPath($localStage)
            if ($resolvedStage.StartsWith($tempRoot.TrimEnd('\') + '\', [System.StringComparison]::OrdinalIgnoreCase) -and
                (Split-Path -Leaf $resolvedStage) -match '^pos-softventa-landing-[a-f0-9]{16}$') {
                Remove-Item -LiteralPath $resolvedStage -Recurse -Force
            }
        }
    }
}

if ($SelfTest) {
    $tokens = $null
    $parseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($PSCommandPath, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count -gt 0) { throw 'La sintaxis PowerShell del helper no es válida.' }
    Assert-SourcePackage
    $helperText = Get-Content -LiteralPath $RemoteHelper -Raw
    if ($helperText -match 'docker\s+(?:system\s+prune|volume\s+prune)|compose\s+down\s+-v|migrate:all') {
        throw 'El helper contiene una operación prohibida.'
    }
    Write-Output 'POWERSHELL_SYNTAX=PASS'
    Write-Output 'ALLOWLIST=PASS; package=landing+required-assets+robots+sitemap+Dockerfile'
    Write-Output 'OVERLAY_DOCKERFILE_SCOPE=PASS; base-image+landing+required-assets+644-755; root-POS-unchanged'
    Write-Output 'NO_BACKEND_MYSQL_CADDY_MIGRATIONS=PASS'
    exit 0
}

if ($PrepareCandidateOnly -eq $Deploy) {
    throw 'Elegí exactamente una modalidad: -PrepareCandidateOnly o -Deploy.'
}

Assert-SourcePackage
$cspHash = Get-PublicCspBaseline
Write-Output 'PUBLIC_CSP_PREFLIGHT=PASS; one CSP and HSTS; same-origin resources allowed'
$mode = if ($Deploy) { '--deploy' } else { '--prepare-only' }
Invoke-RemoteLanding -Mode $mode -CspHash $cspHash
