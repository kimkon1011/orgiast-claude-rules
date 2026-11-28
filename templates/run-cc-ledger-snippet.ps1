# Snippet for run-cc.ps1 (claude -p wrapper): put it right after $code = $p.ExitCode.
# When the run ended with anything other than "done" (exit != 0, or STATUS says waiting/blocked/remaining),
# register it in the follow-up ledger on the spot. Idempotent: the same --id updates the existing row.
# Never fails the wrapper: ledger-open-item exits 0 unless --strict is given.
$statusText = ''
if (Test-Path -LiteralPath $statusPath) { $statusText = [System.IO.File]::ReadAllText($statusPath, $Utf8) }
$unfinished = ($code -ne 0) -or ($statusText -match 'UPDATE|BLOCKED|REMAINING') -or (-not (Test-Path -LiteralPath (Join-Path $here 'DONE.txt')))
if ($unfinished) {
  $repo = Join-Path $env:USERPROFILE '.claude\nightly-repo'
  $leaf = Split-Path -Leaf $here
  # ledger status "stopped" written as code points so this file stays ASCII-only (PowerShell 5.1 safe)
  $stopped = -join ([char]0x6B62, [char]0x307E, [char]0x3063, [char]0x305F)
  & node (Join-Path $repo 'tools\ledger-open-item.mjs') open --id ("GB-OPEN-" + $leaf) --task ("unfinished work: " + $leaf + " (see STATUS.txt / REPORT.md)") --owner-pc $env:COMPUTERNAME --status $stopped --reason ("exit=" + $code) --evidence-path $here 2>$null
}
