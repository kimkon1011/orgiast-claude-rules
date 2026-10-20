kim-PC で SSD 調査コマンドを実行しました（読み取りのみ、2026-10-20 実測）。

PC名: DESKTOP-2D0R4LI
型番 | 種類 | 接続 | 形状 | 容量 | 健康状態 | 使用時間 | 摩耗% | OSが入っているか
CT500P2SSD8 (Crucial P2, SN末尾4桁 007.) | SSD | NVMe | M.2 | 500GB (500,107,862,016 B) | Healthy | 未取得 | 未取得 | はい（C: = Disk 1）
SAMSUNG HD204UI (SN末尾4桁 5701) | HDD | SATA | 3.5インチ（型番から判断） | 2TB (2,000,398,934,016 B) | Healthy | 未取得 | 未取得 | いいえ

補足:
- 使用時間と摩耗%は、Get-StorageReliabilityCounter が「CIM リソースへのアクセスを取得できませんでした」で失敗したため未取得です（管理者権限が必要）。
- R640 の 2.5インチ SATA ベイに流用できる SSD は、このPCにはありません（SSD は M.2 NVMe の1台だけで、それも OS ディスク。HDD は 3.5インチ）。
- 元の依頼にある kimko PC（C:\Users\kimko）での fleet-exec codex は exit=1 で終わっています。このPCは kim-PC（uers）なので、kimko PC の結果ではありません。
