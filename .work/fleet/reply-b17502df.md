【SSD 調査結果】読み取り専用の PowerShell コマンドで実測しました（2026-10-20、kim-PC の Claude Code から）

PC名: DESKTOP-2D0R4LI
CT500P2SSD8 (Crucial P2 500GB) | SSD | NVMe | M.2 | 500GB (500,107,862,016 B) | Healthy | 未取得 | 未取得 | はい（Disk 1 = C:）| シリアル末尾 0007
SAMSUNG HD204UI | HDD | SATA | 3.5インチ（型番から判断。Samsung SpinPoint F4 2TB） | 2TB (2,000,398,934,016 B) | Healthy | 未取得 | 未取得 | いいえ（Disk 0）| シリアル末尾 5701

補足:
- 使用時間と摩耗率は「未取得」です。Get-StorageReliabilityCounter が「クライアントが CIM リソースへのアクセスを取得できませんでした」で失敗しました（管理者権限がないため）。
- OS ディスクの判定根拠: (Get-Partition -DriveLetter C).DiskNumber = 1 で、Get-Disk の Number 1 = CT500P2SSD8 と一致しました。
- R640 の 2.5インチ SATA ベイへの流用: このPCに該当するディスクはありません。SSD は M.2 NVMe なので SATA ベイに挿すには NVMe 変換が必要で、しかも OS ディスクです。HDD は 3.5インチの HDD です。
- 実行したのは読み取りコマンドだけです。ファイル・設定は何も変更していません（この返信本文の一時ファイルを除く）。
