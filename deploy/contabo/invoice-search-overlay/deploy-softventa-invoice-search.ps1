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
$RemoteHelper = Join-Path $PSScriptRoot 'remote-deploy-softventa-invoice-search.sh'
$PayloadFiles = @('Dockerfile.backend','Dockerfile.frontend','apply-invoice-overlay.cjs','backend.patch','frontend.patch','MANIFEST.sha256')
$OuterFiles = @(
    'README.md',
    'deploy-softventa-invoice-search.ps1',
    'remote-deploy-softventa-invoice-search.sh',
    'payload\Dockerfile.backend',
    'payload\Dockerfile.frontend',
    'payload\apply-invoice-overlay.cjs',
    'payload\backend.patch',
    'payload\frontend.patch',
    'payload\MANIFEST.sha256'
)

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

function Assert-Package {
    foreach ($file in $PayloadFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $PayloadDir $file) -PathType Leaf)) { throw "Falta payload: $file" }
    }
    $payloadActual = @(Get-ChildItem -LiteralPath $PayloadDir -File | ForEach-Object Name | Sort-Object)
    $payloadExpected = @($PayloadFiles | Sort-Object)
    if (Compare-Object -ReferenceObject $payloadExpected -DifferenceObject $payloadActual) { throw 'El payload contiene archivos extra o faltantes.' }
    Assert-Manifest -ManifestPath (Join-Path $PayloadDir 'MANIFEST.sha256') -Root $PayloadDir -Expected ($PayloadFiles | Where-Object { $_ -ne 'MANIFEST.sha256' })

    $frontendPatch = Get-Content -LiteralPath (Join-Path $PayloadDir 'frontend.patch') -Raw
    $backendPatch = Get-Content -LiteralPath (Join-Path $PayloadDir 'backend.patch') -Raw
    if ($frontendPatch -match 'PRODUCT_CATEGORY_NOT_FOUND|system-admin|product-categor|inicio/|assets/pwa|styles\.css' -or
        $backendPatch -match 'product-categor|system-admin|database/migrations|ALTER TABLE|INSERT INTO sales') {
        throw 'El diff contiene cambios ajenos o escritura de datos.'
    }
    foreach ($expected in @('app.js','connected-sales.js','api-client.js')) {
        if (-not $frontendPatch.Contains("diff --git a/$expected b/$expected")) { throw "Falta el diff de $expected." }
    }
    foreach ($expected in @('backend/src/routes/sales.js','backend/src/services/sales.js')) {
        if (-not $backendPatch.Contains("diff --git a/$expected b/$expected")) { throw "Falta el diff de $expected." }
    }
}

if ($SelfTest) {
    $tokens = $null
    $parseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($PSCommandPath, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count -gt 0) { throw 'La sintaxis PowerShell no es válida.' }
    Assert-Package
    Assert-Manifest -ManifestPath (Join-Path $PSScriptRoot 'PACKAGE_CONTENTS.sha256') -Root $PSScriptRoot -Expected $OuterFiles
    Write-Output 'POWERSHELL_SYNTAX=PASS'
    Write-Output 'PAYLOAD_ALLOWLIST=PASS; sales UI/API only; category/presentation/migrations excluded'
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
Assert-Manifest -ManifestPath (Join-Path $PSScriptRoot 'PACKAGE_CONTENTS.sha256') -Root $PSScriptRoot -Expected $OuterFiles

$nonce = [Guid]::NewGuid().ToString('N').Substring(0, 16)
$tempRoot = [System.IO.Path]::GetFullPath($env:TEMP)
$localStage = Join-Path $tempRoot "softventa-invoice-$nonce"
$remoteStage = "/home/posadmin/.pos-invoice-$nonce"
$createdStage = $false
try {
    New-Item -ItemType Directory -Path $localStage | Out-Null
    $createdStage = $true
    foreach ($file in $PayloadFiles) { Copy-Item -LiteralPath (Join-Path $PayloadDir $file) -Destination (Join-Path $localStage $file) }
    $packagePath = Join-Path $localStage 'invoice-overlay.tar.gz'
    $tar = (Get-Command tar.exe -ErrorAction Stop).Source
    & $tar '-czf' $packagePath '-C' $localStage 'Dockerfile.backend' 'Dockerfile.frontend' 'MANIFEST.sha256' 'apply-invoice-overlay.cjs' 'backend.patch' 'frontend.patch'
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo crear el payload allowlist.' }
    $entries = @(& $tar '-tzf' $packagePath | Sort-Object -CaseSensitive)
    $expectedEntries = @('Dockerfile.backend','Dockerfile.frontend','MANIFEST.sha256','apply-invoice-overlay.cjs','backend.patch','frontend.patch') | Sort-Object -CaseSensitive
    if (Compare-Object -ReferenceObject $expectedEntries -DifferenceObject $entries) { throw 'El tar contiene archivos adicionales o faltantes.' }
    $packageHash = (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $helperHash = (Get-FileHash -LiteralPath $RemoteHelper -Algorithm SHA256).Hash.ToLowerInvariant()
    $ssh = (Get-Command ssh.exe -ErrorAction Stop).Source
    $scp = (Get-Command scp.exe -ErrorAction Stop).Source
    & $ssh -o BatchMode=yes -o StrictHostKeyChecking=yes $Target "mkdir -m 700 -- '$remoteStage'"
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo crear el directorio temporal remoto.' }
    $remoteDestination = $Target + ':' + $remoteStage + '/'
    & $scp -o BatchMode=yes -o StrictHostKeyChecking=yes $packagePath $RemoteHelper $remoteDestination
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo transferir el overlay allowlist.' }
    & $ssh -o BatchMode=yes -o StrictHostKeyChecking=yes $Target "chmod 600 -- '$remoteStage/invoice-overlay.tar.gz' '$remoteStage/remote-deploy-softventa-invoice-search.sh'"
    if ($LASTEXITCODE -ne 0) { throw 'No se pudieron restringir los permisos del paquete temporal.' }

    if ($PrepareCandidateOnly) { $remoteMode = '--prepare-only'; $rollbackArg = '' }
    elseif ($Rollback) { $remoteMode = '--rollback'; $rollbackArg = $RollbackTag }
    else { $remoteMode = '--deploy'; $rollbackArg = '' }
    $remoteHelperPath = "$remoteStage/remote-deploy-softventa-invoice-search.sh"
    $remotePackagePath = "$remoteStage/invoice-overlay.tar.gz"
    $remoteCommand = "sudo -v && sudo /bin/bash -n '$remoteHelperPath' && sudo /bin/bash '$remoteHelperPath' '$remoteMode' '$remotePackagePath' '$packageHash' '$helperHash' '$rollbackArg'"
    & $ssh -tt -o StrictHostKeyChecking=yes $Target $remoteCommand
    if ($LASTEXITCODE -ne 0) { throw "La etapa remota terminó con código $LASTEXITCODE; revisá su validación." }
    & $ssh -o BatchMode=yes -o StrictHostKeyChecking=yes $Target "rm -f -- '$remoteStage/invoice-overlay.tar.gz' '$remoteStage/remote-deploy-softventa-invoice-search.sh' && rmdir -- '$remoteStage'" | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Warning 'El staging remoto quedó para limpieza manual; no contiene secretos.' }
}
finally {
    if ($createdStage) {
        $resolvedStage = [System.IO.Path]::GetFullPath($localStage)
        $allowedPrefix = $tempRoot.TrimEnd('\') + '\'
        if ($resolvedStage.StartsWith($allowedPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
            (Split-Path -Leaf $resolvedStage) -match '^softventa-invoice-[a-f0-9]{16}$') {
            Remove-Item -LiteralPath $resolvedStage -Recurse -Force
        }
    }
}
