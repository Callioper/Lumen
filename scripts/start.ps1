# Start Lumen (8780) and the native RSSHub bridge (1200) without console windows.
# Safe to run repeatedly: a service already listening is left alone.
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$logs = Join-Path $root 'data'
New-Item -ItemType Directory -Force $logs | Out-Null

function Start-NodeService([string]$name, [int]$port, [string]$workDir, [string]$script) {
  if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
    Write-Output "$name already running on port $port"
    return
  }
  Start-Process -FilePath $node -ArgumentList $script -WorkingDirectory $workDir -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logs "$name.out.log") -RedirectStandardError (Join-Path $logs "$name.err.log")
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
      Write-Output "$name started: http://127.0.0.1:$port/"
      return
    }
  }
  Write-Output "$name did not come up within 15s, see data\$name.err.log"
}

$rsshubDir = Join-Path $root 'rsshub'
if (Test-Path (Join-Path $rsshubDir 'node_modules\rsshub')) {
  Start-NodeService 'rsshub' 1200 $rsshubDir 'server.mjs'
} else {
  Write-Output "rsshub not installed (rsshub\node_modules missing); RSSHub feeds will fail"
}
Start-NodeService 'lumen' 8780 $root 'server/main.ts'
