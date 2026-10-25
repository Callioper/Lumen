# Stop Lumen and the RSSHub bridge.
foreach ($port in 8780, 1200) {
  $conns = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
  if (-not $conns) { Write-Output "port ${port}: not running"; continue }
  foreach ($c in $conns) { Stop-Process -Id $c.OwningProcess -Force -Confirm:$false -ErrorAction SilentlyContinue }
  Write-Output "port ${port}: stopped"
}
