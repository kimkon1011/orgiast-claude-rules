$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host '[NG ] node.js is required'
  exit 1
}
$script = Join-Path $PSScriptRoot 'setup.mjs'
& $node.Source $script --verify --human
exit $LASTEXITCODE
