# PowerShell 5.1 integration tests. All network and Node commands are mocked.
param([string]$ScratchRoot = $env:TEMP)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$global:enrollTest_passed = 0
$global:enrollTest_failed = 0
function Assert($condition, $message) { if (-not $condition) { throw $message } }
function global:node {
  $file = [IO.Path]::GetFileName([string]$args[0])
  $global:LASTEXITCODE = 0
  if ($file -eq 'keyserve-status.mjs') {
    $global:enrollTest_statusCalls++
    Assert ($env:ORGIAST_HOME -eq $global:enrollTest_testHome) 'status must use isolated home'
    Assert (-not $env:ORGIAST_KEYSERVE_SECRET) 'inherited secret must not mask file authentication'
    if ($global:enrollTest_scenario -eq 'existing-primary' -or ($global:enrollTest_scenario -in @('success', 'notify-failure', 'stale-primary') -and $global:enrollTest_statusCalls -gt 1)) {
      '{"auth":"primary","status":200,"success":true}'
    } elseif ($global:enrollTest_scenario -eq 'stale-primary' -and $global:enrollTest_statusCalls -eq 1) {
      '{"auth":"primary","status":401,"success":false}'
    } else { '{"auth":"未設定","status":null,"success":false}' }
  } elseif ($file -eq 'onboarding-sync.mjs') {
    Assert ($args -contains '--force') 'sync must be forced'
    Assert ($args -contains '--keys-only') 'recovery must use the actual key sync'
    $tokenFile = Join-Path $env:ORGIAST_HOME '.claude\enroll.env'
    $acl = Get-Acl -LiteralPath $tokenFile
    Assert $acl.AreAccessRulesProtected 'ACL inheritance must be disabled'
    $aces = @($acl.Access)
    Assert ($aces.Count -eq 1) 'only current user must have an ACE'
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    Assert ($aces[0].IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $sid.Value) 'wrong ACL principal'
    $bytes = [IO.File]::ReadAllBytes($tokenFile)
    Assert ($bytes[0] -eq 79) 'env file must not have a BOM'
    Assert ([IO.File]::ReadAllText($tokenFile) -eq "ORGIAST_ENROLL_TOKEN=opaque-test-token`n") 'token must be stored unchanged'
    if ($global:enrollTest_scenario -eq 'stale-primary') {
      Assert (-not (Test-Path (Join-Path $env:ORGIAST_HOME '.claude\keyserve.env'))) 'rejected primary must be quarantined'
      Assert (@(Get-ChildItem (Join-Path $env:ORGIAST_HOME '.claude') -Filter 'keyserve.env.pre-enroll-*').Count -eq 1) 'rejected primary backup missing'
    }
    $global:enrollTest_syncChecked = $true
    $kind = 'ok'; $status = 200
    switch ($global:enrollTest_scenario) {
      'expired' { $kind = 'expired'; $status = 401 }
      'unauthorized' { $kind = 'http'; $status = 401 }
      'network' { $kind = 'network'; $status = $null }
      'write' { $kind = 'write' }
    }
    if ($global:enrollTest_scenario -in @('success', 'notify-failure', 'stale-primary')) {
      [IO.File]::WriteAllText((Join-Path $env:ORGIAST_HOME '.claude\keyserve.env'), 'ORGIAST_KEYSERVE_SECRET=primary-test')
      Remove-Item -LiteralPath $tokenFile -Force
    }
    if ($global:enrollTest_scenario -ne 'existing-primary') {
      @{ authVia = 'enroll'; status = $status; kind = $kind } | ConvertTo-Json -Compress | Set-Content (Join-Path $env:ORGIAST_HOME '.claude\.enroll-result.json') -Encoding UTF8
    }
  } elseif ($file -eq 'notify-kim.mjs') {
    $global:enrollTest_reported = $true
    Assert (-not (($args -join ' ').Contains('opaque-test-token'))) 'report leaked token'
    Assert (($args -join ' ') -match 'PC=.*authVia=.*HTTP=') 'report fields missing'
    if ($global:enrollTest_scenario -eq 'notify-failure') { throw 'simulated notification failure' }
  } else { throw 'unexpected node invocation' }
}
$previousHome = $env:ORGIAST_HOME
$previousSecret = $env:ORGIAST_KEYSERVE_SECRET
try {
  foreach ($scenarioName in @('success', 'existing-primary', 'stale-primary', 'expired', 'unauthorized', 'network', 'write', 'notify-failure')) {
    $global:enrollTest_scenario = $scenarioName
    $global:enrollTest_statusCalls = 0; $global:enrollTest_syncChecked = $false; $global:enrollTest_reported = $false
    $global:enrollTest_testHome = Join-Path $ScratchRoot ('enroll-mock-' + [guid]::NewGuid().ToString('N'))
    $env:ORGIAST_HOME = $global:enrollTest_testHome
    $env:ORGIAST_KEYSERVE_SECRET = 'must-be-restored'
    New-Item -ItemType Directory -Path (Join-Path $global:enrollTest_testHome '.claude') -Force | Out-Null
    if ($scenarioName -in @('existing-primary', 'stale-primary')) {
      [IO.File]::WriteAllText((Join-Path $global:enrollTest_testHome '.claude\keyserve.env'), 'ORGIAST_KEYSERVE_SECRET=old-primary')
    }
    try {
      $output = & (Join-Path $PSScriptRoot 'install-orgiast.ps1') -Enroll 'opaque-test-token' -EnrollOnly -Yes -NonInteractive -NoReboot 6>&1 | Out-String
      $code = $LASTEXITCODE
      $expectSuccess = $scenarioName -in @('success', 'existing-primary', 'stale-primary', 'notify-failure')
      Assert ($code -eq $(if ($expectSuccess) { 0 } else { 1 })) "unexpected exit: $code / $output"
      Assert $global:enrollTest_syncChecked 'sync not reached or ACL assertions failed'
      Assert $global:enrollTest_reported 'result not reported'
      Assert ($env:ORGIAST_HOME -eq $global:enrollTest_testHome) 'home env not restored'
      Assert ($env:ORGIAST_KEYSERVE_SECRET -eq 'must-be-restored') 'primary env not restored'
      Assert (-not $output.Contains('opaque-test-token')) 'output leaked token'
      Assert ((Test-Path (Join-Path $global:enrollTest_testHome '.claude\enroll.env')) -eq (-not $expectSuccess)) 'token retention incorrect'
      switch ($scenarioName) {
        'expired' { Assert ($output -match 'トークン期限切れ') 'missing expiry diagnosis' }
        'unauthorized' { Assert ($output -match 'HTTP 401') 'missing 401 diagnosis' }
        'network' { Assert ($output -match 'ネットワーク') 'missing network diagnosis' }
        'write' { Assert ($output -match '保存できません') 'missing write diagnosis' }
      }
      $global:enrollTest_passed++
      Write-Host "PASS $scenarioName"
    } catch { $global:enrollTest_failed++; Write-Host "FAIL $scenarioName : $($_.Exception.Message)" }
    finally { Remove-Item -LiteralPath $global:enrollTest_testHome -Recurse -Force -ErrorAction SilentlyContinue }
  }
} finally {
  $env:ORGIAST_HOME = $previousHome
  $env:ORGIAST_KEYSERVE_SECRET = $previousSecret
  Remove-Item Function:\node
}
Write-Host "$global:enrollTest_passed passed / $global:enrollTest_failed failed"
if ($global:enrollTest_failed) { exit 1 }
