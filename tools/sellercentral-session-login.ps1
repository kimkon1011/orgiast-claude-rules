$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath 'C:\Users\user\.claude\nightly-repo'
node tools/sellercentral-session.mjs login
exit $LASTEXITCODE
