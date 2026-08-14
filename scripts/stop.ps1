$ErrorActionPreference = 'Stop'
$shutdownUrl = 'http://127.0.0.1:4180/api/shutdown'
try {
  Invoke-RestMethod -Uri $shutdownUrl -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 3 | Out-Null
} catch {
  Write-Output 'AgentTrader dashboard was not running.'
  exit 0
}
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  Start-Sleep -Milliseconds 200
  try {
    Invoke-RestMethod -Uri 'http://127.0.0.1:4180/api/status' -TimeoutSec 1 | Out-Null
  } catch {
    Write-Output 'AgentTrader dashboard stopped. Scheduled trading setting was not changed.'
    exit 0
  }
}
throw 'Dashboard shutdown was requested but port 4180 is still responding.'
