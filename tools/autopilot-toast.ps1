param([Parameter(Mandatory=$true)][string]$BodyPath)
$ErrorActionPreference = 'Stop'
$payload = Get-Content -LiteralPath $BodyPath -Raw -Encoding UTF8 | ConvertFrom-Json
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text></text><text></text></binding></visual></toast>')
$nodes = $xml.GetElementsByTagName('text')
$nodes.Item(0).InnerText = [string]$payload.title
$nodes.Item(1).InnerText = [string]$payload.body
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Microsoft.Windows.Shell.RunDialog')
if ($null -ne $notifier.Setting -and $notifier.Setting.ToString() -ne 'Enabled') { throw "toast_disabled:$($notifier.Setting)" }
$notifier.Show($toast)
Write-Output 'submitted'
