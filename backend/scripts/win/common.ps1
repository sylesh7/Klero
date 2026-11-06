# Shared helpers for the Windows dev scripts (dot-sourced). Works in Windows PowerShell 5.1 and PowerShell 7.
$ErrorActionPreference = 'Stop'
$BackendDir = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Set-Location $BackendDir

# pnpm runs package scripts through the configured script shell; a global `script-shell=cmd.exe` makes every
# `pnpm <script>` hang on Windows. Git Bash works.
$GitBash = 'C:\Program Files\Git\bin\bash.exe'
if (-not (Test-Path $GitBash)) { throw "Git Bash not found at $GitBash (pnpm needs it as its script shell)." }
$env:npm_config_script_shell = $GitBash
$Shell = if (Get-Command pwsh -ErrorAction SilentlyContinue) { 'pwsh' } else { 'powershell' }
New-Item -ItemType Directory -Force (Join-Path $BackendDir '.logs') | Out-Null

$Services = [ordered]@{
  'facilitator'    = @{ Script = 'dev:facilitator';    Port = 4020; Health = 'http://localhost:4020/health' }
  'scribe-a'       = @{ Script = 'dev:scribe-a';       Port = 4031; Health = 'http://localhost:4031/health' }
  'scribe-b'       = @{ Script = 'dev:scribe-b';       Port = 4032; Health = 'http://localhost:4032/health' }
  'scribe-premium' = @{ Script = 'dev:scribe-premium'; Port = 4033; Health = 'http://localhost:4033/health' }
  'api'            = @{ Script = 'dev:api';            Port = 4040; Health = 'http://localhost:4040/v1/health' }
}

function Invoke-Native([scriptblock]$Block) {
  # Windows PowerShell 5.1 turns a native program's stderr (progress text from docker, npm notices…) into a
  # terminating error under ErrorActionPreference=Stop. Run native calls with Continue and judge by exit code.
  $saved = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $out = & $Block 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $saved }
  return , @($out)
}

function Stop-Port([int]$Port) {
  # tsx watch runs the service as a child process: kill the listener AND its watcher parent, or the watcher
  # respawns it and the port stays busy.
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)"
    if ($p) { Stop-Process -Id $p.ProcessId, $p.ParentProcessId -Force -ErrorAction SilentlyContinue }
  }
}

function Test-Port([int]$Port) {
  [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Wait-Http([string]$Url, [string]$Name, [int]$Seconds = 90) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 $Url | Out-Null; Write-Host ("  ok    {0,-15} {1}" -f $Name, $Url); return $true }
    catch { Start-Sleep -Seconds 1 }
  }
  Write-Host ("  FAIL  {0,-15} see backend\.logs\{0}.log" -f $Name) -ForegroundColor Red
  return $false
}

function Start-KleroService([string]$Name) {
  $svc = $Services[$Name]
  $log = Join-Path $BackendDir ".logs\$Name.log"
  # A process that is still shutting down can hold the old log open; then the new service could not open it and
  # would exit silently. Fall back to a timestamped log in that case.
  try { if (Test-Path $log) { Remove-Item $log -Force -ErrorAction Stop } }
  catch { $log = Join-Path $BackendDir (".logs\{0}-{1}.log" -f $Name, (Get-Date -Format 'HHmmss')) }
  $cmd = "`$env:npm_config_script_shell='$GitBash'; Set-Location '$BackendDir'; pnpm $($svc.Script) *> '$log'"
  Start-Process $Shell -ArgumentList '-NoProfile', '-Command', $cmd -WindowStyle Hidden | Out-Null
}

function Get-EnvValue([string]$Key) {
  $line = Get-Content (Join-Path $BackendDir '.env') | Where-Object { $_ -match "^$Key=" } | Select-Object -First 1
  if ($line) { $line.Substring($Key.Length + 1).Trim() } else { $null }
}

function Set-EnvValue([string]$Key, [string]$Value) {
  # keeps the file's LF line endings (CRLF would end up inside every value)
  $path = Join-Path $BackendDir '.env'
  $text = [IO.File]::ReadAllText($path)
  if ($text -match "(?m)^$Key=.*$") { $text = [regex]::Replace($text, "(?m)^$Key=.*$", "$Key=$Value") }
  else { $text = $text.TrimEnd("`n") + "`n$Key=$Value`n" }
  [IO.File]::WriteAllText($path, $text)
}
