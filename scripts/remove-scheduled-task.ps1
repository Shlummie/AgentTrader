param([Parameter(Mandatory = $true)][string]$TaskName)
$ErrorActionPreference = 'Stop'
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $existing) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  [pscustomobject]@{ TaskName = $TaskName; Removed = $true } | ConvertTo-Json -Compress
} else {
  [pscustomobject]@{ TaskName = $TaskName; Removed = $false; Reason = 'not installed' } | ConvertTo-Json -Compress
}
