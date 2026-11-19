function Get-SecretaryServer {
  param([string]$ServerDir,[int]$Port)

  $next = Join-Path $ServerDir 'node_modules\next\dist\bin\next'
  $worker = Join-Path $ServerDir 'node_modules\next\dist\server\lib\start-server.js'
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  $nextProcesses = @{}
  $workers = @()
  $servers = [ordered]@{}

  foreach ($process in (Get-CimInstance Win32_Process -Filter "Name='node.exe'")) {
    if ($process.ProcessId -le 0 -or !$process.CommandLine) { continue }
    $command = $process.CommandLine.Trim()
    $tokens = [regex]::Matches($command, '\G\s*("[^"]*"|[^\s"]+)(?=\s|$)')
    if ($tokens.Count -lt 2 -or $tokens[$tokens.Count - 1].Index + $tokens[$tokens.Count - 1].Length -ne $command.Length) { continue }

    $processId = [string]$process.ProcessId
    $script = $tokens[1].Groups[1].Value.Trim('"')
    if ($script -ieq $worker) {
      $workers += $process
    } elseif ($script -ieq $next) {
      $nextProcesses[$processId] = $process
      for ($i = 2; $i -lt $tokens.Count - 1; $i++) {
        if ($tokens[$i].Groups[1].Value.Trim('"') -ceq '-p' -and $tokens[$i + 1].Groups[1].Value.Trim('"') -ceq "$Port") {
          $servers[$processId] = $process
          break
        }
      }
    }
  }

  $configuredParents = @($servers.Keys)
  foreach ($process in $workers) {
    $parentId = [string]$process.ParentProcessId
    $parent = $nextProcesses[$parentId]
    # A reused parent PID can point to a process created after the worker.
    if (!$parent -or !$parent.CreationDate -or !$process.CreationDate -or $parent.CreationDate -gt $process.CreationDate) { continue }
    if ($parentId -notin $configuredParents -and $process.ProcessId -notin $listeners.OwningProcess) { continue }
    $servers[$parentId] = $parent
    $servers[[string]$process.ProcessId] = $process
  }

  foreach ($listener in $listeners) {
    if ($listener.OwningProcess -eq 0 -or !$servers.Contains([string]$listener.OwningProcess)) {
      throw "Port $Port is owned by an unexpected process; refused to terminate it"
    }
  }
  return [pscustomobject]@{ Processes = @($servers.Values); Listening = ($listeners.Count -gt 0) }
}
