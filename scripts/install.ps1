param(
  [string]$Profile = 'desktop'
)

$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $PSScriptRoot

if (-not (Test-Path -LiteralPath (Join-Path $src 'package.json'))) {
  throw "package.json not found in $src. Put this script in the plugin folder's scripts\ directory."
}

function Find-Dsh {
  $cmd = Get-Command dsh -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $base = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources'
  $candidates = @(
    (Join-Path $base 'runtime\cli\bin\dsh.cmd'),
    (Join-Path $base 'runtime\bin\dsh.cmd'),
    (Join-Path $base 'runtime\bin\dsh.exe'),
    (Join-Path $base 'runtime\bin\dsh')
  )
  foreach ($c in $candidates) {
    if (Test-Path -LiteralPath $c) { return $c }
  }
  return $null
}

$dsh = Find-Dsh
if (-not $dsh) {
  Write-Host 'dsh CLI not found. Install from the GUI instead:' -ForegroundColor Yellow
  Write-Host '  Settings -> Plugins -> Install local bundle -> choose this folder:'
  Write-Host "  $src"
  exit 2
}

Write-Host "Using dsh: $dsh"
Write-Host "Source: $src (profile: $Profile)"
& $dsh plugin --profile $Profile add $src
if ($LASTEXITCODE -ne 0) {
  throw "Install failed with exit code $LASTEXITCODE. You can also install the same folder from the GUI."
}

Write-Host ''
Write-Host 'Done. Reload the web UI (Ctrl+R). If nothing shows up, disable and re-enable the plugin in Settings -> Plugins, then Ctrl+R again.' -ForegroundColor Green
