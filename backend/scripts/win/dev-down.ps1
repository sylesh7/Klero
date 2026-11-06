# Stops the Klero backend services started by dev-up.ps1. Add -Db to stop Postgres too.
#   powershell -ExecutionPolicy Bypass -File D:\Projects\Klero-1\backend\scripts\win\dev-down.ps1 [-Db]
param([switch]$Db)
. (Join-Path $PSScriptRoot 'common.ps1')
foreach ($name in $Services.Keys) {
  Stop-Port $Services[$name].Port
  Write-Host ("  stopped {0,-15} :{1}" -f $name, $Services[$name].Port)
}
if ($Db) { $null = Invoke-Native { docker compose stop db }; Write-Host '  stopped postgres' }
