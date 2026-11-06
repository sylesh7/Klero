# Starts the whole Klero backend on Windows: Postgres + migrations, facilitator, 3 providers, API.
# One command, from anywhere:
#   powershell -ExecutionPolicy Bypass -File D:\Projects\Klero-1\backend\scripts\win\dev-up.ps1
# Services run hidden in the background; logs go to backend\.logs\<service>.log. Stop with dev-down.ps1.
. (Join-Path $PSScriptRoot 'common.ps1')

Write-Host "Klero backend -> $BackendDir" -ForegroundColor Cyan

Write-Host '1/5 Postgres'
$null = Invoke-Native { docker info }
if ($LASTEXITCODE -ne 0) { throw 'Docker is not running. Start Docker Desktop, then run this again.' }
$null = Invoke-Native { docker compose up -d db }
if ($LASTEXITCODE -ne 0) { throw 'docker compose up -d db failed' }
$ready = $false
for ($i = 0; $i -lt 30 -and -not $ready; $i++) {
  $null = Invoke-Native { docker compose exec -T db pg_isready -U forkos }
  if ($LASTEXITCODE -eq 0) { $ready = $true } else { Start-Sleep -Seconds 1 }
}
if (-not $ready) { throw 'Postgres did not become ready.' }
Write-Host '  ok    postgres        :5442'
$migrate = Invoke-Native { pnpm db:migrate }
if ($LASTEXITCODE -ne 0) { $migrate | Write-Host; throw 'database migration failed' }
$migrate | Where-Object { $_ -match 'applied|skip' } | ForEach-Object { Write-Host "  $_" }

Write-Host '2/5 Stopping anything left on the service ports'
foreach ($name in $Services.Keys) { Stop-Port $Services[$name].Port }
Start-Sleep -Seconds 2

Write-Host '3/5 Facilitator'
Start-KleroService 'facilitator'
$ok = Wait-Http $Services['facilitator'].Health 'facilitator'

Write-Host '4/5 Providers (10 s apart: each announces itself on HCS)'
foreach ($name in 'scribe-a', 'scribe-b', 'scribe-premium') { Start-KleroService $name; Start-Sleep -Seconds 10 }
foreach ($name in 'scribe-a', 'scribe-b', 'scribe-premium') { $ok = (Wait-Http $Services[$name].Health $name) -and $ok }

Write-Host '5/5 API'
Start-KleroService 'api'
$ok = (Wait-Http $Services['api'].Health 'api') -and $ok

Write-Host ''
if (-not $ok) { Write-Host 'Some services failed - check backend\.logs\*.log' -ForegroundColor Red; exit 1 }

$dir = (Invoke-RestMethod -TimeoutSec 30 'http://localhost:4040/v1/directory').services
Write-Host 'Klero backend is up.' -ForegroundColor Green
Write-Host ("  directory (HCS)   {0}" -f (($dir | ForEach-Object { "$($_.providerId)@$([double]$_.price / 1e6)" }) -join ', '))
Write-Host ("  AgentKit mode     {0}" -f (Get-EnvValue 'PROVIDER_AGENTKIT'))
Write-Host ("  demo meeting      {0}" -f (Get-EnvValue 'SAMPLE_AUDIO_URL'))
Write-Host  '  api               http://localhost:4040   (frontend: cd ..\frontend; npm run dev  ->  http://localhost:3000)'
Write-Host  '  logs              backend\.logs\*.log     stop: scripts\win\dev-down.ps1'

# Baseline wallets pay up to ~4 FUSD per `pnpm baseline` run — warn before they run dry mid-demo.
$mirror = Get-EnvValue 'MIRROR_URL'; $asset = Get-EnvValue 'PAY_ASSET'
foreach ($acct in (Get-Content (Join-Path $BackendDir 'deployments\testnet.json') -Raw | ConvertFrom-Json).baselineAgents) {
  try {
    $t = (Invoke-RestMethod -TimeoutSec 15 "$mirror/api/v1/accounts/$acct/tokens?token.id=$asset").tokens
    $fusd = if ($t) { [double]$t[0].balance / 1e6 } else { 0 }
    if ($fusd -lt 4) { Write-Host ("  WARNING baseline {0} has {1} FUSD - top up: scripts\win\topup-baseline.ps1" -f $acct, $fusd) -ForegroundColor Yellow }
  } catch { }
}
