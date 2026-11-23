[CmdletBinding()]
param(
    [switch]$SelfTest,
    [switch]$DiagnoseOnly,
    [switch]$Deploy
)

$ErrorActionPreference = 'Stop'
$Target = 'posadmin@31.220.84.51'
$SourceDir = $PSScriptRoot
$Files = @('deploy-security-headers.sh', 'patch-security-config.py')
$Python = 'C:\Users\andre\AppData\Local\Programs\Python\Python311\python.exe'

$selectedModes = 0
foreach ($modeSwitch in @($SelfTest, $DiagnoseOnly, $Deploy)) {
    if ($modeSwitch.IsPresent) { $selectedModes++ }
}
if ($selectedModes -ne 1) { throw 'Elegir exactamente una opcion: -SelfTest, -DiagnoseOnly o -Deploy.' }
$ssh = Get-Command ssh.exe -ErrorAction Stop
$scp = Get-Command scp.exe -ErrorAction Stop
$random = New-Object byte[] 16
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($random) } finally { $rng.Dispose() }
$runId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '-' + ([BitConverter]::ToString($random)).Replace('-', '').ToLowerInvariant()
$localStage = Join-Path ([IO.Path]::GetTempPath()) "softventa-caddy-headers-$runId"
$remoteStage = if ($SelfTest) { "/home/posadmin/.pos-caddy-security-selftest-$runId" } else { "/home/posadmin/.pos-caddy-security-$runId" }
$localCreated = $false
$remoteCreated = $false
try {
    if (Test-Path -LiteralPath $localStage) { throw 'El staging local ya existe; no se reutilizara.' }
    New-Item -ItemType Directory -Path $localStage | Out-Null
    $localCreated = $true
    foreach ($name in $Files) {
        $source = Join-Path $SourceDir $name
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Falta el archivo del helper: $name" }
        Copy-Item -LiteralPath $source -Destination (Join-Path $localStage $name)
    }
    $helperPath = Join-Path $localStage 'deploy-security-headers.sh'
    $patcherPath = Join-Path $localStage 'patch-security-config.py'
    $helperHash = (Get-FileHash -LiteralPath $helperPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $patcherHash = (Get-FileHash -LiteralPath $patcherPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($helperHash -notmatch '^[a-f0-9]{64}$' -or $patcherHash -notmatch '^[a-f0-9]{64}$') { throw 'No se pudieron calcular los SHA-256 locales.' }

    $tokens = $null; $parseErrors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($PSCommandPath, [ref]$tokens, [ref]$parseErrors) | Out-Null
    if ($parseErrors.Count) { throw 'La sintaxis PowerShell no es valida.' }
    & $Python -c "import ast,pathlib,sys; ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8'))" $patcherPath
    if ($LASTEXITCODE -ne 0) { throw 'Fallo la sintaxis Python del parcheador.' }
    & $Python $patcherPath --self-test
    if ($LASTEXITCODE -ne 0) { throw 'Fallaron las pruebas locales del parcheador.' }

    $helperText = [IO.File]::ReadAllText($helperPath)
    $forbiddenCommands = @(
        '(?m)^\s*(?:sudo\s+)?docker\s+(?:compose|build|run|tag|rm|restart|stop|start|exec|create|network|volume)\b',
        '(?m)^\s*systemctl\s+(?:restart|start|stop)\s+caddy\b',
        '(?m)^\s*nginx(?:\s|$)',
        '(?m)^\s*(?:python3\s+[^\r\n]*patch-nginx|bash\s+[^\r\n]*patch-nginx)'
    )
    foreach ($pattern in $forbiddenCommands) {
        if ([regex]::IsMatch($helperText, $pattern)) { throw 'El helper contiene una operacion fuera del alcance Caddy-only.' }
    }
    if (-not $helperText.Contains('systemctl reload caddy') -or -not $helperText.Contains('caddy validate --config')) { throw 'Falta validacion/recarga exclusiva de Caddy.' }
    Write-Output 'POWERSHELL_SYNTAX=PASS'
    Write-Output 'CADDY_ONLY_SCOPE_GUARD=PASS; no Nginx edits or container/frontend operations'

    & $ssh.Source -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 $Target "umask 077 && mkdir -m 700 -- '$remoteStage'"
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo abrir un staging remoto privado por SSH.' }
    $remoteCreated = $true
    $remoteHelper = "$remoteStage/deploy-security-headers.sh"
    $remotePatcher = "$remoteStage/patch-security-config.py"
    & $scp.Source -o BatchMode=yes -o StrictHostKeyChecking=yes $helperPath "$($Target):$remoteHelper"
    if ($LASTEXITCODE -ne 0) { throw 'Fallo la transferencia SSH del helper.' }
    & $scp.Source -o BatchMode=yes -o StrictHostKeyChecking=yes $patcherPath "$($Target):$remotePatcher"
    if ($LASTEXITCODE -ne 0) { throw 'Fallo la transferencia SSH del parcheador.' }
    $prepare = "chmod 700 '$remoteHelper' && chmod 600 '$remotePatcher' && stat -c '%U:%G:%a' '$remoteStage' '$remoteHelper' '$remotePatcher' && sha256sum '$remoteHelper' '$remotePatcher' && bash -n '$remoteHelper' && bash '$remoteHelper' --self-test && python3 '$remotePatcher' --self-test"
    $prepareOutput = @(& $ssh.Source -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 $Target $prepare)
    if ($LASTEXITCODE -ne 0) { throw 'Fallaron bash -n o las autopruebas remotas; no se invoco sudo.' }
    $hashes = @($prepareOutput | ForEach-Object { if ($_ -match '^([a-f0-9]{64})\s+') { $Matches[1] } })
    $modes = @($prepareOutput | Where-Object { $_ -match '^posadmin:posadmin:(700|600)$' })
    if ($hashes.Count -ne 2 -or $hashes[0] -ne $helperHash -or $hashes[1] -ne $patcherHash -or $modes.Count -ne 3 -or $prepareOutput -notcontains 'CADDY_ONLY_SELF_TEST=PASS; no-frontend-nginx-or-container-mutations' -or $prepareOutput -notcontains 'POST_HEADER_VERIFIER_TEST=PASS; valid=accepted; wrong-and-duplicate=rejected' -or $prepareOutput -notcontains 'CADDY_TOPOLOGY_TEST=PASS') {
        throw 'No coinciden los hashes, permisos o resultados de autoprueba remota.'
    }
    Write-Output 'REMOTE_BASH_SYNTAX=PASS'
    Write-Output 'REMOTE_PATCHER_AND_CADDY_ONLY_TESTS=PASS'
    Write-Output 'REMOTE_POST_HEADER_VERIFIER=PASS; correct=accepted; wrong-and-duplicate=rejected'
    $mode = if ($DiagnoseOnly) { 'diagnose-only' } else { 'deploy' }
    $rootStage = "/run/pos-caddy-security-$runId"
    $rootHelper = "$rootStage/deploy-security-headers.sh"
    $rootPatcher = "$rootStage/patch-security-config.py"
    $bootstrapLines = @(
        "set -u; d='$rootStage';",
        'if [ -e "$d" ] || [ -L "$d" ]; then exit 70; fi;',
        'install -d -o root -g root -m 0700 -- "$d" &&',
        "install -T -o root -g root -m 0700 -- '$remoteHelper' `"`$d/deploy-security-headers.sh`" &&",
        "install -T -o root -g root -m 0600 -- '$remotePatcher' `"`$d/patch-security-config.py`" &&",
        "printf '%s  %s\n' '$helperHash' '$rootHelper' | sha256sum --check --status - &&",
        "printf '%s  %s\n' '$patcherHash' '$rootPatcher' | sha256sum --check --status - &&",
        "bash `"`$d/deploy-security-headers.sh`" `"`$d`" '$runId' '$helperHash' '$patcherHash' '$mode';",
        'rc=$?;',
        'if [ -d "$d" ] && [ ! -L "$d" ] && [ "$(stat -c ''%U:%G:%a'' "$d")" = "root:root:700" ]; then rm -rf -- "$d"; fi;',
        'exit "$rc"'
    )
    $bootstrap = $bootstrapLines -join ' '
    $bootstrapQuoted = "'" + $bootstrap.Replace("'", "'\''") + "'"
    $remoteRun = "sudo bash -c $bootstrapQuoted"
    if ($remoteRun.Length -gt 4096) { throw 'Remote staging wrapper exceeds the permitted length.' }
    if ($SelfTest) {
        $bootstrapSyntaxCheck = "bash -n -c $bootstrapQuoted"
        & $ssh.Source -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 $Target $bootstrapSyntaxCheck
        if ($LASTEXITCODE -ne 0) { throw 'Remote sudo wrapper syntax validation failed.' }
        Write-Output 'REMOTE_SUDO_WRAPPER_SYNTAX=PASS; not executed'
        Write-Output 'REMOTE_PRODUCTION_ACTION=NOT_RUN'
        return
    }

        if ($Deploy) { Write-Output 'MODO DESPLIEGUE: se modificara exclusivamente Caddyfile y se recargara Caddy.' }
    else { Write-Output 'MODO DIAGNOSTICO: no se recargara Caddy ni se cambiaran servicios.' }
    Write-Output 'sudo solicitara la contrasena en esta terminal SSH; no se captura ni almacena.'
    & $ssh.Source -tt -o StrictHostKeyChecking=yes -o ConnectTimeout=10 $Target $remoteRun
    if ($LASTEXITCODE -ne 0) {
        if ($DiagnoseOnly) { throw 'Diagnostico detenido; no se modifico la configuracion activa.' }
        throw 'Despliegue detenido o rollback ejecutado; revisar el ultimo STEP/ROLLBACK reportado.'
    }
}
finally {
    if ($remoteCreated) {
        & $ssh.Source -o BatchMode=yes -o StrictHostKeyChecking=yes $Target "rm -f -- '$remoteStage/deploy-security-headers.sh' '$remoteStage/patch-security-config.py' && rmdir -- '$remoteStage'"
        if ($LASTEXITCODE -ne 0) { throw 'No se pudo limpiar el staging remoto temporal.' }
        Write-Output 'REMOTE_STAGING_CLEANUP=PASS'
    }
    if ($localCreated -and (Test-Path -LiteralPath $localStage)) { Remove-Item -LiteralPath $localStage -Recurse -Force }
}
