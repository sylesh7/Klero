# Tops up the three baseline-lane wallets with FUSD from the treasury (operator) so `pnpm baseline` can keep
# paying 3 times. Testnet only.
#   powershell -ExecutionPolicy Bypass -File D:\Projects\Klero-1\backend\scripts\win\topup-baseline.ps1 [-Fusd 20]
param([int]$Fusd = 20)
. (Join-Path $PSScriptRoot 'common.ps1')
$tsx = Join-Path $BackendDir 'node_modules\.bin\tsx.cmd'
$out = Invoke-Native { & $tsx --env-file=.env scripts/topup-baseline.ts $Fusd }
$out | Where-Object { $_ -notmatch 'ExperimentalWarning|trace-warnings' } | Write-Host
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
