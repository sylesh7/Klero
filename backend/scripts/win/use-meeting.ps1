# Points the demo job at a fresh, never-paid meeting and restarts the API (a paid meeting skips straight to
# "already paid"). Creates services\provider\public\video-<N>.mp3 from the sample if it does not exist.
#   powershell -ExecutionPolicy Bypass -File D:\Projects\Klero-1\backend\scripts\win\use-meeting.ps1 -N 20
param([Parameter(Mandatory = $true)][int]$N)
. (Join-Path $PSScriptRoot 'common.ps1')
$public = Join-Path $BackendDir 'services\provider\public'
$file = Join-Path $public "video-$N.mp3"
if (-not (Test-Path $file)) {
  if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { throw 'ffmpeg is not on PATH (needed to create a fresh meeting).' }
  $src = Join-Path $public 'sample-meeting.mp3'
  $out = Invoke-Native { ffmpeg -loglevel error -y -i $src -b:a 128k -metadata "title=video-$N" $file }
  if ($LASTEXITCODE -ne 0) { $out | Write-Host; throw 'ffmpeg failed' }
}
Set-EnvValue 'SAMPLE_AUDIO_URL' "http://localhost:4031/video-$N.mp3"
Write-Host "Demo meeting -> video-$N.mp3; restarting the API"
Stop-Port 4040
Start-Sleep -Seconds 2
Start-KleroService 'api'
if (Wait-Http $Services['api'].Health 'api') { Write-Host 'Ready: on /race click "Load demo job" (it should show OPEN).' -ForegroundColor Green }
else { exit 1 }
