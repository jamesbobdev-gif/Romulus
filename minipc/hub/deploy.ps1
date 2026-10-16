# Copies the Tasks app from this laptop to the hub mini PC and (re)starts its service.
# Run from the repo folder in PowerShell:   .\minipc\hub\deploy.ps1 -Hub james@tasks-hub
# (-Hub is the SSH login, over Tailscale.) Run it again after every change to the app.
param(
  [Parameter(Mandatory = $true)][string]$Hub
)
$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$items = @('main.js', 'preload.js', 'package.json', 'package-lock.json', 'oauth-clients.json', 'main', 'agent', 'renderer', 'assets')
foreach ($i in $items) { if (-not (Test-Path (Join-Path $repo $i))) { throw "missing $i" } }
$tgz = Join-Path $env:TEMP 'tasks-hub.tgz'
Write-Host "Packing the app..."
& tar.exe -czf $tgz -C $repo @items
if ($LASTEXITCODE -ne 0) { throw 'tar failed' }
Write-Host "Copying to $Hub..."
& scp.exe -q $tgz "${Hub}:/tmp/tasks-hub.tgz"
if ($LASTEXITCODE -ne 0) { throw 'scp failed (is Tailscale on? does ssh work?)' }
# unpack over the old copy (its node_modules stay), install, restart; the user data in ~/.config/Tasks is never touched
$remote = 'set -e; mkdir -p ~/tasks-app; tar -xzf /tmp/tasks-hub.tgz -C ~/tasks-app; rm -f /tmp/tasks-hub.tgz; ' +
  'chmod 600 ~/tasks-app/oauth-clients.json; cd ~/tasks-app; npm ci --no-audit --no-fund --loglevel=error; ' +
  'systemctl --user daemon-reload; systemctl --user enable tasks-hub >/dev/null 2>&1; systemctl --user restart tasks-hub; ' +
  'sleep 8; systemctl --user --no-pager status tasks-hub | head -5; ' +
  'test -s ~/.config/Tasks/hub-token.txt && echo "hub token: in ~/.config/Tasks/hub-token.txt" || echo "no hub token yet: see journalctl --user -u tasks-hub"'
& ssh.exe $Hub $remote
Remove-Item $tgz -ErrorAction SilentlyContinue
