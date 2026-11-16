param(
    [Parameter(Mandatory = $true)][string]$PollScript,
    [Parameter(Mandatory = $true)][string]$NodeExe,
    [Parameter(Mandatory = $true)][int]$CallerPid,
    [Parameter(Mandatory = $true)][long]$MaxAgeMs,
    [Parameter(Mandatory = $true)][string]$LogFile
)
$ErrorActionPreference = 'Stop'
if ($MaxAgeMs -lt 17 * 60 * 1000) { throw 'unsafe poll age' }
if (-not [IO.Path]::IsPathRooted($PollScript) -or $PollScript -notmatch '\\nightly-repo\\tools\\fleet-mail\.mjs$') { throw 'unsafe poll path' }
if (-not [IO.Path]::IsPathRooted($NodeExe) -or [IO.Path]::GetFileName($NodeExe) -ine 'node.exe') { throw 'unsafe node path' }
function Exact-Argument([string]$Value) {
    $escaped = [regex]::Escape($Value)
    if ($Value -match '\s') { return '"' + $escaped + '"' }
    return '(?:"' + $escaped + '"|' + $escaped + ')'
}
# Anchored full command line, with no flags before/after --poll, no relative
# paths, and no other repository. Whitespace/quotes are the only variations.
$commandPattern = '\A' + (Exact-Argument $NodeExe) + '[ \t]+' + (Exact-Argument $PollScript) + '[ \t]+--poll[ \t]*\z'
function Is-Eligible($Candidate) {
    if ($null -eq $Candidate -or $Candidate.ProcessId -le 0 -or $Candidate.ProcessId -eq $CallerPid -or $Candidate.ProcessId -eq $PID) { return $false }
    if ($Candidate.ExecutablePath -ine $NodeExe -or $Candidate.CommandLine -notmatch $commandPattern) { return $false }
    if ($null -eq $Candidate.CreationDate) { return $false }
    return ([DateTime]::UtcNow - $Candidate.CreationDate.ToUniversalTime()).TotalMilliseconds -gt $MaxAgeMs
}
$stopped = 0
foreach ($candidate in @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'")) {
    if (-not (Is-Eligible $candidate)) { continue }
    $process = $null
    try {
        $fresh = Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$candidate.ProcessId)
        if (-not (Is-Eligible $fresh) -or $fresh.CreationDate -ne $candidate.CreationDate) { continue }
        $process = Get-Process -Id $fresh.ProcessId -ErrorAction Stop
        # Cache an OS handle before comparing identity; Kill uses this handle,
        # so a reused PID cannot redirect termination to a new process.
        $null = $process.Handle
        if ([Math]::Abs(($process.StartTime.ToUniversalTime() - $fresh.CreationDate.ToUniversalTime()).TotalMilliseconds) -ge 1) { continue }
        $startedAt = $process.StartTime.ToUniversalTime().ToString('o')
        $process.Kill()
        if (-not $process.WaitForExit(1000)) { continue }
        $stopped++
        $line = [DateTime]::UtcNow.ToString('o') + ' fleet-mail: stale-poll-reaped pid=' + $fresh.ProcessId + ' startedAt=' + $startedAt
        # run-hidden redirects output to this file while poll is running.
        # AppendAllText denies an existing writer; allow shared append instead.
        $stream = [IO.File]::Open($LogFile, [IO.FileMode]::Append, [IO.FileAccess]::Write, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
        try {
            $bytes = [Text.UTF8Encoding]::new($false).GetBytes($line + [Environment]::NewLine)
            $stream.Write($bytes, 0, $bytes.Length)
        } finally { $stream.Dispose() }
    } catch {
        # No broad fallback kill. A race or inaccessible process is left alone.
        [Console]::Error.WriteLine('fleet-mail: stale poll candidate recovery failed=1')
    } finally {
        if ($null -ne $process) { $process.Dispose() }
    }
}
Write-Output $stopped
