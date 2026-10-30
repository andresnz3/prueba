param(
  [Parameter(Mandatory = $false)][ValidateRange(30, 180)][int]$HumanSeconds = 60,
  [Parameter(Mandatory = $false)][ValidateRange(10, 60)][int]$BurstSeconds = 20
)

$ErrorActionPreference = 'Continue'
$env:PATH = 'C:\Users\andre\AppData\Local\Programs\DockerDesktop\resources\bin;' + $env:PATH
$composeFile = Join-Path $PSScriptRoot 'compose.yaml'
$envFile = Join-Path $PSScriptRoot 'private.env'
$resultsDir = Join-Path $PSScriptRoot 'results'
if (-not (Test-Path -LiteralPath $envFile)) { throw 'Temporary load environment is missing.' }
$projectLine = Get-Content -LiteralPath $envFile | Where-Object { $_.StartsWith('LOAD_PROJECT=') } | Select-Object -First 1
$databaseLine = Get-Content -LiteralPath $envFile | Where-Object { $_.StartsWith('DB_NAME=') } | Select-Object -First 1
if (-not $projectLine -or -not $databaseLine) { throw 'Temporary project identity is missing.' }
$project = $projectLine.Substring('LOAD_PROJECT='.Length)
$databaseName = $databaseLine.Substring('DB_NAME='.Length)
if ($project -notmatch '^pos-loadtest-[0-9]{8}-[a-f0-9]{8}$' -or $databaseName -notmatch '^pos_auth_test_[a-f0-9]{24}$' -or $databaseName -in @('pos_multitenant', 'pos_docker_local')) {
  throw 'Temporary project identity validation failed.'
}
New-Item -ItemType Directory -Force -Path $resultsDir | Out-Null
$composeArgs = @('--project-directory', $PSScriptRoot, '--file', $composeFile, '--env-file', $envFile)

function Invoke-LoadStage {
  param([Parameter(Mandatory = $true)][hashtable]$Stage)

  $env:LOAD_AUTH_RATE_MAX = '100'
  $env:LOAD_VUS = [string]$Stage.VUs
  $env:LOAD_DURATION = "$($Stage.Seconds)s"
  $env:LOAD_MODE = $Stage.Mode
  $env:LOAD_RUN_TAG = $Stage.Name
  Write-Host "Starting isolated stage $($Stage.Name) with $($Stage.VUs) virtual users for $($Stage.Seconds) seconds."
  $upOutput = & docker compose @composeArgs up -d --no-deps --force-recreate backend 2>&1
  $upExit = $LASTEXITCODE
  $upOutput | ForEach-Object { Write-Host $_ }
  if ($upExit -ne 0) { throw 'Temporary backend could not be recreated.' }

  $samplerPath = Join-Path $PSScriptRoot 'sample-stage.ps1'
  $samplerArgs = '-NoProfile -ExecutionPolicy Bypass -File "' + $samplerPath + '" -Label "' + $Stage.Name + '" -Seconds ' + ($Stage.Seconds + 8) + ' -Project "' + $project + '"'
  $sampler = Start-Process -FilePath 'powershell.exe' -ArgumentList $samplerArgs -WindowStyle Hidden -PassThru
  $loadOutput = & docker compose @composeArgs --profile load run --rm --user 0:0 load 2>&1
  $loadExit = $LASTEXITCODE
  $loadOutput | ForEach-Object { Write-Host $_ }
  Wait-Process -Id $sampler.Id -Timeout ($Stage.Seconds + 40) -ErrorAction SilentlyContinue
  $sampler.Refresh()
  $samplerExit = if ($sampler.HasExited) { $sampler.ExitCode } else { Stop-Process -Id $sampler.Id -PassThru; -1 }
  if ($samplerExit -ne 0) { Write-Warning "Resource sampler ended with code $samplerExit for $($Stage.Name)." }

  $summaryPath = Join-Path $resultsDir 'summary.json'
  $stageSummaryPath = Join-Path $resultsDir ($Stage.Name + '.json')
  if (-not (Test-Path -LiteralPath $summaryPath)) { return [pscustomobject]@{ ExitCode = 1; UnexpectedRate = 1; ControlledBusy = 0; SummaryPath = $null } }
  Copy-Item -LiteralPath $summaryPath -Destination $stageSummaryPath -Force
  $summary = Get-Content -LiteralPath $summaryPath -Raw | ConvertFrom-Json
  $unexpectedRate = [double]$summary.metrics.unexpected_failure_rate.value
  $controlledBusy = [double]$summary.metrics.controlled_pool_busy.count
  return [pscustomobject]@{ ExitCode = $loadExit; UnexpectedRate = $unexpectedRate; ControlledBusy = $controlledBusy; SummaryPath = $stageSummaryPath }
}

$humanStages = @(
  @{ Name = 'human-5'; VUs = 5; Mode = 'human'; Seconds = $HumanSeconds },
  @{ Name = 'human-10'; VUs = 10; Mode = 'human'; Seconds = $HumanSeconds },
  @{ Name = 'human-25'; VUs = 25; Mode = 'human'; Seconds = $HumanSeconds },
  @{ Name = 'human-50'; VUs = 50; Mode = 'human'; Seconds = $HumanSeconds },
  @{ Name = 'human-100'; VUs = 100; Mode = 'human'; Seconds = $HumanSeconds }
)
$lastStableVUs = 0
$overallExit = 0
$allowBurst = $true
foreach ($stage in $humanStages) {
  $result = Invoke-LoadStage -Stage $stage
  if ($result.ExitCode -eq 0) {
    $lastStableVUs = $stage.VUs
    continue
  }
  $overallExit = 1
  if ($result.UnexpectedRate -eq 0 -and $result.ControlledBusy -gt 0) {
    Write-Warning "Controlled database saturation began at $($stage.VUs) VUs; higher human-load stages are stopped."
  } else {
    Write-Warning "Unexpected failures occurred at $($stage.VUs) VUs; the stress stage is skipped."
    $allowBurst = $false
  }
  break
}

if ($allowBurst -and $lastStableVUs -gt 0) {
  $burst = @{ Name = "burst-$lastStableVUs"; VUs = $lastStableVUs; Mode = 'burst'; Seconds = $BurstSeconds }
  $burstResult = Invoke-LoadStage -Stage $burst
  if ($burstResult.ExitCode -ne 0 -or $burstResult.UnexpectedRate -gt 0) { $overallExit = 1 }
}

Write-Host "Running read-only integrity verification for isolated database $databaseName."
$integrityOutput = & docker compose @composeArgs --profile tools run --rm --no-deps --entrypoint node backend /run/check-integrity.cjs 2>&1
$integrityExit = $LASTEXITCODE
$integrityOutput | ForEach-Object { Write-Host $_ }
if ($integrityExit -ne 0) { $overallExit = 1 }
exit $overallExit
