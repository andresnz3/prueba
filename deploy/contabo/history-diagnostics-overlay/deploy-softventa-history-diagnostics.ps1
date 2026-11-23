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
$RemoteHelper = Join-Path $PSScriptRoot 'remote-deploy-softventa-history-diagnostics.sh'
$ArchiveBuilder = Join-Path $PSScriptRoot 'create-reproducible-history-archive.cjs'
$PayloadFiles = @('Dockerfile.frontend','apply-history-diagnostics.cjs','MANIFEST.sha256')
$OuterFiles = @(
    'README.md',
    'create-reproducible-history-archive.cjs',
    'deploy-softventa-history-diagnostics.ps1',
    'remote-deploy-softventa-history-diagnostics.sh',
    'payload\Dockerfile.frontend',
    'payload\apply-history-diagnostics.cjs',
    'payload\MANIFEST.sha256'
)

function Assert-Manifest {
    param([string]$ManifestPath, [string]$Root, [string[]]$Expected)
    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { throw "Falta el manifiesto: $ManifestPath" }
    $actual = @()
    foreach ($row in @(Get-Content -LiteralPath $ManifestPath)) {
        if ($row -notmatch '^([a-f0-9]{64})  (.+)$') { throw 'Formato SHA-256 inválido.' }
        $hash = $Matches[1]; $relative = $Matches[2].Replace('/','\')
        if ($relative -notin $Expected) { throw "Ruta fuera del allowlist: $relative" }
        $actual += $relative; $file = Join-Path $Root $relative
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Falta archivo de manifiesto: $relative" }
        if ((Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant() -ne $hash) { throw "SHA-256 incorrecto: $relative" }
    }
    if (Compare-Object -ReferenceObject @($Expected | Sort-Object) -DifferenceObject @($actual | Sort-Object)) { throw 'El manifiesto no cubre exactamente el allowlist.' }
}

function Assert-LinuxScript {
    $bytes = [System.IO.File]::ReadAllBytes($RemoteHelper)
    if ([Array]::IndexOf($bytes, [byte]13) -ge 0) { throw 'El helper Linux contiene CR/CRLF; se exige LF.' }
    if ([Array]::IndexOf($bytes, [byte]10) -lt 0) { throw 'El helper Linux no contiene saltos LF.' }
    $helperText = [System.IO.File]::ReadAllText($RemoteHelper)
    if (-not $helperText.Contains('bash -n "$0"')) { throw 'El helper remoto debe ejecutar bash -n antes de sus precondiciones.' }
    $bash = Get-Command bash -ErrorAction SilentlyContinue
    $localBashPassed = $false
    if ($bash) {
        try { $null = @(& $bash.Source -n $RemoteHelper 2>&1); $localBashPassed = ($LASTEXITCODE -eq 0) } catch { $localBashPassed = $false }
    }
    if ($localBashPassed) { Write-Output 'LOCAL_BASH_SYNTAX=PASS' }
    else { Write-Output 'LOCAL_BASH_SYNTAX=REMOTE_PREFLIGHT_REQUIRED; sudo /bin/bash -n runs before helper execution' }
}

function Assert-Package {
    foreach ($file in $PayloadFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $PayloadDir $file) -PathType Leaf)) { throw "Falta payload: $file" }
    }
    $payloadActual = @(Get-ChildItem -LiteralPath $PayloadDir -File | ForEach-Object Name | Sort-Object)
    if (Compare-Object -ReferenceObject @($PayloadFiles | Sort-Object) -DifferenceObject $payloadActual) { throw 'El payload contiene archivos adicionales o faltantes.' }
    Assert-Manifest -ManifestPath (Join-Path $PayloadDir 'MANIFEST.sha256') -Root $PayloadDir -Expected ($PayloadFiles | Where-Object { $_ -ne 'MANIFEST.sha256' })
    Assert-Manifest -ManifestPath (Join-Path $PSScriptRoot 'PACKAGE_CONTENTS.sha256') -Root $PSScriptRoot -Expected $OuterFiles
    Assert-LinuxScript
    $node = Get-Command node.exe -ErrorAction Stop
    & $node.Source --check (Join-Path $PayloadDir 'apply-history-diagnostics.cjs')
    if ($LASTEXITCODE -ne 0) { throw 'Node rechazó la sintaxis del transformador.' }
    & $node.Source (Join-Path $PayloadDir 'apply-history-diagnostics.cjs') --self-test
    if ($LASTEXITCODE -ne 0) { throw 'Falló el SelfTest del transformador.' }
    & $node.Source --check $ArchiveBuilder
    if ($LASTEXITCODE -ne 0) { throw 'Node rechazó la sintaxis del generador TAR reproducible.' }
    & $node.Source $ArchiveBuilder --self-test
    if ($LASTEXITCODE -ne 0) { throw 'Falló la regresión de reproducibilidad TAR.' }
    $launcherText = [System.IO.File]::ReadAllText($PSCommandPath)
    $sshCalls = [regex]::Matches($launcherText, '(?m)^\s*& \$ssh(?:\s|$)').Count
    $scpCalls = [regex]::Matches($launcherText, '(?m)^\s*& \$scp(?:\s|$)').Count
    if ($sshCalls -ne 2 -or $scpCalls -ne 1 -or $launcherText -notmatch 'ConnectionAttempts=2' -or $launcherText -notmatch 'remoteCommand = "chmod 600 --' -or [regex]::IsMatch($launcherText, '(?m)^[ \t]*& \$ssh[ \t][^\r\n]*chmod')) { throw 'El flujo SSH ya no conserva sesiones acotadas y el chmod integrado.' }
    $psTokens = $null; $psErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($PSCommandPath, [ref]$psTokens, [ref]$psErrors)
    if ($psErrors.Count -gt 0) { throw 'La sintaxis PowerShell no es válida.' }
    $outerActual = @(Get-ChildItem -LiteralPath $PSScriptRoot -File -Recurse | ForEach-Object { $_.FullName.Substring($PSScriptRoot.Length + 1) } | Sort-Object)
    $outerExpected = @($OuterFiles + 'PACKAGE_CONTENTS.sha256' | Sort-Object)
    if (Compare-Object -ReferenceObject $outerExpected -DifferenceObject $outerActual) { throw 'El paquete contiene archivos adicionales o faltantes.' }
}

if ($SelfTest) {
    Assert-Package
    Write-Output 'POWERSHELL_SYNTAX=PASS'
    Write-Output 'LINUX_SCRIPT_LINE_ENDINGS=LF_ONLY'
    Write-Output 'REMOTE_BASH_SYNTAX_CHECK=MANDATORY_BEFORE_EXECUTION'
    Write-Output 'SSH_SESSIONS=2_COMMANDS_PLUS_SCP=1; STANDALONE_CHMOD=ABSENT'
    Write-Output 'PACKAGE_SHA256_MANIFEST=PASS'
    Write-Output 'SELFTEST=PASS; no SSH, Docker, API or production access'
    exit 0
}

$selected = @()
if ($PrepareCandidateOnly) { $selected += 'prepare' }
if ($Deploy) { $selected += 'deploy' }
if ($Rollback) { $selected += 'rollback' }
if ($selected.Count -ne 1) { throw 'Elegí exactamente una modalidad: -SelfTest, -PrepareCandidateOnly, -Deploy o -Rollback.' }
if ($Rollback -and $RollbackTag -notmatch '^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$') { throw 'Rollback requiere el token entregado por el despliegue.' }
if (-not $Rollback -and $RollbackTag) { throw 'RollbackTag solo se usa junto con -Rollback.' }
Assert-Package

$nonce = [Guid]::NewGuid().ToString('N').Substring(0,16)
$tempRoot = [System.IO.Path]::GetFullPath($env:TEMP)
$localStage = Join-Path $tempRoot "softventa-history-diag-$nonce"
$remoteStage = "/home/posadmin/.pos-history-diag-$nonce"
$createdStage = $false
$ssh = $null
try {
    New-Item -ItemType Directory -Path $localStage | Out-Null
    $createdStage = $true
    foreach ($file in $PayloadFiles) { Copy-Item -LiteralPath (Join-Path $PayloadDir $file) -Destination (Join-Path $localStage $file) }
    $packagePath = Join-Path $localStage 'history-diagnostics-overlay.tar.gz'
    $tar = (Get-Command tar.exe -ErrorAction Stop).Source
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    & $node $ArchiveBuilder --create $localStage $packagePath
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo crear el TAR reproducible del payload allowlist.' }
    $entries = @(& $tar '-tzf' $packagePath | Sort-Object -CaseSensitive)
    $expectedEntries = @('Dockerfile.frontend','MANIFEST.sha256','apply-history-diagnostics.cjs') | Sort-Object -CaseSensitive
    if (Compare-Object -ReferenceObject $expectedEntries -DifferenceObject $entries) { throw 'El TAR contiene archivos adicionales o faltantes.' }
    $packageHash = (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $helperHash = (Get-FileHash -LiteralPath $RemoteHelper -Algorithm SHA256).Hash.ToLowerInvariant()
    $ssh = (Get-Command ssh.exe -ErrorAction Stop).Source; $scp = (Get-Command scp.exe -ErrorAction Stop).Source
    Write-Output "REMOTE_STAGE=$remoteStage"
    $connectionOptions = @('-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=15','-o','ConnectionAttempts=2')
    & $ssh -o BatchMode=yes @connectionOptions $Target "mkdir -m 700 -- '$remoteStage'"
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo crear el staging temporal remoto.' }
    & $scp -o BatchMode=yes @connectionOptions $packagePath $RemoteHelper ($Target + ':' + $remoteStage + '/')
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo transferir el payload allowlist.' }
    if ($PrepareCandidateOnly) { $remoteMode = '--prepare-only'; $rollbackArg = '' }
    elseif ($Rollback) { $remoteMode = '--rollback'; $rollbackArg = $RollbackTag }
    else { $remoteMode = '--deploy'; $rollbackArg = '' }
    $remoteHelperPath = "$remoteStage/remote-deploy-softventa-history-diagnostics.sh"
    $remotePackagePath = "$remoteStage/history-diagnostics-overlay.tar.gz"
    $remoteCommand = "chmod 600 -- '$remotePackagePath' '$remoteHelperPath' && sudo -v && sudo /bin/bash -n '$remoteHelperPath' && sudo /bin/bash '$remoteHelperPath' '$remoteMode' '$remotePackagePath' '$packageHash' '$helperHash' '$rollbackArg'; rc=`$?; if [ `$rc -eq 0 ]; then rm -f -- '$remotePackagePath' '$remoteHelperPath' && rmdir -- '$remoteStage' || printf '%s\n' 'REMOTE_STAGE_CLEANUP=WARNING; retained for manual review' >&2; fi; exit `$rc"
    & $ssh -tt @connectionOptions $Target $remoteCommand
    if ($LASTEXITCODE -ne 0) { throw "La etapa remota terminó con código $LASTEXITCODE; no continuar." }
}
finally {
    if ($createdStage) {
        $resolved = [System.IO.Path]::GetFullPath($localStage)
        $allowed = $tempRoot.TrimEnd('\') + '\'
        if ($resolved.StartsWith($allowed, [System.StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolved) -match '^softventa-history-diag-[a-f0-9]{16}$') {
            Remove-Item -LiteralPath $resolved -Recurse -Force
        }
    }
}
