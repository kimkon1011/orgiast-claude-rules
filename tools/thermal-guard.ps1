# 熱監視ツール thermal-guard.ps1
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

# ===== 定数定義 =====
$DataDir = Join-Path $env:USERPROFILE ".claude\thermal-guard"
$SamplesCsv = Join-Path $DataDir "samples.csv"
$StateJson = Join-Path $DataDir "state.json"
$MinRepostMinutes = 60
$WarnClockPct = 85
$WarnLoadPct = 50
$CritClockPct = 70
$CritTempC = 90
$WarnTempC = 80
$MaxPostFailures = 3
$SampleRetentionDays = 30

# ===== 設定読み込み =====
function Read-Config {
    $config = @{
        Webhook = $null
        Label = $env:COMPUTERNAME
    }
    $envFile = Join-Path $env:USERPROFILE ".claude\cost-reporter.env"
    if (Test-Path $envFile) {
        try {
            $lines = Get-Content -Path $envFile -Encoding UTF8
            foreach ($line in $lines) {
                if ([string]::IsNullOrWhiteSpace($line)) { continue }
                if ($line.StartsWith('#') -or $line.StartsWith([char]0xFEFF + '#')) { continue }
                $cleanLine = $line.TrimStart([char]0xFEFF).Trim()
                if ($cleanLine -match '^DISCORD_COST_WEBHOOK=(.+)$') {
                    $config.Webhook = $Matches[1].Trim()
                } elseif ($cleanLine -match '^COST_WEBHOOK=(.+)$') {
                    $config.Webhook = $Matches[1].Trim()
                } elseif ($cleanLine -match '^REPORTER_LABEL=(.+)$') {
                    $config.Label = $Matches[1].Trim()
                }
            }
        } catch {
            # 設定読み込み失敗は無視（webhook未設定扱い）
        }
    }
    return $config
}

# ===== 状態ファイル操作 =====
function Read-State {
    $default = @{
        level = "OK"
        since = ""
        lastPostAt = ""
        lastPostDate = ""
        postFailures = 0
        warnCounter = 0
        critCounter = 0
    }
    if (Test-Path $StateJson) {
        try {
            $state = Get-Content -Path $StateJson -Raw -Encoding UTF8 | ConvertFrom-Json
            $result = @{}
            foreach ($prop in $state.PSObject.Properties) {
                $val = $prop.Value
                if ($prop.Name -in @('postFailures', 'warnCounter', 'critCounter')) {
                    $val = [int]$val
                }
                $result[$prop.Name] = $val
            }
            foreach ($key in $default.Keys) {
                if (-not $result.ContainsKey($key)) {
                    $result[$key] = $default[$key]
                }
            }
            return $result
        } catch {
            return $default
        }
    }
    return $default
}

function Write-State {
    param($State)
    try {
        $State | ConvertTo-Json -Compress | Out-File -FilePath $StateJson -Encoding utf8
    } catch {
        # 状態書き込み失敗は無視
    }
}

# ===== データ収集 =====
function Get-Temperature {
    $temp = $null
    # MSAcpi 経由
    try {
        $tempObj = Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction Stop
        if ($null -ne $tempObj) {
            $maxTemp = $null
            foreach ($zone in $tempObj) {
                if ($null -ne $zone.CurrentTemperature) {
                    $zoneTemp = ($zone.CurrentTemperature / 10) - 273.15
                    $zoneTemp = [math]::Round($zoneTemp, 1)
                    if ($zoneTemp -gt -50 -and $zoneTemp -lt 150) {
                        if ($null -eq $maxTemp -or $zoneTemp -gt $maxTemp) {
                            $maxTemp = $zoneTemp
                        }
                    }
                }
            }
            if ($null -ne $maxTemp) {
                return $maxTemp
            }
        }
    } catch {
        # 取得不可
    }
    # Win32_TemperatureProbe 経由
    try {
        $probes = Get-CimInstance -ClassName Win32_TemperatureProbe -ErrorAction Stop
        foreach ($probe in $probes) {
            if ($null -ne $probe.CurrentReading -and $probe.CurrentReading -gt 0) {
                $temp = [math]::Round(($probe.CurrentReading / 10), 1)
                return $temp
            }
        }
    } catch {
        # 取得不可
    }
    return $null
}

function Get-CpuMetrics {
    $clockPct = $null
    $loadPct = 0
    try {
        $procs = Get-CimInstance -ClassName Win32_Processor
        $clockValues = @()
        $loadValues = @()
        foreach ($proc in $procs) {
            $current = $proc.CurrentClockSpeed
            $max = $proc.MaxClockSpeed
            if ($current -gt 0 -and $max -gt 0) {
                $clockValues += [math]::Round(($current / $max) * 100, 1)
            }
            if ($null -ne $proc.LoadPercentage) {
                $loadValues += $proc.LoadPercentage
            }
        }
        if ($clockValues.Count -gt 0) {
            $clockPct = ($clockValues | Measure-Object -Minimum).Minimum
        }
        if ($loadValues.Count -gt 0) {
            $loadPct = ($loadValues | Measure-Object -Maximum).Maximum
        }
    } catch {
        # 取得失敗時は null/0 のまま
    }
    return @{ ClockPct = $clockPct; LoadPct = $loadPct }
}

function Get-UptimeHours {
    try {
        $os = Get-CimInstance -ClassName Win32_OperatingSystem
        $uptime = (Get-Date) - $os.LastBootUpTime
        return [math]::Round($uptime.TotalHours, 1)
    } catch {
        return 9999
    }
}

function Get-KernelPower41Count {
    try {
        $startTime = (Get-Date).AddHours(-24)
        $events = Get-WinEvent -FilterHashtable @{LogName='System';Id=41;StartTime=$startTime} -ErrorAction Stop
        return $events.Count
    } catch {
        return 0
    }
}

# ===== CSV操作 =====
function Add-Sample {
    param($Record)
    try {
        if (-not (Test-Path $DataDir)) {
            New-Item -Path $DataDir -ItemType Directory -Force | Out-Null
        }
        $exists = Test-Path $SamplesCsv
        $line = "{0},{1},{2},{3},{4},{5},{6},{7}" -f `
            $Record.timestamp, $Record.label, $Record.hostname, `
            $Record.clockPct, $Record.loadPct, $Record.tempC, `
            $Record.uptimeHours, $Record.kernelPower41
        if (-not $exists) {
            "timestamp,label,hostname,clockPct,loadPct,tempC,uptimeHours,kernelPower41_24h" | Out-File -FilePath $SamplesCsv -Encoding utf8 -Append
        }
        $line | Out-File -FilePath $SamplesCsv -Encoding utf8 -Append
    } catch {
        # CSV書き込み失敗は無視
    }
}

function Clean-OldSamples {
    try {
        if (-not (Test-Path $SamplesCsv)) { return }
        $threshold = (Get-Date).AddDays(-$SampleRetentionDays).ToString("yyyy-MM-ddTHH:mm:ss")
        $lines = Get-Content -Path $SamplesCsv -Encoding UTF8
        $header = $lines[0]
        $newLines = @($header)
        for ($i = 1; $i -lt $lines.Count; $i++) {
            $line = $lines[$i]
            if ([string]::IsNullOrWhiteSpace($line)) { continue }
            $ts = ($line -split ',')[0]
            if ($ts.CompareTo($threshold) -ge 0) {
                $newLines += $line
            }
        }
        $newLines | Out-File -FilePath $SamplesCsv -Encoding utf8
    } catch {
        # クリーニング失敗は無視
    }
}

# ===== 通知 =====
function Send-Discord {
    param($Message)
    if ($Dry) {
        Write-Host "[DRY] $Message"
        return $true
    }
    $config = Read-Config
    if ([string]::IsNullOrEmpty($config.Webhook)) { return $false }
    try {
        $payload = @{ content = $Message } | ConvertTo-Json -Compress
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
        Invoke-RestMethod -Uri $config.Webhook -Method Post -ContentType 'application/json; charset=utf-8' -Body $bytes | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Should-Post {
    param($State, $NewLevel)
    if ($null -eq $State) { return $true }
    if ($State.level -ne $NewLevel) { return $true }
    $now = Get-Date
    $lastPost = $null
    if (-not [string]::IsNullOrEmpty($State.lastPostAt)) {
        $lastPost = [DateTime]::Parse($State.lastPostAt)
    }
    if ($null -eq $lastPost) { return $true }
    $diff = $now - $lastPost
    if ($diff.TotalMinutes -ge $MinRepostMinutes) { return $true }
    return $false
}

function Update-PostState {
    param($State, $Success, $NewLevel)
    if ($Success) {
        $State.postFailures = 0
        $State.lastPostAt = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss")
        $State.lastPostDate = (Get-Date).ToString("yyyy-MM-dd")
        $State.level = $NewLevel
    } else {
        $State.postFailures = $State.postFailures + 1
        $today = (Get-Date).ToString("yyyy-MM-dd")
        if ($null -ne $State.lastPostDate -and $State.lastPostDate -eq $today -and $State.postFailures -ge $MaxPostFailures) {
            # 今日は送信を止める（レベルは変えない）
        } else {
            $State.level = $NewLevel
        }
    }
    return $State
}

function Format-HostLine {
    return "🖥 hostname=$env:COMPUTERNAME"
}

# ===== 判定ロジック =====
function Get-Level {
    param($Metrics)
    $state = Read-State
    $cLevel = "OK"
    $warnHits = 0
    $critHits = 0
    $reason = ""
    
    if ($null -ne $Metrics.ClockPct -and $null -ne $Metrics.LoadPct) {
        if ($Metrics.ClockPct -lt $CritClockPct -and $Metrics.LoadPct -ge $WarnLoadPct) {
            $critHits = 1
            $reason = "clock"
        } elseif ($Metrics.ClockPct -lt $WarnClockPct -and $Metrics.LoadPct -ge $WarnLoadPct) {
            $warnHits = 1
        }
    }
    
    if ($null -ne $Metrics.TempC) {
        if ($Metrics.TempC -ge $CritTempC) {
            $critHits = 1
            $reason = "temp"
        } elseif ($Metrics.TempC -ge $WarnTempC) {
            $warnHits = 1
        }
    }
    
    if ($Metrics.KernelPower41 -gt 0 -and $Metrics.UptimeHours -lt 1) {
        $critHits = 1
        $reason = "kp41"
    }
    
    # 連続カウンタ更新
    if ($critHits -gt 0) {
        $state.critCounter = $state.critCounter + 1
        $state.warnCounter = 0
    } elseif ($warnHits -gt 0) {
        $state.warnCounter = $state.warnCounter + 1
        $state.critCounter = 0
    } else {
        $state.warnCounter = 0
        $state.critCounter = 0
    }
    
    if ($state.critCounter -ge 3) {
        $cLevel = "CRITICAL"
    } elseif ($state.warnCounter -ge 3) {
        $cLevel = "WARN"
    }
    
    return @{ Level = $cLevel; State = $state; Reason = $reason }
}

# ===== メイン処理 =====
$Dry = ($args -contains '-Dry')
$Mode = 'sample'
if ($args -contains '-Report') { $Mode = 'report' }
if ($args -contains '-Install') { $Mode = 'install' }
if ($args -contains '-Uninstall') { $Mode = 'uninstall' }

switch ($Mode) {
    "install" {
        # schtasks は例外を投げないので $LASTEXITCODE で判定する。
        # Invoke-Expression は /TR の入れ子引用符を壊すため使わず、引数配列で直接呼ぶ。
        $taskName = "OrgiastThermalGuard"
        $scriptPath = $PSCommandPath
        $action = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $scriptPath + '"'
        $out = & schtasks /Create /TN $taskName /SC MINUTE /MO 5 /TR $action /F
        if ($LASTEXITCODE -eq 0) {
            Write-Host "タスク $taskName を登録しました (5分ごとに実行)"
        } else {
            Write-Host "タスク登録に失敗しました (exit=$LASTEXITCODE)"
            Write-Host ($out | Out-String)
        }
        exit 0
    }
    "uninstall" {
        $taskName = "OrgiastThermalGuard"
        $out = & schtasks /Delete /TN $taskName /F
        if ($LASTEXITCODE -eq 0) {
            Write-Host "タスク $taskName を削除しました"
        } else {
            Write-Host "タスク $taskName は登録されていません (exit=$LASTEXITCODE)"
        }
        exit 0
    }
}

# データ収集
$metrics = Get-CpuMetrics
$temp = Get-Temperature
$uptime = Get-UptimeHours
$kp41 = Get-KernelPower41Count
$config = Read-Config

$sampleRecord = @{
    timestamp = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss")
    label = $config.Label
    hostname = $env:COMPUTERNAME
    clockPct = $metrics.ClockPct
    loadPct = $metrics.LoadPct
    tempC = $temp
    uptimeHours = $uptime
    kernelPower41 = $kp41
}

Add-Sample $sampleRecord
Clean-OldSamples

if ($Mode -eq "report") {
    # レポート生成
    $entries = @()
    try {
        if (Test-Path $SamplesCsv) {
            $lines = Get-Content $SamplesCsv -Encoding UTF8
            for ($i = 1; $i -lt $lines.Count; $i++) {
                $line = $lines[$i]
                if ([string]::IsNullOrWhiteSpace($line)) { continue }
                $parts = $line -split ','
                if ($parts.Count -ge 8) {
                    $ts = [DateTime]::Parse($parts[0])
                    if ($ts -ge (Get-Date).AddHours(-24)) {
                        $entries += [PSCustomObject]@{
                            timestamp = $ts
                            clockPct = [double]$parts[3]
                            loadPct = [double]$parts[4]
                            tempC = if ($parts[5] -eq "") { $null } else { [double]$parts[5] }
                        }
                    }
                }
            }
        }
    } catch {
        $entries = @()
    }
    
    if ($entries.Count -gt 0) {
        $clockMin = ($entries | Measure-Object -Property clockPct -Minimum).Minimum
        $clockAvg = [math]::Round(($entries | Measure-Object -Property clockPct -Average).Average, 1)
        $loadMax = ($entries | Measure-Object -Property loadPct -Maximum).Maximum
        $loadAvg = [math]::Round(($entries | Measure-Object -Property loadPct -Average).Average, 1)
        $throttleMinutes = ($entries | Where-Object { $_.clockPct -lt 85 -and $_.loadPct -ge 50 }).Count * 5
        $tempMax = $null
        $tempReadable = "取得不可(管理者権限が必要なため未計測。クロック比で代替監視中)"
        $temps = $entries | Where-Object { $null -ne $_.tempC }
        if ($temps.Count -gt 0) {
            $tempMax = ($temps | Measure-Object -Property tempC -Maximum).Maximum
            $tempReadable = "$($tempMax)°C"
        }
        $msg = "📊 熱レポート [$($config.Label)] 直近24h`n" +
               "サンプル数: $($entries.Count) / クロック比 最小 $clockMin%・平均 $clockAvg% / " +
               "負荷 最大 $loadMax%・平均 $loadAvg% / スロットリング疑い時間 ${throttleMinutes}分 / " +
               "異常停止(Kernel-Power41): $($kp41)件 / 温度: $tempReadable`n" +
               (Format-HostLine)
        if ($Dry) {
            Write-Host $msg
        } else {
            Send-Discord $msg | Out-Null
        }
    }
    exit 0
}

# サンプリング判定
$levelResult = Get-Level $metrics
$level = $levelResult.Level
$state = $levelResult.State
$reason = $levelResult.Reason

# 通知メッセージ構築
$needsPost = Should-Post $state $level
if ($needsPost -or $Dry) {
    $tempStr = "取得不可(管理者権限が必要なため未計測。クロック比で代替監視中)"
    if ($null -ne $temp) { $tempStr = "${temp}°C" }
    
    if ($level -eq "WARN") {
        $msg = "⚠️ 熱警告 [$($config.Label)] WARN`n" +
               "クロック $($metrics.ClockPct)% / 負荷 $($metrics.LoadPct)% / 温度 $tempStr`n" +
               "15分以上クロックが落ちています。室温を確認してください。`n" +
               (Format-HostLine)
    } elseif ($level -eq "CRITICAL") {
        $desc = ""
        if ($reason -eq "clock") {
            $desc = "深刻: 15分以上クロックが大幅に落ちています。室温を下げてください。"
        } elseif ($reason -eq "kp41") {
            $desc = "深刻: 直近に異常停止しています(熱による強制シャットダウンの疑い)。"
        } else {
            $desc = "深刻: 15分以上クロックが大幅に落ちています。室温を下げてください。"
        }
        $msg = "🔥 熱警報 [$($config.Label)] CRITICAL`n" +
               "クロック $($metrics.ClockPct)% / 負荷 $($metrics.LoadPct)% / 温度 $tempStr`n" +
               "$desc`n" +
               (Format-HostLine)
    } elseif ($state.level -ne "OK" -and $level -eq "OK") {
        $msg = "✅ 熱復旧 [$($config.Label)] OK`n" +
               "クロック $($metrics.ClockPct)% / 負荷 $($metrics.LoadPct)% / 温度 $tempStr`n" +
               (Format-HostLine)
    } else {
        $msg = $null
    }
    
    if ($null -ne $msg) {
        if ($Dry) {
            Write-Host $msg
        } else {
            $result = Send-Discord $msg
            $state = Update-PostState $state $result $level
        }
    }
} 

# 状態書き込み（1回だけ）
Write-State $state
