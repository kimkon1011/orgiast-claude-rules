param([string]$OutDir, [string]$Label)
$ErrorActionPreference = 'Stop'
# PS7 由来の PSModulePath でも PS5.1 自身の基本モジュールを使うため絶対パスで読む。
foreach ($module in @('Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Management')) {
    Import-Module (Join-Path $PSHOME "Modules\$module\$module.psd1") -ErrorAction Stop
}
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$errors = New-Object 'System.Collections.Generic.List[string]'
function Read-Item([string]$Name, [scriptblock]$Action) {
    try { & $Action } catch {
        # 例外本文は秘密を含む対象行を引用し得るので型と分類だけを残す。
        $errors.Add(('{0}: {1} ({2})' -f $Name, $_.Exception.GetType().Name, $_.CategoryInfo.Category))
        return $null
    }
}
function Read-Array([string]$Name, [scriptblock]$Action) {
    try { return ,@(& $Action) } catch {
        $errors.Add(('{0}: {1} ({2})' -f $Name, $_.Exception.GetType().Name, $_.CategoryInfo.Category))
        return $null
    }
}
function Reg-Value($Key, $Name) { (Get-ItemProperty -LiteralPath $Key -Name $Name -ErrorAction Stop).$Name }
function Iso($Value) { if ($null -ne $Value) { ([datetime]$Value).ToUniversalTime().ToString('o') } else { $null } }
if (!$Label) { $Label = $env:COMPUTERNAME }
if (!$Label -or $Label -match '[\\/:*?"<>|\s]' -or $Label -in @('.', '..')) { throw 'Invalid label' }
if (!$OutDir) { $OutDir = Join-Path $env:USERPROFILE ('.claude\security-audit\' + (Get-Date -Format yyyyMMdd)) }
$a = [ordered]@{ host=$Label; user=$env:USERNAME; at=(Iso (Get-Date)); osVersion=$null; windowsEdition=$null; lastBootUpTime=$null; systemDrive=$env:SystemDrive }
$os = Read-Item 'osVersion/lastBootUpTime' { Get-CimInstance Win32_OperatingSystem -Property Version,LastBootUpTime,Caption }
if ($os) { $a.osVersion=$os.Version; $a.windowsEdition=$os.Caption; $a.lastBootUpTime=Iso $os.LastBootUpTime }
$processes = Read-Array 'processes' { Get-CimInstance Win32_Process -Property ProcessId,Name,CreationDate,ExecutablePath,CommandLine }
$procMap = @{}
$cmdMap = @{}
foreach ($p in $processes) {
    $procMap[[int]$p.ProcessId] = $p.Name
    $head = [string]$p.CommandLine -replace '(?is)\S*(?:token=|key=|password=|secret=).*$', '[redacted]'
    $cmdMap[[int]$p.ProcessId] = $head.Substring(0, [Math]::Min(120, $head.Length))
}
$tcp = Read-Array 'tcp' { Get-NetTCPConnection -State Listen }
$udp = Read-Array 'udp' { Get-NetUDPEndpoint }
$a.listenEphemeralOmitted = @{tcp=@($tcp | Where-Object { $_.LocalPort -ge 49152 -and $_.LocalAddress -in @('0.0.0.0','::','127.0.0.1','::1') }).Count; udp=@($udp | Where-Object { $_.LocalPort -ge 49152 -and $_.LocalAddress -in @('0.0.0.0','::') }).Count}
$a.listenAllTcp = if ($null -eq $tcp) { $null } else { ,@($tcp | Where-Object { $_.LocalPort -lt 49152 -and $_.LocalAddress -in @('0.0.0.0','::') } | ForEach-Object {
    @{port=[int]$_.LocalPort; proc=$procMap[[int]$_.OwningProcess]; cmdHead=$cmdMap[[int]$_.OwningProcess]; address=$_.LocalAddress}
}) }
$a.listenLoopbackTcp = if ($null -eq $tcp) { $null } else { ,@($tcp | Where-Object { $_.LocalPort -lt 49152 -and $_.LocalAddress -in @('127.0.0.1','::1') } | ForEach-Object { @{port=[int]$_.LocalPort; proc=$procMap[[int]$_.OwningProcess]} }) }
$a.listenAllUdp = if ($null -eq $udp) { $null } else { ,@($udp | Where-Object { $_.LocalPort -lt 49152 -and $_.LocalAddress -in @('0.0.0.0','::') } | ForEach-Object { @{port=[int]$_.LocalPort; proc=$procMap[[int]$_.OwningProcess]} }) }
$a.firewall = Read-Array 'firewall' { Get-NetFirewallProfile | ForEach-Object { @{profile=[string]$_.Name; enabled=([string]$_.Enabled -eq 'True'); defaultInbound=[string]$_.DefaultInboundAction} } }
$a.inboundAllowAnyPublic = Read-Array 'inboundAllowAnyPublic' {
    Get-NetFirewallRule -Direction Inbound -Action Allow -Enabled True | Where-Object { [string]$_.Profile -match 'Any|Public' } | ForEach-Object {
        $port = $_ | Get-NetFirewallPortFilter
        $app = $_ | Get-NetFirewallApplicationFilter
        @{name=$_.Name; profile=[string]$_.Profile; proto=[string]$port.Protocol; localPort=[string]($port.LocalPort -join ','); program=$app.Program}
    }
}
$a.rdpEnabled = Read-Item 'rdpEnabled' { (Reg-Value 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server' 'fDenyTSConnections') -eq 0 }
$a.rdpNla = Read-Item 'rdpNla' { [int](Reg-Value 'HKLM:\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp' 'UserAuthentication') }
$a.smb1Enabled = Read-Item 'smb1Enabled' { [bool](Get-SmbServerConfiguration).EnableSMB1Protocol }
$a.smb1Feature = Read-Item 'smb1Feature' { [string](Get-WindowsOptionalFeature -Online -FeatureName SMB1Protocol).State }
$a.smbShares = Read-Array 'smbShares' { Get-SmbShare | Where-Object { $_.Name -notin @('ADMIN$','C$','IPC$') } | ForEach-Object { $_.Name } }
$a.winrmStatus = Read-Item 'winrmStatus' { [string](Get-Service WinRM).Status }
$a.winrmListeners = Read-Item 'winrmListeners' { @(Get-ChildItem WSMan:\localhost\Listener).Count }
$a.sshdCapability = Read-Item 'sshdCapability' { [string](Get-WindowsCapability -Online -Name 'OpenSSH.Server*').State }
$a.sshdStatus = Read-Item 'sshdStatus' { $s = @(Get-Service | Where-Object { $_.Name -eq 'sshd' }); if ($s.Count) { [string]$s[0].Status } else { 'NotInstalled' } }
$a.remoteAssistance = Read-Item 'remoteAssistance' { Reg-Value 'HKLM:\SYSTEM\CurrentControlSet\Control\Remote Assistance' 'fAllowToGetHelp' }
$ts = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
$a.tailscale = [ordered]@{installed=(Test-Path -LiteralPath $ts); version=$null; runSSH=$null; shieldsUp=$null; funnelStatus=$null; serveStatus=$null; tags=$null; autoUpdate=$null; lockStatus=$null}
function Ts-Read([string[]]$Arguments) {
    $output = & $ts @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Tailscale query failed' }
    return ($output -join "`n")
}
if ($a.tailscale.installed) {
    $a.tailscale.version = Read-Item 'tailscale.version' { $v=Ts-Read @('version'); ($v -split "`n")[0] }
    $prefs = Read-Item 'tailscale.prefs' { Ts-Read @('debug','prefs') | ConvertFrom-Json | Select-Object RunSSH,ShieldsUp,AdvertiseTags,AutoUpdate }
    if ($prefs) {
        $a.tailscale.runSSH=$prefs.RunSSH
        $a.tailscale.shieldsUp=$prefs.ShieldsUp
        $a.tailscale.tags=$prefs.AdvertiseTags
        $a.tailscale.autoUpdate=$prefs.AutoUpdate
    }
    $a.tailscale.lockStatus = Read-Item 'tailscale.lockStatus' { ((Ts-Read @('lock','status')) -split "`n")[0].Trim() }
    foreach ($kind in @('funnel','serve')) {
        $a.tailscale[($kind+'Status')] = Read-Item ('tailscale.'+$kind+'Status') {
            $raw = Ts-Read @($kind,'status')
            # 公開URLのパスや転送先の認証情報は出さず、状態とローカルポートだけ残す。
            $ports = @([regex]::Matches($raw, '(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0):\d+') | ForEach-Object { $_.Value } | Select-Object -Unique)
            $state = if ($raw -match 'Funnel on') { 'Funnel on' } elseif ($raw -match 'No serve config') { 'No serve config' } else { 'Configured; Funnel off' }
            $state + ' ' + ($ports -join ',')
        }
    }
}
$a.defender = [ordered]@{realtime=$null; sigDate=$null; tamper=$null; exclusionsCount=$null}
$d = Read-Item 'defender.status' { Get-MpComputerStatus }
if ($d) { $a.defender.realtime=$d.RealTimeProtectionEnabled; $a.defender.sigDate=Iso $d.AntivirusSignatureLastUpdated; $a.defender.tamper=$d.IsTamperProtected }
$a.defender.exclusionsCount = Read-Item 'defender.exclusionsCount' { $p=Get-MpPreference; @(@($p.ExclusionPath)+@($p.ExclusionProcess)+@($p.ExclusionExtension)+@($p.ExclusionIpAddress) | Where-Object { $null -ne $_ }).Count }
$a.bitlocker = Read-Array 'bitlocker' {
    # Get-BitLockerVolume の KeyProtector を取得せず、状態照会だけで回復キーの読み取りを避ける。
    $cimResult = try {
        $vols = Get-CimInstance -Namespace 'root/CIMV2/Security/MicrosoftVolumeEncryption' -ClassName Win32_EncryptableVolume -Property DriveLetter -ErrorAction Stop
        if ($null -ne $vols -and @($vols).Count -gt 0) {
            $states = @('FullyDecrypted','FullyEncrypted','EncryptionInProgress','DecryptionInProgress','EncryptionPaused','DecryptionPaused')
            @($vols | ForEach-Object {
                $protection = Invoke-CimMethod -InputObject $_ -MethodName GetProtectionStatus -ErrorAction Stop
                $conversion = Invoke-CimMethod -InputObject $_ -MethodName GetConversionStatus -ErrorAction Stop
                if ($protection.ReturnValue -ne 0 -or $conversion.ReturnValue -ne 0) { throw 'BitLocker status unavailable' }
                @{
                    mount = $_.DriveLetter
                    protection = (@('Off','On','Unknown')[[int]$protection.ProtectionStatus])
                    status = $states[[int]$conversion.ConversionStatus]
                    shellValue = $null
                    source = 'cim'
                }
            })
        } else { $null }
    } catch { $null }

    if ($null -ne $cimResult -and $cimResult.Count -gt 0) { return $cimResult }

    try {
        $shellApp = New-Object -ComObject Shell.Application
        $drives = @(try { Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" -Property DeviceID -ErrorAction Stop | Select-Object -ExpandProperty DeviceID } catch {})
        if ($drives.Count -eq 0) { $drives = @($env:SystemDrive) }
        if ($drives -notcontains $env:SystemDrive) { $drives = @($env:SystemDrive) + $drives }

        $shellResult = foreach ($drive in $drives) {
            $folder = $shellApp.NameSpace($drive)
            $val = if ($folder) { $folder.Self.ExtendedProperty('System.Volume.BitLockerProtection') } else { $null }
            $shellVal = if ($null -ne $val) { [int]$val } else { $null }
            $prot = 'Unknown'
            $stat = $null
            switch ($shellVal) {
                1 { $prot = 'On' }
                2 { $prot = 'Off' }
                3 { $prot = 'On'; $stat = 'EncryptionInProgress' }
                4 { $prot = 'Off'; $stat = 'DecryptionInProgress' }
                5 { $prot = 'Suspended' }
                6 { $prot = 'On' }
                default { $prot = 'Unknown' }
            }
            @{
                mount = $drive
                protection = $prot
                status = $stat
                shellValue = $shellVal
                source = 'shell'
            }
        }
        return $shellResult
    } catch {
        throw 'BitLocker status unavailable via CIM and Shell'
    }
}
$a.bitlockerEvent829 = Read-Item 'bitlockerEvent829' {
    try {
        $startTime = (Get-Date).AddDays(-90)
        $events = Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-BitLocker/BitLocker Management'; Id=829; StartTime=$startTime} -ErrorAction Stop
        $count = @($events).Count
        $last = if ($count -gt 0) { Iso ($events | Sort-Object TimeCreated -Descending | Select-Object -First 1).TimeCreated } else { $null }
        @{count=$count; lastAt=$last}
    } catch {
        if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') {
            @{count=0; lastAt=$null}
        } else { throw }
    }
}
$a.recoveryKeyBackupFiles = Read-Array 'recoveryKeyBackupFiles' {
    $targetDirs = New-Object 'System.Collections.Generic.List[string]'
    $docPath = Join-Path $env:USERPROFILE 'Documents'
    if (Test-Path -LiteralPath $docPath) { $targetDirs.Add($docPath) }
    Get-ChildItem -LiteralPath $env:USERPROFILE -Directory -ErrorAction Stop | Where-Object { $_.Name -like 'OneDrive*' } | ForEach-Object {
        foreach ($sub in @('Documents', 'ドキュメント')) {
            $p = Join-Path $_.FullName $sub
            if (Test-Path -LiteralPath $p) { $targetDirs.Add($p) }
        }
    }
    $results = New-Object 'System.Collections.Generic.List[string]'
    $baseLen = $env:USERPROFILE.TrimEnd('\').Length + 1
    foreach ($dir in ($targetDirs | Select-Object -Unique)) {
        # メタデータのみ。控えファイルを開かず、直下だけを列挙する。
        Get-ChildItem -LiteralPath $dir -File -ErrorAction Stop | Where-Object {
            ($_.Extension -eq '.txt' -or $_.Extension -eq '.pdf') -and
            ($_.Name -like '*回復キー*' -or $_.Name -like '*BitLocker Recovery Key*')
        } | ForEach-Object {
            if ($_.FullName.Length -gt $baseLen) {
                $results.Add($_.FullName.Substring($baseLen))
            }
        }
    }
    $results.ToArray()
}
$a.lastHotfixDate = Read-Item 'lastHotfixDate' { $h=Get-HotFix | Where-Object InstalledOn | Sort-Object InstalledOn -Descending | Select-Object -First 1; Iso $h.InstalledOn }
$a.uacEnableLUA = Read-Item 'uacEnableLUA' { Reg-Value 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' 'EnableLUA' }
$a.uacConsentAdmin = Read-Item 'uacConsentAdmin' { Reg-Value 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' 'ConsentPromptBehaviorAdmin' }
$a.admins = Read-Array 'admins' { Get-LocalGroupMember -SID 'S-1-5-32-544' | ForEach-Object { $_.Name } }
$a.enabledLocalUsers = Read-Array 'enabledLocalUsers' { Get-LocalUser | Where-Object Enabled | ForEach-Object { $_.Name } }
$a.secrets = [ordered]@{claudeKeyTxtCount=$null; claudeKeyTxtNames=$null; envFileCount=$null; envFileDirs=$null; hardcodedCredFiles=@(); scanTruncated=$false; scanIncomplete=$false}
# 鍵と .env の中身は開かずメタデータだけ数える。再解析ポイントは範囲外への走査を防ぐため追わない。
$files = New-Object 'System.Collections.Generic.List[object]'
$scanOk = $true
function Walk-Metadata([string]$Dir) {
    try {
        foreach ($f in Get-ChildItem -LiteralPath $Dir -Force) {
            if ($a.secrets.scanTruncated) { return }
            if ($f.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
            if ($f.PSIsContainer) { if ($f.Name -notin @('node_modules','.git','.wt','dist','.next','worktrees','security-audit')) { Walk-Metadata $f.FullName } }
            else { if ($files.Count -ge 20000) { $a.secrets.scanTruncated=$true; return }; $files.Add($f) }
        }
    } catch { $script:scanOk=$false; $errors.Add('secrets.scan: directory unavailable (partial metadata omitted)') }
}
foreach ($root in @('Downloads','.claude')) {
    $dir=Join-Path $env:USERPROFILE $root
    if (Test-Path -LiteralPath $dir) { Walk-Metadata $dir }
}
if ($scanOk) {
    $keys=@($files | Where-Object { $_.Extension -eq '.txt' -and $_.Name -match '(?i)key' -and $_.FullName.StartsWith((Join-Path $env:USERPROFILE '.claude'), [StringComparison]::OrdinalIgnoreCase) })
    $envs=@($files | Where-Object { $_.Name -eq '.env' -or $_.Name.StartsWith('.env.') })
    $a.secrets.claudeKeyTxtCount=$keys.Count
    $a.secrets.claudeKeyTxtNames=@($keys | ForEach-Object { $_.Name })
    $a.secrets.envFileCount=$envs.Count
    $a.secrets.envFileDirs=@($envs | ForEach-Object { $_.Directory.Name } | Select-Object -Unique -First 30)
}
# 一致行はフィルターにだけ使い、出力にはパスと行番号しか残さない。
$credentialPattern = @'
PRONI_(ID|PW|PASS)\s*=\s*['"]|YAHOO_(ID|PW|PASS)\s*=\s*['"]|NOTE_(ID|PW|PASS)\s*=\s*['"]|SUBLINE_(ID|PW|PASS)\s*=\s*['"]|LOGIN_(PW|ID)\s*=\s*['"][^'"]{3,}|password\s*[:=]\s*['"][^'"]{6,}['"]
'@
$excludedLine = 'process.env|\$env:|getenv|PropertiesService|example|placeholder|YOUR_|\.test\.|describe\('
# 除外条件を同じ正規表現へ含め、先頭の除外行で後続の一致を見落とさない。
$scanPattern = '^(?!.*(?:' + $excludedLine + ')).*(?:' + $credentialPattern.Trim() + ')'
$a.secrets.hardcodedCredFiles = @(
    foreach ($f in $files) {
        if ($f.Extension -notin @('.mjs','.js','.cjs','.ts','.ps1','.py','.gs')) { continue }
        if ($f.FullName -match 'node_modules|\.git|\.wt|worktrees|dist|\.next') { continue }
        try {
            foreach ($match in (Select-String -LiteralPath $f.FullName -Pattern $scanPattern -List)) {
                $relative = $f.FullName.Substring($env:USERPROFILE.TrimEnd('\').Length + 1)
                '{0}:{1}' -f $relative, $match.LineNumber
            }
        } catch { $scanOk=$false; $errors.Add('secrets.scan: file unavailable') }
    }
)
$a.secrets.scanIncomplete = !$scanOk
$a.autostart = [ordered]@{startupCount=$null; taskCount=$null; nonWindowsServices=$null}
$a.autostart.startupCount = Read-Item 'autostart.startupCount' { @(Get-CimInstance Win32_StartupCommand -Property Name).Count }
$a.autostart.taskCount = Read-Item 'autostart.taskCount' { @(Get-ScheduledTask).Count }
$a.autostart.nonWindowsServices = Read-Array 'autostart.nonWindowsServices' {
    # サービスの PathName は認証引数を含み得るため、実行中 PID の実行ファイルパスで比較する。
    foreach ($service in (Get-CimInstance Win32_Service -Property Name,State,ProcessId | Where-Object State -EQ 'Running')) {
        $process = $processes | Where-Object ProcessId -EQ $service.ProcessId | Select-Object -First 1
        if (!$process.ExecutablePath) { throw 'Service executable path unavailable' }
        if ($process.ExecutablePath -notmatch '^C:\\Windows\\') { $service.Name }
    }

}
$a.stuckJobs = [ordered]@{claudeProcessCount=$null; nodeProcessCount=$null; pwshProcessCount=$null; oldestNodeHours=$null; cpuLoadPercent=$null}
if ($null -ne $processes) {
    $a.stuckJobs.claudeProcessCount=@($processes | Where-Object Name -Match '^claude(\.exe)?$').Count
    $nodes=@($processes | Where-Object Name -Match '^node(\.exe)?$')
    $a.stuckJobs.nodeProcessCount=$nodes.Count
    $a.stuckJobs.pwshProcessCount=@($processes | Where-Object Name -Match '^(pwsh|powershell)(\.exe)?$').Count
    $a.stuckJobs.oldestNodeHours = Read-Item 'stuckJobs.oldestNodeHours' { if (!$nodes.Count) { 0 } else { $old=$nodes | Sort-Object CreationDate | Select-Object -First 1; [math]::Round(((Get-Date)-[datetime]$old.CreationDate).TotalHours,2) } }
}
$a.stuckJobs.cpuLoadPercent = Read-Item 'stuckJobs.cpuLoadPercent' { (Get-CimInstance Win32_Processor -Property LoadPercentage | Measure-Object LoadPercentage -Average).Average }
$a.errors=@($errors.ToArray())
$a.schemaVersion=1
$json=ConvertTo-Json -InputObject $a -Depth 10
# 点検結果の保存だけが書き込みで、端末の設定・対象ファイルは変更しない。
[IO.Directory]::CreateDirectory($OutDir) | Out-Null
[IO.File]::WriteAllText((Join-Path $OutDir ($Label+'.json')), $json, (New-Object System.Text.UTF8Encoding($false)))
[Console]::WriteLine($json)
