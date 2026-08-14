param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$healthUrl = 'http://127.0.0.1:4180/api/status'
try {
  Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2 | Out-Null
} catch {
  Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList @('src/cli.mjs', 'serve') -WorkingDirectory $projectRoot -WindowStyle Hidden
  $ready = $false
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 250
    try {
      Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1 | Out-Null
      $ready = $true
      break
    } catch {}
  }
  if (-not $ready) { throw 'AgentTrader did not become ready on 127.0.0.1:4180.' }
}
if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:4180' }
