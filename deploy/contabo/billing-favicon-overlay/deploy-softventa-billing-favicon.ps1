[CmdletBinding()]
param(
    [switch]$SelfTest,
    [switch]$PrepareCandidateOnly,
    [switch]$Deploy,
    [switch]$Rollback,
    [string]$RollbackTag
)

$ErrorActionPreference = 'Stop'
$Target = 'posadmin@31.220.84.51'
$PayloadDir = Join-Path $PSScriptRoot 'payload'
$RemoteHelper = Join-Path $PSScriptRoot 'remote-deploy-softventa-billing-favicon.sh'
$PayloadFiles = @('Dockerfile.backend','Dockerfile.frontend','apply-softventa-overlay.cjs','backend.patch','frontend.patch','MANIFEST.sha256','softventaweb-favicon-20261106-16.png','softventaweb-favicon-20261106-32.png','softventaweb-favicon-20261106-48.png','softventaweb-favicon-20261106.svg','softventaweb-touch-20261106-192.png','softventaweb-pwa-20261106-512.png')
$OuterFiles = @(
    'README.md',
    'deploy-softventa-billing-favicon.ps1',
    'remote-deploy-softventa-billing-favicon.sh',
    'payload\Dockerfile.backend',
    'payload\Dockerfile.frontend',
    'payload\apply-softventa-overlay.cjs',
    'payload\backend.patch',
    'payload\frontend.patch',
    'payload\MANIFEST.sha256',
    'payload\softventaweb-favicon-20261106-16.png',
    'payload\softventaweb-favicon-20261106-32.png',
    'payload\softventaweb-favicon-20261106-48.png',
    'payload\softventaweb-favicon-20261106.svg',
    'payload\softventaweb-touch-20261106-192.png',
    'payload\softventaweb-pwa-20261106-512.png'
)

function New-DeterministicPackageArchive {
    param([string]$Stage, [string]$ArchivePath, [string[]]$Files)
    $tar = (Get-Command tar.exe -ErrorAction Stop).Source
    $rawTarPath = $ArchivePath + '.raw'
    & $tar '-cf' $rawTarPath '--format=ustar' '--mtime=@1577836800' '--uid=0' '--gid=0' '--uname=root' '--gname=root' '-C' $Stage @Files
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo crear el TAR normalizado.' }
    $inputStream = $null
    $outputStream = $null
    $gzipStream = $null
    try {
        $inputStream = [System.IO.File]::OpenRead($rawTarPath)
        $outputStream = [System.IO.File]::Create($ArchivePath)
        $gzipStream = [System.IO.Compression.GZipStream]::new($outputStream, [System.IO.Compression.CompressionMode]::Compress, $true)
        $inputStream.CopyTo($gzipStream)
    }
    finally {
        if ($gzipStream) { $gzipStream.Dispose() }
        if ($inputStream) { $inputStream.Dispose() }
        if ($outputStream) { $outputStream.Dispose() }
        if (Test-Path -LiteralPath $rawTarPath -PathType Leaf) { Remove-Item -LiteralPath $rawTarPath -Force }
    }
}

function Assert-Manifest {
    param([string]$ManifestPath, [string]$Root, [string[]]$Expected)
    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { throw "Falta manifiesto: $ManifestPath" }
    $rows = @(Get-Content -LiteralPath $ManifestPath)
    $actualNames = @()
    foreach ($row in $rows) {
        if ($row -notmatch '^([a-f0-9]{64})  (.+)$') { throw 'Formato SHA-256 inválido en el manifiesto.' }
        $hash = $Matches[1]
        $relative = $Matches[2].Replace('/','\')
        if ($relative -notin $Expected) { throw "El manifiesto contiene una ruta fuera del allowlist: $relative" }
        $actualNames += $relative
        $file = Join-Path $Root $relative
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Falta archivo allowlist: $relative" }
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant() -ne $hash) { throw "SHA-256 incorrecto: $relative" }
    }
    $expectedSorted = @($Expected | Sort-Object)
    $actualSorted = @($actualNames | Sort-Object)
    if (Compare-Object -ReferenceObject $expectedSorted -DifferenceObject $actualSorted) { throw 'El manifiesto no cubre exactamente el allowlist.' }
}

function Assert-LinuxScriptLineEndings {
    $scripts = @(Get-ChildItem -LiteralPath $PSScriptRoot -File -Recurse | Where-Object { $_.Extension -eq '.sh' })
    if (-not $scripts.Count) { throw 'No se encontrÃ³ el helper Linux del paquete.' }
    foreach ($script in $scripts) {
        $bytes = [System.IO.File]::ReadAllBytes($script.FullName)
        if ([Array]::IndexOf($bytes, [byte]13) -ge 0) { throw "CR/CRLF detected in Linux script: $($script.Name)" }
    }
}

function Assert-ComposeConfigArgument {
    $helperText = Get-Content -LiteralPath $RemoteHelper -Raw
    $functionMatch = [System.Text.RegularExpressions.Regex]::Match($helperText, '(?ms)^compose_fields\(\) \{\r?\n(?<body>.*?)^\}')
    if (-not $functionMatch.Success) { throw 'No se encontro la funcion compose_fields para autoprueba.' }
    $composeBody = $functionMatch.Groups['body'].Value
    $pythonCodeMatch = [System.Text.RegularExpressions.Regex]::Match($composeBody, '(?s)python3 -c ''(?<code>.*?)'' "\$1"\s*$')
    if ($composeBody -notmatch 'sys\.argv\[1\]' -or
        -not $pythonCodeMatch.Success -or
        -not $helperText.Contains('compose_fields "$WORK/compose.json"')) {
        throw 'compose_fields debe pasar el JSON de Compose como sys.argv[1].'
    }

    $testDirectory = Join-Path ([System.IO.Path]::GetFullPath($env:TEMP)) ('softventa-compose-argv-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $testDirectory | Out-Null
    try {
        $pythonPath = Join-Path $testDirectory 'compose-fields.py'
        $jsonPath = Join-Path $testDirectory 'compose.json'
        $probePath = Join-Path $testDirectory 'python-probe.py'
        [System.IO.File]::WriteAllText($pythonPath, $pythonCodeMatch.Groups['code'].Value, [System.Text.UTF8Encoding]::new($false))
        [System.IO.File]::WriteAllText($probePath, 'import sys', [System.Text.UTF8Encoding]::new($false))
        $fixture = '{"services":{"backend":{"environment":{"DB_NAME":"pos_contabo_prod_20261106"},"image":"pos-backend:test"},"mysql":{"environment":{"MYSQL_DATABASE":"pos_contabo_prod_20261106"},"image":"mysql:test"},"frontend":{"image":"pos-frontend:test"},"migrate":{"image":"pos-backend:test"}}}'
        [System.IO.File]::WriteAllText($jsonPath, $fixture, [System.Text.UTF8Encoding]::new($false))

        $pythonCandidates = @()
        $pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
        if ($pythonCommand) { $pythonCandidates += $pythonCommand.Source }
        $localPythonRoot = Join-Path $env:LOCALAPPDATA 'Programs\Python'
        if (Test-Path -LiteralPath $localPythonRoot -PathType Container) {
            $pythonCandidates += @(Get-ChildItem -LiteralPath $localPythonRoot -Directory -Filter 'Python*' | Sort-Object Name -Descending | ForEach-Object { Join-Path $_.FullName 'python.exe' })
        }
        $pythonRuntime = $null
        $previousErrorActionPreference = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
        foreach ($candidate in @($pythonCandidates | Select-Object -Unique)) {
            try {
                $null = @(& $candidate $probePath 2>&1)
                $probeExitCode = $LASTEXITCODE
                if ($probeExitCode -eq 0) { $pythonRuntime = $candidate; break }
            }
            catch { continue }
        }
        if (-not $pythonRuntime) { return 'STRUCTURAL_ONLY' }

        $missingOutput = @(& $pythonRuntime $pythonPath 2>&1)
        $missingExitCode = $LASTEXITCODE
        if ($missingExitCode -eq 0 -or ($missingOutput -join "`n") -notmatch 'IndexError: list index out of range') {
            throw 'La autoprueba no reprodujo el error sys.argv[1] sin argumento.'
        }

        $actual = @(& $pythonRuntime $pythonPath $jsonPath 2>&1)
        $validExitCode = $LASTEXITCODE
        $expected = @('pos_contabo_prod_20261106','pos_contabo_prod_20261106','pos-backend:test','pos-frontend:test','pos-backend:test')
        if ($validExitCode -ne 0 -or (($actual -join "`n") -cne ($expected -join "`n"))) {
            throw 'La autoprueba de argumentos no recupero los cinco campos de Compose.'
        }
        return 'PYTHON_RUNTIME'
        }
        finally { $ErrorActionPreference = $previousErrorActionPreference }
    }
    finally {
        $resolvedTestDirectory = [System.IO.Path]::GetFullPath($testDirectory)
        $allowedTempPrefix = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
        if ($resolvedTestDirectory.StartsWith($allowedTempPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
            (Split-Path -Leaf $resolvedTestDirectory) -match '^softventa-compose-argv-[a-f0-9]{32}$') {
            Remove-Item -LiteralPath $resolvedTestDirectory -Recurse -Force
        }
    }
}

function Assert-CategoryValidator {
    $helperText = Get-Content -LiteralPath $RemoteHelper -Raw
    $categoryMatch = [System.Text.RegularExpressions.Regex]::Match($helperText, '(?ms)^verify_category_source\(\) \{\r?\n(?<body>.*?)^\}')
    if (-not $categoryMatch.Success) { throw 'No se encontro verify_category_source para autoprueba.' }
    $body = $categoryMatch.Groups['body'].Value
    $labels = @('route_get','route_create_admin','route_rename_admin','list_business_scope','create_business_insert','create_business_binding','category_id_business_scope','rename_business_binding','service_admin_guard','service_business_context')
    foreach ($label in $labels) {
        if (-not $body.Contains("check $label ")) { throw "Falta diagnóstico individual para categoría: $label" }
    }
    $bashSingleQuote = [string][char]39 + [char]92 + [char]39 + [char]39
    $requiredQuotedChecks = @(
        ('grep -Eq "router.get\\(' + $bashSingleQuote + '/product-categories' + $bashSingleQuote + '" "$r"'),
        ('grep -Eq "router.post\\(' + $bashSingleQuote + '/product-categories' + $bashSingleQuote + ', m.admin" "$r"'),
        ('grep -Eq "router.patch\\(' + $bashSingleQuote + '/product-categories/:id' + $bashSingleQuote + ', m.admin" "$r"'),
        ('grep -Fq "current.role !== ' + $bashSingleQuote + 'ADMIN' + $bashSingleQuote + '" "$s"')
    )
    foreach ($required in $requiredQuotedChecks) {
        if (-not $body.Contains($required)) { throw 'El validador de categorías perdió el escape de comillas anidadas.' }
    }
    if (-not $helperText.Contains("! -path " + $bashSingleQuote + '/usr/share/nginx/html/assets/pwa/softventaweb-favicon-20261106-*' + $bashSingleQuote) -or
        -not $helperText.Contains('const CACHE_PREFIX = ' + $bashSingleQuote + 'pos-pwa-shell-' + $bashSingleQuote) -or
        -not $helperText.Contains('grep -Fq "\"/api-client.js\"" /usr/share/nginx/html/service-worker.js')) {
        throw 'Hay una comprobación anidada de frontend con comillas sin conservar.'
    }
    return 'PASS'
}

function Assert-FrontendProtectedHashing {
    $helperText = Get-Content -LiteralPath $RemoteHelper -Raw
    $finderMatch = [System.Text.RegularExpressions.Regex]::Match($helperText, '(?ms)^frontend_protected_hashes\(\) \{\r?\n(?<body>.*?)^\}')
    if (-not $finderMatch.Success) { throw 'No se encontro frontend_protected_hashes para autoprueba.' }
    $finder = $finderMatch.Groups['body'].Value
    $bashSingleQuote = [string][char]39 + [char]92 + [char]39 + [char]39
    $requiredExcludes = @(
        ('! -path ' + $bashSingleQuote + '/usr/share/nginx/html/assets/pwa/softventaweb-favicon-20261106-*' + $bashSingleQuote),
        ('! -path ' + $bashSingleQuote + '/usr/share/nginx/html/assets/pwa/softventaweb-favicon-20261106.svg' + $bashSingleQuote),
        '! -path /usr/share/nginx/html/assets/pwa/softventaweb-touch-20261106-192.png',
        '! -path /usr/share/nginx/html/assets/pwa/softventaweb-pwa-20261106-512.png'
    )
    foreach ($required in $requiredExcludes) {
        if (-not $finder.Contains($required)) { throw "Falta exclusion precisa del recurso favicon autorizado: $required" }
    }
    if ($finder -notmatch 'find /etc/nginx/conf\.d /usr/share/nginx/html -type f' -or
        $finder -match '/assets/pwa/\*|softventaweb-logo\.webp|styles\.css|inicio/styles\.css') {
        throw 'El hash protegido amplió demasiado el allowlist o dejó de cubrir Nginx, CSS, logo o landing.'
    }
    $surfaceLabels = @('history_search_markup','service_worker_cache_prefix','service_worker_api_client_precache','history_search_logic','pos_favicon_png','landing_favicon_png','shortcut_icon_link','apple_touch_icon_link','manifest_cache_bust','manifest_touch_icon','manifest_pwa_icon','service_worker_svg_favicon')
    $surfaceMatch = [System.Text.RegularExpressions.Regex]::Match($helperText, '(?ms)^docker run --rm --network none --entrypoint /bin/sh "\$candidate_front_id" -ec ''(?<body>.*?)'' \|\| die')
    if (-not $surfaceMatch.Success) { throw 'No se encontro el bloque de validacion de iconos y service worker.' }
    foreach ($label in $surfaceLabels) {
        if (-not $surfaceMatch.Groups['body'].Value.Contains("check $label ")) { throw "Falta diagnostico frontend individual: $label" }
    }
    foreach ($status in @("compare_html('POS_HTML_ALLOWLIST'", "compare_html('LANDING_HTML_ALLOWLIST'", 'PWA_MANIFEST_ALLOWLIST=FAIL','SERVICE_WORKER_PRECACHE_ALLOWLIST=FAIL','SERVICE_WORKER_SOURCE_ALLOWLIST=FAIL')) {
        if (-not $helperText.Contains($status)) { throw "Falta diagnostico individual de presentacion: $status" }
    }

    $compareMatch = [System.Text.RegularExpressions.Regex]::Match($helperText, '(?ms)^compare_protected_hashes\(\) \{\r?\n\s*python3 - "\$1" "\$2" "\$3" <<''PY''\r?\n(?<code>.*?)^PY\r?\n\}')
    if (-not $compareMatch.Success -or
        $compareMatch.Groups['code'].Value -notmatch 'PROTECTED_FILE_CHANGE path=.*old_sha256=.*new_sha256=' -or
        $compareMatch.Groups['code'].Value -notmatch 'old or "MISSING"' -or
        $compareMatch.Groups['code'].Value -notmatch 'new or "MISSING"') {
        throw 'Falta el diagnostico individual de nombre y SHA-256 anterior/nuevo.'
    }

    $pythonCandidates = @()
    $pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($pythonCommand) { $pythonCandidates += $pythonCommand.Source }
    $localPythonRoot = Join-Path $env:LOCALAPPDATA 'Programs\Python'
    if (Test-Path -LiteralPath $localPythonRoot -PathType Container) {
        $pythonCandidates += @(Get-ChildItem -LiteralPath $localPythonRoot -Directory -Filter 'Python*' | Sort-Object Name -Descending | ForEach-Object { Join-Path $_.FullName 'python.exe' })
    }
    $pythonRuntime = $null
    foreach ($candidate in @($pythonCandidates | Select-Object -Unique)) {
        try {
            $null = @(& $candidate -c 'import sys' 2>&1)
            if ($LASTEXITCODE -eq 0) { $pythonRuntime = $candidate; break }
        }
        catch { continue }
    }
    if (-not $pythonRuntime) { return 'STRUCTURAL_ONLY' }

    $testDirectory = Join-Path ([System.IO.Path]::GetFullPath($env:TEMP)) ('softventa-protected-hash-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $testDirectory | Out-Null
    try {
        $comparatorPath = Join-Path $testDirectory 'compare-protected.py'
        $beforePath = Join-Path $testDirectory 'before.sha256'
        $afterPath = Join-Path $testDirectory 'after.sha256'
        [System.IO.File]::WriteAllText($comparatorPath, $compareMatch.Groups['code'].Value, [System.Text.UTF8Encoding]::new($false))
        $a = 'a' * 64
        $b = 'b' * 64
        $c = 'c' * 64
        $css = '/usr/share/nginx/html/styles.css'
        $svg = '/usr/share/nginx/html/assets/pwa/softventaweb-favicon-20261106.svg'
        [System.IO.File]::WriteAllText($beforePath, "$a  $css`n", [System.Text.UTF8Encoding]::new($false))
        [System.IO.File]::WriteAllText($afterPath, "$c  $css`n", [System.Text.UTF8Encoding]::new($false))
        $changed = @(& $pythonRuntime $comparatorPath FRONTEND $beforePath $afterPath 2>&1)
        $changedExit = $LASTEXITCODE
        if ($changedExit -ne 1 -or ($changed -join "`n") -notmatch "FRONTEND_PROTECTED_FILE_CHANGE path=$([regex]::Escape($css)) old_sha256=$a new_sha256=$c") {
            throw 'La autoprueba no informo una modificacion CSS con ambos SHA-256.'
        }

        [System.IO.File]::WriteAllText($afterPath, "$a  $css`n$b  $svg`n", [System.Text.UTF8Encoding]::new($false))
        $added = @(& $pythonRuntime $comparatorPath FRONTEND $beforePath $afterPath 2>&1)
        $addedExit = $LASTEXITCODE
        if ($addedExit -ne 1 -or ($added -join "`n") -notmatch "FRONTEND_PROTECTED_FILE_CHANGE path=$([regex]::Escape($svg)) old_sha256=MISSING new_sha256=$b") {
            throw 'La autoprueba no detecto una ruta nueva con SHA anterior ausente.'
        }

        [System.IO.File]::WriteAllText($beforePath, "$a  $css`n", [System.Text.UTF8Encoding]::new($false))
        [System.IO.File]::WriteAllText($afterPath, "$a  $css`n", [System.Text.UTF8Encoding]::new($false))
        $same = @(& $pythonRuntime $comparatorPath FRONTEND $beforePath $afterPath 2>&1)
        if ($LASTEXITCODE -ne 0 -or ($same -join "`n") -notmatch 'FRONTEND_PROTECTED_HASHES=PASS') {
            throw 'La autoprueba rechazo hashes identicos.'
        }
        return 'PYTHON_FIXTURES'
    }
    finally {
        $resolvedTestDirectory = [System.IO.Path]::GetFullPath($testDirectory)
        $allowedTempPrefix = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
        if ($resolvedTestDirectory.StartsWith($allowedTempPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
            (Split-Path -Leaf $resolvedTestDirectory) -match '^softventa-protected-hash-[a-f0-9]{32}$') {
            Remove-Item -LiteralPath $resolvedTestDirectory -Recurse -Force
        }
    }
}

function Assert-HtmlAllowlistComparator {
    $helperText = Get-Content -LiteralPath $RemoteHelper -Raw
    $codeMatch = [System.Text.RegularExpressions.Regex]::Match($helperText, '(?ms)^python3 - "\$WORK/active-index\.html".*?<<''PY''\r?\n(?<code>.*?)^PY\r?\n')
    if (-not $codeMatch.Success -or
        $codeMatch.Groups['code'].Value -notmatch 'unified_diff' -or
        $codeMatch.Groups['code'].Value -notmatch 'compare_html\(' -or
        $codeMatch.Groups['code'].Value -notmatch 'POS_HTML_ALLOWLIST') {
        throw 'Falta el comparador HTML con diff acotado.'
    }
    $pythonCandidates = @()
    $pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($pythonCommand) { $pythonCandidates += $pythonCommand.Source }
    $localPythonRoot = Join-Path $env:LOCALAPPDATA 'Programs\Python'
    if (Test-Path -LiteralPath $localPythonRoot -PathType Container) {
        $pythonCandidates += @(Get-ChildItem -LiteralPath $localPythonRoot -Directory -Filter 'Python*' | Sort-Object Name -Descending | ForEach-Object { Join-Path $_.FullName 'python.exe' })
    }
    $pythonRuntime = $null
    foreach ($candidate in @($pythonCandidates | Select-Object -Unique)) {
        try {
            $null = @(& $candidate -c 'import difflib,json,re,sys' 2>&1)
            if ($LASTEXITCODE -eq 0) { $pythonRuntime = $candidate; break }
        }
        catch { continue }
    }
    if (-not $pythonRuntime) { return 'STRUCTURAL_ONLY' }

    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $testDirectory = Join-Path ([System.IO.Path]::GetFullPath($env:TEMP)) ('softventa-html-diff-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $testDirectory | Out-Null
    try {
        $comparatorPath = Join-Path $testDirectory 'compare-html.py'
        [System.IO.File]::WriteAllText($comparatorPath, $codeMatch.Groups['code'].Value, [System.Text.UTF8Encoding]::new($false))
        $paths = @('active-index.html','candidate-index.html','active-landing.html','candidate-landing.html','active-manifest.webmanifest','candidate-manifest.webmanifest','active-service-worker.js','candidate-service-worker.js') | ForEach-Object { Join-Path $testDirectory $_ }
        $activeIndex = @'
<!doctype html>
<html>
<head>
    <title>SoftVentaWeb</title>
    <meta charset="utf-8">
    <link rel="manifest" href="/manifest.webmanifest">
    <link rel="icon" href="/assets/pwa/old-icon.png">
    <link rel="stylesheet" href="/styles.css">
</head>
<body>
<form id="loginForm"><input id="loginUsername" name="username"></form>
<script src="/app.js"></script>
    <p id="connectedHistoryStatus">status</p>
</body>
</html>
'@
        $candidateIndex = @'
<!doctype html>
<html>
<head>
    <title>SoftVentaWeb</title>
    <meta charset="utf-8">
    <link rel="manifest" href="/manifest.webmanifest?v=20261106">


    <link rel="stylesheet" href="/styles.css">
    <link rel="icon" href="/assets/pwa/softventaweb-favicon-20261106-16.png">
    <link rel="shortcut icon" href="/assets/pwa/softventaweb-favicon-20261106-32.png">
    <link rel="icon" href="/assets/pwa/softventaweb-favicon-20261106.svg">
</head>
<body>
<form id="loginForm"><input id="loginUsername" name="username"></form>
<script src="/app.js"></script>
    <!-- SOFTVENTA_INVOICE_SEARCH_START -->
<div class="form-group" style="max-width: 420px; margin-bottom: 12px;">
    <label for="historyInvoiceSearch">Buscar facturas por número, detalle o nombre del cliente</label>
    <input id="historyInvoiceSearch" type="search" maxlength="100">
</div>
<!-- SOFTVENTA_INVOICE_SEARCH_END -->
<p id="connectedHistoryStatus">status</p>
</body>
</html>
'@
        $activeLanding = @'
<html>
<head>
<title>SoftVentaWeb | POS</title>
<link rel="canonical" href="https://softventa.invalid/inicio/">
<link rel="icon" href="/old-icon.png">
<meta name="description" content="Landing">
<link rel="stylesheet" href="/inicio/styles.css">
</head>
<body>landing</body>
</html>
'@
        $candidateLanding = @'
<html>
<head>
<title>SoftVentaWeb | POS</title>
<link rel="canonical" href="https://softventa.invalid/inicio/">


<meta name="description" content="Landing">
<link rel="stylesheet" href="/inicio/styles.css">
    <link rel="icon" href="/assets/pwa/softventaweb-favicon-20261106-32.png">
</head>
<body>landing</body>
</html>
'@
        [System.IO.File]::WriteAllText($paths[0], $activeIndex, [System.Text.UTF8Encoding]::new($false))
        [System.IO.File]::WriteAllText($paths[1], $candidateIndex, [System.Text.UTF8Encoding]::new($false))
        [System.IO.File]::WriteAllText($paths[2], $activeLanding, [System.Text.UTF8Encoding]::new($false))
        [System.IO.File]::WriteAllText($paths[3], $candidateLanding, [System.Text.UTF8Encoding]::new($false))
        $activeManifest = @{ name='SoftVentaWeb'; icons=@(@{src='/assets/pwa/old-192.png';sizes='192x192'},@{src='/assets/pwa/old-512.png';sizes='512x512'}) } | ConvertTo-Json -Compress
        $candidateManifest = @{ name='SoftVentaWeb'; icons=@(@{src='/assets/pwa/softventaweb-touch-20261106-192.png';sizes='192x192'},@{src='/assets/pwa/softventaweb-pwa-20261106-512.png';sizes='512x512'}) } | ConvertTo-Json -Compress
        [System.IO.File]::WriteAllText($paths[4], $activeManifest, [System.Text.UTF8Encoding]::new($false))
        [System.IO.File]::WriteAllText($paths[5], $candidateManifest, [System.Text.UTF8Encoding]::new($false))
        $oldUrls = @('/api-client.js','/app.js','/connected-sales.js','/index.html')
        $requiredUrls = @('/manifest.webmanifest?v=20261106','/assets/pwa/softventaweb-favicon-20261106-16.png','/assets/pwa/softventaweb-favicon-20261106-32.png','/assets/pwa/softventaweb-favicon-20261106-48.png','/assets/pwa/softventaweb-favicon-20261106.svg','/assets/pwa/softventaweb-touch-20261106-192.png','/assets/pwa/softventaweb-pwa-20261106-512.png')
        $newUrlsJson = '["/api-client.js","/app.js","/assets/pwa/softventaweb-favicon-20261106-16.png","/assets/pwa/softventaweb-favicon-20261106-32.png","/assets/pwa/softventaweb-favicon-20261106-48.png","/assets/pwa/softventaweb-favicon-20261106.svg","/assets/pwa/softventaweb-pwa-20261106-512.png","/assets/pwa/softventaweb-touch-20261106-192.png","/connected-sales.js","/index.html","/manifest.webmanifest?v=20261106"]'
        $workerOld = "const CACHE_NAME = 'pos-pwa-shell-v1';`nconst CACHE_PREFIX = 'pos-pwa-shell-';`nconst PRECACHE_URLS = $(ConvertTo-Json -InputObject $oldUrls -Compress);`nself.addEventListener('install', () => {});`n"
        $workerNew = "const CACHE_NAME = 'pos-pwa-shell-billing-favicon-test';`nconst CACHE_PREFIX = 'pos-pwa-shell-';`nconst PRECACHE_URLS = $newUrlsJson;`nself.addEventListener('install', () => {});`n"
        [System.IO.File]::WriteAllText($paths[6], $workerOld, [System.Text.UTF8Encoding]::new($false))
        [System.IO.File]::WriteAllText($paths[7], $workerNew, [System.Text.UTF8Encoding]::new($false))

        $validOutput = @(& $pythonRuntime $comparatorPath @paths 2>&1)
        if ($LASTEXITCODE -ne 0 -or ($validOutput -join "`n") -notmatch 'POS_HTML_ALLOWLIST=PASS' -or
            ($validOutput -join "`n") -notmatch 'LANDING_HTML_ALLOWLIST=PASS' -or
            ($validOutput -join "`n") -notmatch 'PWA_MANIFEST_ALLOWLIST=PASS' -or
            ($validOutput -join "`n") -notmatch 'SERVICE_WORKER_PRECACHE_ALLOWLIST=PASS' -or
            ($validOutput -join "`n") -notmatch 'SERVICE_WORKER_SOURCE_ALLOWLIST=PASS') {
            throw "La autoprueba rechazo cambios autorizados o fallaron manifest/service worker: $($validOutput -join "`n")"
        }

        $badCandidate = $candidateIndex.Replace('    <meta charset="utf-8">', "    <meta charset=`"utf-8`">`n    <meta name=`"unapproved`" content=`"true`">")
        [System.IO.File]::WriteAllText($paths[1], $badCandidate, [System.Text.UTF8Encoding]::new($false))
        $badOutput = @(& $pythonRuntime $comparatorPath @paths 2>&1)
        if ($LASTEXITCODE -ne 1 -or ($badOutput -join "`n") -notmatch 'POS_HTML_ALLOWLIST=FAIL' -or
            ($badOutput -join "`n") -notmatch '\+\s*<meta name="unapproved" content="true">') {
            throw 'La autoprueba no detecto y mostro una linea HTML ajena al allowlist.'
        }

        $badSpacing = $candidateIndex.Replace('<title>SoftVentaWeb</title>', "<title>SoftVentaWeb</title>`n`n")
        [System.IO.File]::WriteAllText($paths[1], $badSpacing, [System.Text.UTF8Encoding]::new($false))
        $spacingOutput = @(& $pythonRuntime $comparatorPath @paths 2>&1)
        if ($LASTEXITCODE -ne 1 -or ($spacingOutput -join "`n") -notmatch 'POS_HTML_ALLOWLIST=FAIL') {
            throw 'La autoprueba normalizo una linea vacia fuera del hueco del favicon.'
        }

        $badScript = $candidateIndex.Replace('<script src="/app.js"></script>', '<script src="/unapproved.js"></script>')
        [System.IO.File]::WriteAllText($paths[1], $badScript, [System.Text.UTF8Encoding]::new($false))
        $scriptOutput = @(& $pythonRuntime $comparatorPath @paths 2>&1)
        if ($LASTEXITCODE -ne 1 -or ($scriptOutput -join "`n") -notmatch 'POS_HTML_ALLOWLIST=FAIL' -or
            ($scriptOutput -join "`n") -notmatch '\+<script src="/unapproved.js"></script>') {
            throw 'La autoprueba no preservo la comparacion estricta de scripts.'
        }

        $badForm = $candidateIndex.Replace('id="loginForm"', 'id="changedLoginForm"')
        [System.IO.File]::WriteAllText($paths[1], $badForm, [System.Text.UTF8Encoding]::new($false))
        $formOutput = @(& $pythonRuntime $comparatorPath @paths 2>&1)
        if ($LASTEXITCODE -ne 1 -or ($formOutput -join "`n") -notmatch 'POS_HTML_ALLOWLIST=FAIL' -or
            ($formOutput -join "`n") -notmatch 'changedLoginForm') {
            throw 'La autoprueba no preservo la comparacion estricta de formularios.'
        }
        return 'PYTHON_FIXTURES'
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
        $resolvedTestDirectory = [System.IO.Path]::GetFullPath($testDirectory)
        $allowedTempPrefix = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
        if ($resolvedTestDirectory.StartsWith($allowedTempPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
            (Split-Path -Leaf $resolvedTestDirectory) -match '^softventa-html-diff-[a-f0-9]{32}$') {
            Remove-Item -LiteralPath $resolvedTestDirectory -Recurse -Force
        }
    }
}

function Assert-FaviconAssetPermissions {
    $overlayPath = Join-Path $PayloadDir 'apply-softventa-overlay.cjs'
    $overlayText = Get-Content -LiteralPath $overlayPath -Raw
    $installMatch = [System.Text.RegularExpressions.Regex]::Match($overlayText, '(?ms)^function installFaviconAssets\(\) \{\r?\n(?<body>.*?)^\}')
    if (-not $installMatch.Success -or
        -not $installMatch.Groups['body'].Value.Contains('fs.chmodSync(target, 0o644);') -or
        -not $installMatch.Groups['body'].Value.Contains('fs.lstatSync(target)') -or
        -not $installMatch.Groups['body'].Value.Contains('targetStat.nlink !== 1')) {
        throw 'El overlay debe fijar 0644 solo en iconos regulares y rechazar enlaces.'
    }
    $helperText = Get-Content -LiteralPath $RemoteHelper -Raw
    if ($helperText -notmatch '(?m)^umask 077$' -or $helperText -notmatch 'tar -xzf "\$PACKAGE" -C "\$WORK" --no-same-owner --no-same-permissions') {
        throw 'La comprobacion del modo favicon debe conservar el caso de extraccion restrictiva.'
    }
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { $nodeCommand = Get-Command node -ErrorAction SilentlyContinue }
    if (-not $nodeCommand) { return 'STRUCTURAL_ONLY' }

    $testDirectory = Join-Path ([System.IO.Path]::GetFullPath($env:TEMP)) ('softventa-favicon-mode-test-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $testDirectory | Out-Null
    try {
        $testSource = @"
const fs = require('node:fs');
const path = require('node:path');
const base = process.argv[2];
const root = path.join(base, 'site');
const iconsDir = path.join(base, 'icons');
function die(message) { throw new Error(message); }
$($installMatch.Value)
const iconFiles = ['softventaweb-favicon-20261106-16.png','softventaweb-favicon-20261106-32.png','softventaweb-favicon-20261106-48.png','softventaweb-favicon-20261106.svg','softventaweb-touch-20261106-192.png','softventaweb-pwa-20261106-512.png'];
fs.mkdirSync(path.join(root, 'assets', 'pwa'), { recursive: true });
fs.mkdirSync(iconsDir, { recursive: true });
const destination = path.join(root, 'assets', 'pwa');
for (const name of iconFiles) {
  const bytes = Buffer.from('fixture:' + name);
  fs.writeFileSync(path.join(iconsDir, name), bytes);
  if (name === iconFiles[0]) fs.writeFileSync(path.join(destination, name), bytes);
}
const originalChmod = fs.chmodSync;
const chmodCalls = [];
fs.chmodSync = (file, mode) => { chmodCalls.push([file, mode]); return originalChmod(file, mode); };
const copied = installFaviconAssets();
if (copied !== iconFiles.length - 1) throw new Error('new/existing fixture copy count differs');
if (chmodCalls.length !== iconFiles.length || chmodCalls.some(([file, mode]) => mode !== 0o644 || !file.startsWith(destination + path.sep))) throw new Error('every allowlisted target must be chmod 0644');
for (const name of iconFiles) {
  if (!fs.readFileSync(path.join(destination, name)).equals(fs.readFileSync(path.join(iconsDir, name)))) throw new Error('favicon bytes changed: ' + name);
}
process.stdout.write('FAVICON_ASSET_MODE_FIXTURE=PASS\n');
"@
        $testScript = Join-Path $testDirectory 'favicon-mode-test.cjs'
        [System.IO.File]::WriteAllText($testScript, $testSource, [System.Text.UTF8Encoding]::new($false))
        $output = @(& $nodeCommand.Source $testScript $testDirectory 2>&1)
        if ($LASTEXITCODE -ne 0 -or ($output -join "`n") -notmatch 'FAVICON_ASSET_MODE_FIXTURE=PASS') {
            throw "La autoprueba del modo de iconos fallo: $($output -join "`n")"
        }
        return 'NODE_RUNTIME'
    }
    finally {
        $resolvedTestDirectory = [System.IO.Path]::GetFullPath($testDirectory)
        $allowedTempPrefix = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
        if ($resolvedTestDirectory.StartsWith($allowedTempPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
            (Split-Path -Leaf $resolvedTestDirectory) -match '^softventa-favicon-mode-test-[a-f0-9]{32}$') {
            Remove-Item -LiteralPath $resolvedTestDirectory -Recurse -Force
        }
    }
}

function Assert-TarExtractionMode {
    $tarCommand = Get-Command tar.exe -ErrorAction SilentlyContinue
    if (-not $tarCommand) { throw 'tar.exe es requerido para reproducir el empaquetado del lanzador.' }
    $bashCandidates = @('F:\Git\bin\bash.exe', 'C:\Program Files\Git\bin\bash.exe')
    $bashPath = $null
    foreach ($candidate in $bashCandidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { $bashPath = $candidate; break }
    }
    if (-not $bashPath) { return 'STRUCTURAL_ONLY' }

    $testDirectory = Join-Path ([System.IO.Path]::GetFullPath($env:TEMP)) ('softventa-tar-mode-test-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $testDirectory | Out-Null
    try {
        foreach ($file in $PayloadFiles) { Copy-Item -LiteralPath (Join-Path $PayloadDir $file) -Destination $testDirectory }
        $files = @('Dockerfile.backend','Dockerfile.frontend','MANIFEST.sha256','apply-softventa-overlay.cjs','backend.patch','frontend.patch','softventaweb-favicon-20261106-16.png','softventaweb-favicon-20261106-32.png','softventaweb-favicon-20261106-48.png','softventaweb-favicon-20261106.svg','softventaweb-touch-20261106-192.png','softventaweb-pwa-20261106-512.png')
        $legacyOne = Join-Path $testDirectory 'legacy-one.tar.gz'
        $legacyTwo = Join-Path $testDirectory 'legacy-two.tar.gz'
        & $tarCommand.Source '-czf' $legacyOne '-C' $testDirectory @files
        if ($LASTEXITCODE -ne 0) { throw 'No se pudo reproducir el empaquetado anterior.' }
        Start-Sleep -Seconds 2
        & $tarCommand.Source '-czf' $legacyTwo '-C' $testDirectory @files
        if ($LASTEXITCODE -ne 0) { throw 'No se pudo repetir el empaquetado anterior.' }
        $legacyOneHash = (Get-FileHash -LiteralPath $legacyOne -Algorithm SHA256).Hash.ToLowerInvariant()
        $legacyTwoHash = (Get-FileHash -LiteralPath $legacyTwo -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($legacyOneHash -eq $legacyTwoHash) { throw 'La autoprueba no reprodujo el cambio del timestamp gzip anterior.' }
        $script:CandidateHashDriftTest = 'REPRODUCED'
        $archive = Join-Path $testDirectory 'payload.tar.gz'
        $repeatArchive = Join-Path $testDirectory 'payload-repeat.tar.gz'
        $repeatStage = Join-Path $testDirectory 'stage-two'
        New-Item -ItemType Directory -Path $repeatStage | Out-Null
        foreach ($file in $PayloadFiles) { Copy-Item -LiteralPath (Join-Path $PayloadDir $file) -Destination $repeatStage }
        New-DeterministicPackageArchive -Stage $testDirectory -ArchivePath $archive -Files $files
        New-DeterministicPackageArchive -Stage $repeatStage -ArchivePath $repeatArchive -Files $files
        $archiveHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
        $repeatHash = (Get-FileHash -LiteralPath $repeatArchive -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($archiveHash -ne $repeatHash) { throw 'El TAR del payload sigue cambiando entre Prepare y Deploy.' }
        $script:CandidateArchiveStabilityTest = 'PASS'
        $gzipHeader = [System.IO.File]::ReadAllBytes($archive)
        if ($gzipHeader.Length -lt 10 -or $gzipHeader[0] -ne 31 -or $gzipHeader[1] -ne 139 -or @($gzipHeader[4..7] | Where-Object { $_ -ne 0 }).Count -ne 0) {
            throw 'El encabezado gzip no usa timestamp determinista.'
        }
        $probePath = Join-Path $testDirectory 'extract-mode.sh'
        $probe = @'
set -eu
archive="$1"
destination="$2"
mkdir "$destination"
umask 077
tar -xzf "$archive" -C "$destination" --no-same-owner --no-same-permissions
mode="$(stat -c '%a' "$destination/softventaweb-favicon-20261106-16.png")"
printf 'TAR_ICON_MODE_AFTER_HELPER_EXTRACTION=%s\n' "$mode"
test "$mode" = 600
'@
        [System.IO.File]::WriteAllText($probePath, $probe, [System.Text.UTF8Encoding]::new($false))
        $unixDrive = $testDirectory.Substring(0,1).ToLowerInvariant()
        $unixRoot = '/' + $unixDrive + $testDirectory.Substring(2).Replace('\','/')
        $archiveUnix = $unixRoot + '/payload.tar.gz'
        $probeUnix = $unixRoot + '/extract-mode.sh'
        $extractUnix = $unixRoot + '/extract'
        $output = @(& $bashPath $probeUnix $archiveUnix $extractUnix 2>&1)
        if ($LASTEXITCODE -ne 0 -or ($output -join "`n") -notmatch 'TAR_ICON_MODE_AFTER_HELPER_EXTRACTION=600') {
            throw "La autoprueba no reprodujo el modo 0600 al extraer: $($output -join "`n")"
        }
        return 'GIT_BASH_RUNTIME; deterministic archive hash stable'
    }
    finally {
        $resolvedTestDirectory = [System.IO.Path]::GetFullPath($testDirectory)
        $allowedTempPrefix = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
        if ($resolvedTestDirectory.StartsWith($allowedTempPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
            (Split-Path -Leaf $resolvedTestDirectory) -match '^softventa-tar-mode-test-[a-f0-9]{32}$') {
            Remove-Item -LiteralPath $resolvedTestDirectory -Recurse -Force
        }
    }
}

function Assert-HttpProbeDiagnostics {
    $helperText = Get-Content -LiteralPath $RemoteHelper -Raw
    $diagnosticMatch = [System.Text.RegularExpressions.Regex]::Match($helperText, '(?ms)^http_probe_diagnostics\(\) \{\r?\n(?<body>.*?)^\}')
    $requestMatch = [System.Text.RegularExpressions.Regex]::Match($helperText, '(?ms)^checked_http_get\(\) \{\r?\n(?<body>.*?)^\}')
    $routesMatch = [System.Text.RegularExpressions.Regex]::Match($helperText, '(?ms)^validate_routes\(\) \{\r?\n(?<body>.*?)^\}')
    if (-not $diagnosticMatch.Success -or -not $requestMatch.Success -or -not $routesMatch.Success) { throw 'Faltan los bloques de diagnóstico HTTP.' }
    $diagnostics = $diagnosticMatch.Groups['body'].Value
    $request = $requestMatch.Groups['body'].Value
    $routes = $routesMatch.Groups['body'].Value
    foreach ($required in @('HTTP_DIAGNOSTIC=FAIL','status=%s','remote_ip=%s','origin=%s','proxy_bypassed=yes','docker exec','stat -c','nginx -T','docker logs --tail')) {
        if (-not $diagnostics.Contains($required)) { throw "Falta diagnóstico HTTP: $required" }
    }
    foreach ($required in @("curl --noproxy '*'", "--write-out '%{http_code}|%{remote_ip}'", 'if [[ "$expected" == ''2xx'' &&', 'return 1')) {
        if (-not $request.Contains($required)) { throw "La petición HTTP no conserva la comprobación esperada: $required" }
    }
    if (-not $routes.Contains('checked_http_get favicon_resource') -or
        -not $routes.Contains('favicon_resource') -or
        $routes -match 'curl .*--fail' -or
        -not $helperText.Contains('checked_http_get post_deploy_api_health') -or
        -not $helperText.Contains('checked_http_get post_deploy_pos')) {
        throw 'La comprobación de favicon o las rutas posteriores no aplican el probe directo con estado explícito.'
    }
    $curlLines = @($helperText -split '\r?\n' | Where-Object { $_ -match '\bcurl\s+--' })
    foreach ($line in $curlLines) {
        if ($line -notmatch "curl --noproxy '\*'") { throw "Hay una petición curl sin bypass explícito de proxy: $line" }
    }
    return 'PASS'
}

function Assert-CandidateContinuity {
    $helperText = Get-Content -LiteralPath $RemoteHelper -Raw
    $launcherText = Get-Content -LiteralPath $PSCommandPath -Raw
    $candidateMatch = [System.Text.RegularExpressions.Regex]::Match($helperText, '(?ms)^assert_prepared_candidate\(\) \{\r?\n(?<body>.*?)^\}')
    $recordMatch = [System.Text.RegularExpressions.Regex]::Match($helperText, '(?ms)^record_prepared_marker\(\) \{\r?\n(?<body>.*?)^\}')
    $archiveMatch = [System.Text.RegularExpressions.Regex]::Match($launcherText, '(?ms)^function New-DeterministicPackageArchive \{.*?^\}')
    if (-not $candidateMatch.Success -or -not $recordMatch.Success -or -not $archiveMatch.Success) { throw 'Faltan validaciones de continuidad de candidata.' }
    if (-not $helperText.Contains('CANDIDATE_${role}_EXISTS=FAIL')) { throw 'Falta el diagnóstico de imagen candidata inexistente.' }
    foreach ($required in @('CANDIDATE_${role}_TAG=PASS','ACTIVE_IMAGE_CHANGED=FAIL','PREPARATION_STATE=FAIL','PREPARATION_STATE=PASS','marker_id" != "$image','package_and_active_image_labels_match','rerun -PrepareCandidateOnly')) {
        if (-not $candidateMatch.Groups['body'].Value.Contains($required)) { throw "Falta diagnóstico de continuidad: $required" }
    }
    foreach ($required in @('PREPARATION_STATE=REFRESH','docker image tag','PREPARATION_STATE=PASS')) {
        if (-not $recordMatch.Groups['body'].Value.Contains($required)) { throw "El marcador de preparación no se conserva correctamente: $required" }
    }
    foreach ($required in @('--format=ustar','--mtime=@1577836800','--uid=0','--gid=0','GZipStream')) {
        if (-not $archiveMatch.Value.Contains($required)) { throw "El empaquetado no es determinista: falta $required" }
    }
    if (-not $launcherText.Contains('New-DeterministicPackageArchive -Stage $localStage -ArchivePath $packagePath -Files $PayloadFiles')) { throw 'PrepareCandidateOnly y Deploy no comparten el mismo empaquetado determinista.' }
    foreach ($required in @('PREP_FRONT_TAG="pos-frontend:billing-favicon-prepared-$package_short-$front_short"','PREP_BACK_TAG="pos-backend:billing-favicon-prepared-$package_short-$back_short"','record_prepared_marker FRONTEND','record_prepared_marker BACKEND')) {
        if (-not $helperText.Contains($required)) { throw "Falta persistencia de candidata: $required" }
    }
    $recordIndex = $helperText.IndexOf('record_prepared_marker FRONTEND')
    $recordBackIndex = $helperText.IndexOf('record_prepared_marker BACKEND')
    $routeIndex = $helperText.IndexOf('validate_routes "$candidate_front_id" billing-favicon')
    $preparePassIndex = $helperText.IndexOf('PREPARE_ONLY=PASS')
    $assertIndex = $helperText.IndexOf('assert_prepared_candidate FRONTEND')
    $assertBackIndex = $helperText.IndexOf('assert_prepared_candidate BACKEND')
    $deployPromptIndex = $helperText.IndexOf('PUBLICAR FACTURACION')
    if ($routeIndex -lt 0 -or $recordIndex -le $routeIndex -or $recordBackIndex -le $recordIndex -or $preparePassIndex -le $recordBackIndex -or
        $assertIndex -le 0 -or $assertBackIndex -le $assertIndex -or $assertBackIndex -ge $deployPromptIndex) {
        throw 'El marcador no se escribe tras validar o Deploy no valida el estado antes del prompt.'
    }
    if ($helperText.Contains('La candidata frontend no existe o la imagen activa cambi') -or
        $helperText.Contains('La candidata backend no existe o la imagen activa cambi')) {
        throw 'Permanece el mensaje genérico que confunde imagen ausente con base activa modificada.'
    }
    return 'PASS'
}

function Assert-Package {
    foreach ($file in $PayloadFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $PayloadDir $file) -PathType Leaf)) { throw "Falta payload: $file" }
    }
    $payloadActual = @(Get-ChildItem -LiteralPath $PayloadDir -File | ForEach-Object Name | Sort-Object)
    $payloadExpected = @($PayloadFiles | Sort-Object)
    if (Compare-Object -ReferenceObject $payloadExpected -DifferenceObject $payloadActual) { throw 'El payload contiene archivos extra o faltantes.' }
    Assert-LinuxScriptLineEndings
    $script:ComposeConfigArgTest = Assert-ComposeConfigArgument
    $script:CategoryValidatorTest = Assert-CategoryValidator
    $script:FrontendProtectedHashTest = Assert-FrontendProtectedHashing
    $script:HtmlAllowlistTest = Assert-HtmlAllowlistComparator
    $script:FaviconAssetModeTest = Assert-FaviconAssetPermissions
    $script:FaviconTarModeTest = Assert-TarExtractionMode
    $script:HttpProbeDiagnosticsTest = Assert-HttpProbeDiagnostics
    $script:CandidateContinuityTest = Assert-CandidateContinuity
    $remoteHelperText = Get-Content -LiteralPath $RemoteHelper -Raw
    if ($remoteHelperText -match '(?m)^for c in [^\r\n]*\bnode\b') { throw 'El helper no debe requerir Node.js instalado en el VPS.' }
    if ($remoteHelperText -notmatch 'docker run --rm --network none --entrypoint node "\$candidate_back_id" --check') { throw 'La sintaxis JavaScript debe validarse dentro de la imagen candidata de backend.' }
    Assert-Manifest -ManifestPath (Join-Path $PayloadDir 'MANIFEST.sha256') -Root $PayloadDir -Expected ($PayloadFiles | Where-Object { $_ -ne 'MANIFEST.sha256' })

    $frontendPatch = Get-Content -LiteralPath (Join-Path $PayloadDir 'frontend.patch') -Raw
    $backendPatch = Get-Content -LiteralPath (Join-Path $PayloadDir 'backend.patch') -Raw
    if ($frontendPatch -match 'PRODUCT_CATEGORY_NOT_FOUND|system-admin|product-categor|inicio/|assets/pwa|styles\.css' -or
        $backendPatch -match 'product-categor|system-admin|database/migrations|ALTER TABLE|INSERT INTO sales') {
        throw 'El diff contiene cambios ajenos o escritura de datos.'
    }
    foreach ($expected in @('app.js','connected-sales.js')) {
        if (-not $frontendPatch.Contains("diff --git a/$expected b/$expected")) { throw "Falta el diff de $expected." }
    }
    if ($backendPatch -match '(?m)^[-+][^+-]') { throw 'La candidata de correccion no debe cambiar archivos backend.' }
    $script:BackendPatchTest = 'NO_SOURCE_CHANGES'
    foreach ($expected in @('backend/src/routes/sales.js','backend/src/services/sales.js')) {
        if (-not $backendPatch.Contains("diff --git a/$expected b/$expected")) { throw "Falta el diff de $expected." }
    }
    $overlaySource = Get-Content -LiteralPath (Join-Path $PayloadDir 'apply-softventa-overlay.cjs') -Raw
    if (-not $overlaySource.Contains('function frontFileState(name)') -or
        -not $overlaySource.Contains('function frontFileChanged(before, name)') -or
        -not $overlaySource.Contains("const trackedFrontendFiles = ['app.js', 'connected-sales.js', 'api-client.js', 'index.html', 'inicio/index.html',") -or
        -not $overlaySource.Contains('const changedFiles = trackedFrontendFiles.filter(name => frontFileChanged(before.get(name), name));') -or
        $overlaySource.Contains("(changedCode || appChanged) ? 'app.js,api-client.js'")) {
        throw 'El diagnostico de archivos del frontend debe comparar el contenido por ruta.'
    }
    $script:OverlayTouchedFilesTest = 'PASS'
    if (-not $frontendPatch.Contains(".find(value => typeof value === 'string' && value.trim() && value.trim() !== '-')")) { throw 'El patch no conserva el primer detalle utilizable del comprobante.' }
    foreach ($required in @('function cartData(input = state())','detail: input.detail','function quoteData(input)','quoteSale(quoteData(quoteInput))')) {
        if (-not $frontendPatch.Contains($required)) { throw "El patch no fija el detalle de la venta conectada: $required" }
    }
    if ($frontendPatch -match '(?m)^\+.*detail:\s*state\(\)\.detail') { throw 'El patch permite releer un detalle mutable despues de cotizar.' }
    $script:InvoiceDetailPatchTest = 'PASS'
    if (-not (Test-Path -LiteralPath (Join-Path $PayloadDir 'softventaweb-favicon-20261106.svg') -PathType Leaf)) { throw 'Missing versioned SVG favicon.' }
    if (-not (Get-Content -Raw (Join-Path $PayloadDir 'Dockerfile.frontend')).Contains('softventaweb-touch-20261106-192.png')) { throw 'Frontend Dockerfile omits versioned icons.' }
}

function Assert-OuterDirectory {
    $actualFiles = @(Get-ChildItem -LiteralPath $PSScriptRoot -File -Recurse | ForEach-Object { $_.FullName.Substring($PSScriptRoot.Length + 1).Replace('\','/') } | Sort-Object)
    $expectedFiles = @(($OuterFiles + 'PACKAGE_CONTENTS.sha256') | ForEach-Object { $_.Replace('\','/') } | Sort-Object)
    if (Compare-Object -ReferenceObject $expectedFiles -DifferenceObject $actualFiles) { throw 'El paquete exterior contiene archivos extra o faltantes.' }
    $actualDirectories = @(Get-ChildItem -LiteralPath $PSScriptRoot -Directory | ForEach-Object Name | Sort-Object)
    if (Compare-Object -ReferenceObject @('payload') -DifferenceObject $actualDirectories) { throw 'El paquete exterior contiene carpetas extra o faltantes.' }
}

if ($SelfTest) {
    $tokens = $null
    $parseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($PSCommandPath, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count -gt 0) { throw 'La sintaxis PowerShell no es válida.' }
    Assert-Package
    Assert-OuterDirectory
    Assert-Manifest -ManifestPath (Join-Path $PSScriptRoot 'PACKAGE_CONTENTS.sha256') -Root $PSScriptRoot -Expected $OuterFiles
    Write-Output 'POWERSHELL_SYNTAX=PASS'
    Write-Output 'LINUX_SCRIPT_LINE_ENDINGS=LF_ONLY'
    Write-Output 'REMOTE_NODE_RUNTIME=BACKEND_DOCKER_IMAGE'
    Write-Output "COMPOSE_CONFIG_ARG_TEST=$script:ComposeConfigArgTest"
    Write-Output "CATEGORY_VALIDATOR_DIAGNOSTICS=$script:CategoryValidatorTest"
    Write-Output "FRONTEND_PROTECTED_HASH_DIAGNOSTICS=$script:FrontendProtectedHashTest"
    Write-Output "HTML_ALLOWLIST_DIFF_TEST=$script:HtmlAllowlistTest"
    Write-Output "FAVICON_ASSET_MODE_TEST=$script:FaviconAssetModeTest"
    Write-Output "FAVICON_TAR_MODE_TEST=$script:FaviconTarModeTest"
    Write-Output "CANDIDATE_HASH_DRIFT_REPRO=$script:CandidateHashDriftTest"
    Write-Output "CANDIDATE_ARCHIVE_STABILITY=$script:CandidateArchiveStabilityTest"
    Write-Output "HTTP_PROBE_DIAGNOSTICS=$script:HttpProbeDiagnosticsTest"
    Write-Output "CANDIDATE_STATE_CONTINUITY=$script:CandidateContinuityTest"
    Write-Output "INVOICE_DETAIL_PATCH=$script:InvoiceDetailPatchTest"
    Write-Output "BACKEND_PATCH=$script:BackendPatchTest"
    Write-Output "OVERLAY_TOUCHED_FILES=$script:OverlayTouchedFilesTest"
    Write-Output 'PAYLOAD_ALLOWLIST=PASS; sales UI/API and versioned favicons only; categories/admin/data/migrations excluded'
    Write-Output 'PACKAGE_SHA256_MANIFEST=PASS'
    exit 0
}

$selected = @()
if ($PrepareCandidateOnly) { $selected += 'prepare' }
if ($Deploy) { $selected += 'deploy' }
if ($Rollback) { $selected += 'rollback' }
if ($selected.Count -ne 1) { throw 'Elegí exactamente una modalidad: -PrepareCandidateOnly, -Deploy o -Rollback.' }
if ($Rollback -and $RollbackTag -notmatch '^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$') { throw 'Para -Rollback se requiere el token informado por el despliegue.' }
if (-not $Rollback -and $RollbackTag) { throw 'RollbackTag solo se usa junto con -Rollback.' }
Assert-Package
Assert-OuterDirectory
Assert-Manifest -ManifestPath (Join-Path $PSScriptRoot 'PACKAGE_CONTENTS.sha256') -Root $PSScriptRoot -Expected $OuterFiles

$nonce = [Guid]::NewGuid().ToString('N').Substring(0, 16)
$tempRoot = [System.IO.Path]::GetFullPath($env:TEMP)
$localStage = Join-Path $tempRoot "softventa-billing-favicon-$nonce"
$remoteStage = "/home/posadmin/.pos-billing-favicon-$nonce"
$createdStage = $false
$remoteStageCreated = $false
try {
    New-Item -ItemType Directory -Path $localStage | Out-Null
    $createdStage = $true
    foreach ($file in $PayloadFiles) { Copy-Item -LiteralPath (Join-Path $PayloadDir $file) -Destination (Join-Path $localStage $file) }
    $packagePath = Join-Path $localStage 'billing-favicon-overlay.tar.gz'
    New-DeterministicPackageArchive -Stage $localStage -ArchivePath $packagePath -Files $PayloadFiles
    $tar = (Get-Command tar.exe -ErrorAction Stop).Source
    $entries = @(& $tar '-tzf' $packagePath | Sort-Object -CaseSensitive)
    $expectedEntries = @('Dockerfile.backend','Dockerfile.frontend','MANIFEST.sha256','apply-softventa-overlay.cjs','backend.patch','frontend.patch','softventaweb-favicon-20261106-16.png','softventaweb-favicon-20261106-32.png','softventaweb-favicon-20261106-48.png','softventaweb-favicon-20261106.svg','softventaweb-touch-20261106-192.png','softventaweb-pwa-20261106-512.png') | Sort-Object -CaseSensitive
    if (Compare-Object -ReferenceObject $expectedEntries -DifferenceObject $entries) { throw 'El tar contiene archivos adicionales o faltantes.' }
    $packageHash = (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $helperHash = (Get-FileHash -LiteralPath $RemoteHelper -Algorithm SHA256).Hash.ToLowerInvariant()
    $ssh = (Get-Command ssh.exe -ErrorAction Stop).Source
    $scp = (Get-Command scp.exe -ErrorAction Stop).Source
    & $ssh -o BatchMode=yes -o StrictHostKeyChecking=yes $Target "mkdir -m 700 -- '$remoteStage'"
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo crear el directorio temporal remoto.' }
    $remoteStageCreated = $true
    $remoteDestination = $Target + ':' + $remoteStage + '/'
    & $scp -o BatchMode=yes -o StrictHostKeyChecking=yes $packagePath $RemoteHelper $remoteDestination
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo transferir el overlay allowlist.' }
    & $ssh -o BatchMode=yes -o StrictHostKeyChecking=yes $Target "chmod 600 -- '$remoteStage/billing-favicon-overlay.tar.gz' '$remoteStage/remote-deploy-softventa-billing-favicon.sh'"
    if ($LASTEXITCODE -ne 0) { throw 'No se pudieron restringir los permisos del paquete temporal.' }

    $remoteHelperPath = "$remoteStage/remote-deploy-softventa-billing-favicon.sh"
    $remotePackagePath = "$remoteStage/billing-favicon-overlay.tar.gz"
    # OpenSSH scp transfers the helper bytes unchanged; verify the remote hash before parsing it.
    $remoteHashRow = & $ssh -o BatchMode=yes -o StrictHostKeyChecking=yes $Target "sha256sum -- '$remoteHelperPath'"
    if ($LASTEXITCODE -ne 0 -or -not $remoteHashRow) { throw 'No se pudo verificar el helper remoto.' }
    $remoteHelperHash = (($remoteHashRow -join ' ') -split '\s+')[0].ToLowerInvariant()
    if ($remoteHelperHash -ne $helperHash) { throw 'El helper cambió durante la transferencia.' }
    $remoteSyntaxCheck = "python3 -c 'import pathlib,sys; sys.exit(1 if 13 in pathlib.Path(sys.argv[1]).read_bytes() else 0)' '$remoteHelperPath' && /bin/bash -n '$remoteHelperPath'"
    & $ssh -o BatchMode=yes -o StrictHostKeyChecking=yes $Target $remoteSyntaxCheck
    if ($LASTEXITCODE -ne 0) {
        throw 'El helper remoto contiene CR/CRLF o no pasa bash -n; se detuvo antes de sudo o preparacion.'
    }
    Write-Output 'REMOTE_HELPER_LF_AND_BASH_SYNTAX=PASS'

    if ($PrepareCandidateOnly) { $remoteMode = '--prepare-only'; $rollbackArg = '' }
    elseif ($Rollback) { $remoteMode = '--rollback'; $rollbackArg = $RollbackTag }
    else { $remoteMode = '--deploy'; $rollbackArg = '' }
    $remoteCommand = "sudo -v && sudo /bin/bash -n '$remoteHelperPath' && sudo /bin/bash '$remoteHelperPath' '$remoteMode' '$remotePackagePath' '$packageHash' '$helperHash' '$rollbackArg'"
    & $ssh -tt -o StrictHostKeyChecking=yes $Target $remoteCommand
    if ($LASTEXITCODE -ne 0) { throw "La etapa remota terminó con código $LASTEXITCODE; revisá su validación." }
    & $ssh -o BatchMode=yes -o StrictHostKeyChecking=yes $Target "rm -f -- '$remoteStage/billing-favicon-overlay.tar.gz' '$remoteStage/remote-deploy-softventa-billing-favicon.sh' && rmdir -- '$remoteStage'" | Out-Null
    if ($LASTEXITCODE -eq 0) { $remoteStageCreated = $false }
    if ($LASTEXITCODE -ne 0) { Write-Warning 'El staging remoto quedó para limpieza manual; no contiene secretos.' }
}
finally {
    if ($remoteStageCreated) {
        $sshCommand = Get-Command ssh.exe -ErrorAction SilentlyContinue
        if ($sshCommand) {
            & $sshCommand.Source -o BatchMode=yes -o StrictHostKeyChecking=yes $Target "rm -f -- '$remoteStage/billing-favicon-overlay.tar.gz' '$remoteStage/remote-deploy-softventa-billing-favicon.sh' && rmdir -- '$remoteStage'" | Out-Null
            if ($LASTEXITCODE -ne 0) { Write-Warning 'Unable to remove temporary remote staging.' }
        }
    }
    if ($createdStage) {
        $resolvedStage = [System.IO.Path]::GetFullPath($localStage)
        $allowedPrefix = $tempRoot.TrimEnd('\') + '\'
        if ($resolvedStage.StartsWith($allowedPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
            (Split-Path -Leaf $resolvedStage) -match '^softventa-billing-favicon-[a-f0-9]{16}$') {
            Remove-Item -LiteralPath $resolvedStage -Recurse -Force
        }
    }
}
