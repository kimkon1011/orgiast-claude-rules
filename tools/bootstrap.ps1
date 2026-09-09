# bootstrap.ps1 - Orgiast rule & tool setup (converging installer, ASCII only).
# Replaces install-orgiast.ps1 as the one-time entry. Idempotent: repairs to a
# converged state via tools/setup.mjs --converge. Run with Windows PowerShell 5.1:
#   powershell -NoProfile -ExecutionPolicy Bypass -File bootstrap.ps1
$ErrorActionPreference = 'Stop'
function Have($Name) { return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue) }
$Repo = Join-Path $HOME 'orgiast-claude-rules'
$Base = 'https://github.com/kimkon1011/orgiast-claude-rules'
if (-not (Have git)) { winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements | Out-Null }
if (-not (Have node)) { winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements | Out-Null; $env:Path += ';' + (Join-Path $env:ProgramFiles 'nodejs') }
if (-not (Have claude)) {
  try { winget install --id Anthropic.ClaudeCode -e --accept-source-agreements --accept-package-agreements | Out-Null } catch {}
  if (-not (Have claude)) {
    $ci = Join-Path $env:TEMP 'claude-install.ps1'
    Invoke-WebRequest -UseBasicParsing 'https://claude.ai/install.ps1' -OutFile $ci
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $ci | Out-Null
    $env:Path += ';' + (Join-Path $HOME '.local\bin')
  }
}
$env:Path = (@([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'), $env:Path) | Where-Object { $_ }) -join ';'
if (-not (Have codex)) {
  if (-not (Have npm)) { throw 'npm is required to install codex' }
  npm install -g @openai/codex --no-fund --no-audit | Out-Null
}
if (-not (Test-Path (Join-Path $Repo '.git'))) {
  git clone --depth 1 --quiet $Base $Repo
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $Repo 'tools'))) { throw 'repo clone failed' }
}
if (Have node) { & node (Join-Path $Repo 'tools\setup.mjs') --converge } else { throw 'node.js is required' }
Write-Host '[ORGIAST-BOOTSTRAP-COMPLETE]'
