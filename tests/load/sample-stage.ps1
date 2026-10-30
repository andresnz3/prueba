param(
  [Parameter(Mandatory = $true)][string]$Label,
  [Parameter(Mandatory = $true)][int]$Seconds,
  [Parameter(Mandatory = $true)][string]$Project
)

$resultPath = Join-Path $PSScriptRoot ('results/' + $Label + '-resources.csv')
'timestamp,container,cpu_percent,memory_usage,mysql_threads_connected,mysql_threads_running,mysql_max_used_connections,mysql_max_connections' | Set-Content -LiteralPath $resultPath -Encoding ascii
$rootEntry = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'private.env') | Where-Object { $_.StartsWith('MYSQL_ROOT_PASSWORD=') } | Select-Object -First 1
if (-not $rootEntry) { throw 'Temporary Docker root secret missing.' }
$env:MYSQL_PWD = $rootEntry.Substring('MYSQL_ROOT_PASSWORD='.Length)
$composeFile = Join-Path $PSScriptRoot 'compose.yaml'
$envFile = Join-Path $PSScriptRoot 'private.env'
$until = (Get-Date).AddSeconds($Seconds)
try {
  while ((Get-Date) -lt $until) {
    $stamp = (Get-Date).ToUniversalTime().ToString('o')
    $containers = @(docker ps --format '{{.Names}}' --filter "name=$Project")
    $stats = docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' $containers
    $mysqlRows = docker compose --project-name $Project --file $composeFile --env-file $envFile exec -T -e MYSQL_PWD mysql mysql --user=root --batch --skip-column-names --execute="SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected','Threads_running','Max_used_connections'); SHOW GLOBAL VARIABLES LIKE 'max_connections';"
    $values = @{}
    foreach ($row in $mysqlRows) {
      $parts = $row -split "`t", 2
      if ($parts.Length -eq 2) { $values[$parts[0].ToLowerInvariant()] = $parts[1] }
    }
    $mysql = "$($values['threads_connected']),$($values['threads_running']),$($values['max_used_connections']),$($values['max_connections'])"
    foreach ($line in $stats) { Add-Content -LiteralPath $resultPath -Value "$stamp,$line,$mysql" -Encoding ascii }
    Start-Sleep -Seconds 2
  }
} finally {
  Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue
}
