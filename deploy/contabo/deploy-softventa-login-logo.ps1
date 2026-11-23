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
$OverlayRoot = Join-Path $PSScriptRoot 'login-logo-restore'
$OverlayDockerfile = Join-Path $OverlayRoot 'Dockerfile'
$PatchScript = Join-Path $OverlayRoot 'apply-login-logo.sh'
$RemoteHelper = Join-Path $OverlayRoot 'remote-restore-login-logo.sh'

function Assert-OverlayFiles {
    foreach ($file in @($OverlayDockerfile, $PatchScript, $RemoteHelper)) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Falta un archivo allowlist del overlay: $file" }
    }
    $dockerfile = Get-Content -LiteralPath $OverlayDockerfile -Raw
    $patcher = Get-Content -LiteralPath $PatchScript -Raw
    $remote = Get-Content -LiteralPath $RemoteHelper -Raw
    if ($dockerfile -notmatch '(?m)^FROM \$\{BASE_IMAGE\}$' -or
        $dockerfile -notmatch 'org\.softventa\.login-logo\.base-image-id' -or
        $dockerfile -notmatch '(?m)^COPY apply-login-logo\.sh /tmp/apply-login-logo\.sh$' -or
        $dockerfile -notmatch '(?m)^RUN /bin/sh /tmp/apply-login-logo\.sh') {
        throw 'El Dockerfile no está limitado al overlay sobre la imagen base.'
    }
    foreach ($expected in @(
        '<div class="login-logo"><div class="logo-icon">POS</div></div>',
        'src="/assets/pwa/softventaweb-logo.webp"',
        '.login-softventa-logo { display: block; width: 220px; max-width: 100%; height: auto; max-height: 56px; object-fit: contain; }'
    )) { if (-not $patcher.Contains($expected)) { throw "Falta el parche esperado: $expected" } }
    if ($patcher -match 'connected-auth|connected-inventory|app\.js|backend|mysql') { throw 'El parche contiene referencias ajenas al encabezado de login.' }
    foreach ($expected in @('pos-frontend:rollback-pre-login-logo-', 'LOGIN_LOGO_POSTCHECK=PASS', 'connected', 'local', '/inicio/styles.css', 'image/webp')) {
        if (-not $remote.Contains($expected)) { throw "El helper remoto no valida: $expected" }
    }
    if (-not $remote.Contains('docker run --rm --network pos-production_edge --entrypoint nginx "$CANDIDATE_ID" -t') -or
        $remote -match 'docker\s+run\s+--rm\s+--network\s+none\s+--entrypoint\s+nginx') {
        throw 'La validación nginx -t debe usar pos-production_edge.'
    }
    if ($remote -match 'docker\s+(?:system\s+prune|volume\s+prune)|compose\s+down\s+-v|migrate:all|mysql\s+.*ALTER') {
        throw 'El helper contiene una operación ajena o destructiva.'
    }
}

if ($SelfTest) {
    $tokens = $null
    $parseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($PSCommandPath, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count -gt 0) { throw 'La sintaxis PowerShell no es válida.' }
    Assert-OverlayFiles
    Write-Output 'POWERSHELL_SYNTAX=PASS'
    Write-Output 'LOGIN_OVERLAY_SCOPE=PASS; active-image+index-login+css-only'
    Write-Output 'NGINX_TEST_NETWORK=PASS; pos-production_edge'
    Write-Output 'ROLLBACK_AND_ROUTE_VALIDATION=PASS'
    exit 0
}

$selected = @()
if ($PrepareCandidateOnly) { $selected += 'prepare' }
if ($Deploy) { $selected += 'deploy' }
if ($Rollback) { $selected += 'rollback' }
if ($selected.Count -ne 1) { throw 'Elegí exactamente una modalidad: -PrepareCandidateOnly, -Deploy o -Rollback.' }
if ($Rollback -and $RollbackTag -notmatch '^pos-frontend:rollback-pre-login-logo-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$') {
    throw 'Para -Rollback se requiere la etiqueta exacta de respaldo que informó el despliegue.'
}
if (-not $Rollback -and $RollbackTag) { throw 'RollbackTag solo se usa junto con -Rollback.' }
Assert-OverlayFiles

$nonce = [Guid]::NewGuid().ToString('N').Substring(0, 16)
$tempRoot = [System.IO.Path]::GetFullPath($env:TEMP)
$localStage = Join-Path $tempRoot "pos-login-logo-$nonce"
$remoteStage = "/home/posadmin/.pos-login-logo-$nonce"
$createdStage = $false
try {
    New-Item -ItemType Directory -Path $localStage | Out-Null
    $createdStage = $true
    Copy-Item -LiteralPath $OverlayDockerfile -Destination (Join-Path $localStage 'Dockerfile')
    Copy-Item -LiteralPath $PatchScript -Destination (Join-Path $localStage 'apply-login-logo.sh')
    $packagePath = Join-Path $localStage 'login-overlay.tar.gz'
    $tar = Get-Command tar.exe -ErrorAction Stop
    & $tar.Source '-czf' $packagePath '-C' $localStage 'Dockerfile' 'apply-login-logo.sh'
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo crear el paquete allowlist.' }
    $entries = @(& $tar.Source '-tzf' $packagePath | Sort-Object -CaseSensitive)
    $expected = @('Dockerfile', 'apply-login-logo.sh') | Sort-Object -CaseSensitive
    if (Compare-Object -ReferenceObject $expected -DifferenceObject $entries) { throw 'El tar contiene archivos adicionales o faltantes.' }
    $packageHash = (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $helperHash = (Get-FileHash -LiteralPath $RemoteHelper -Algorithm SHA256).Hash.ToLowerInvariant()
    $ssh = (Get-Command ssh.exe -ErrorAction Stop).Source
    $scp = (Get-Command scp.exe -ErrorAction Stop).Source
    & $ssh -o BatchMode=yes -o StrictHostKeyChecking=yes $Target "mkdir -m 700 -- '$remoteStage'"
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo crear el directorio temporal remoto.' }
    & $scp -o BatchMode=yes -o StrictHostKeyChecking=yes $packagePath $RemoteHelper "${Target}:$remoteStage/"
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo transferir el overlay.' }
    & $ssh -o BatchMode=yes -o StrictHostKeyChecking=yes $Target "chmod 600 -- '$remoteStage/login-overlay.tar.gz' '$remoteStage/remote-restore-login-logo.sh'"
    if ($LASTEXITCODE -ne 0) { throw 'No se pudieron restringir los permisos del paquete remoto.' }

    if ($PrepareCandidateOnly) { $remoteMode = '--prepare-only'; $rollbackArg = '' }
    elseif ($Rollback) { $remoteMode = '--rollback'; $rollbackArg = $RollbackTag }
    else { $remoteMode = '--deploy'; $rollbackArg = '' }
    $remoteCommand = "sudo -v && sudo /bin/bash -n '$remoteStage/remote-restore-login-logo.sh' && sudo /bin/bash '$remoteStage/remote-restore-login-logo.sh' '$remoteMode' '$remoteStage/login-overlay.tar.gz' '$packageHash' '$helperHash' '$rollbackArg'"
    & $ssh -tt -o StrictHostKeyChecking=yes $Target $remoteCommand
    if ($LASTEXITCODE -ne 0) { throw "La etapa remota terminó con código $LASTEXITCODE; revisá su resultado de validación/rollback." }
    & $ssh -o BatchMode=yes -o StrictHostKeyChecking=yes $Target "rm -f -- '$remoteStage/login-overlay.tar.gz' '$remoteStage/remote-restore-login-logo.sh' && rmdir -- '$remoteStage'" | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Warning 'El directorio temporal remoto quedó para limpieza manual; no contiene secretos.' }
}
finally {
    if ($createdStage) {
        $resolvedStage = [System.IO.Path]::GetFullPath($localStage)
        $allowedPrefix = $tempRoot.TrimEnd('\') + '\'
        if ($resolvedStage.StartsWith($allowedPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
            (Split-Path -Leaf $resolvedStage) -match '^pos-login-logo-[a-f0-9]{16}$') {
            Remove-Item -LiteralPath $resolvedStage -Recurse -Force
        }
    }
}
