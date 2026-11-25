# 仕様: 各PCが「スペック」と「開発プロジェクト/成果物」を自己申告する

kim 指示 2026-08-27:
1. 「各パソコンでどんなプロジェクトの開発をしているかも把握したい。それもスプレッドシートに記載するようにして。成果物を管理したい」
2. 「あとスペックも管理したいから、報告させて」（対象: 別シート「PC管理表」タブ）

## 大前提（設計の要）

**シート本文を Claude/PC側で読まない。列解決と書き込みは GAS（サーバ側）に閉じる。**
理由: スペックの対象シート `1jAOwP41YeF09ftdhCp5RdCcnNW305ewu053HVk7VGBM`（備品管理表関係データ保管用）は
**`anyone`＝編集者**で公開されており、しかも**パスワード列を含む**。
PC側や Claude のコンテキストに本文を持ち込まない設計にする（読まなければ漏らせない）。

**書き込みは許可リスト方式**。禁止列を列挙する方式（denylist）にはしない。
ヘッダ名の許可リストに載っている列だけ書く。列が増えても事故らない。

---

## A. スペック報告（新規シート「PC管理表」）

### A-1. 収集側 `tools/hardware-spec.mjs`（新規）

OS を判定して次を集める。**1項目でも取れなくても全体を落とさない**（取れたものだけ返す）。

| 項目 | キー | Windows | macOS | Linux |
|---|---|---|---|---|
| メーカー | `maker` | `Win32_ComputerSystem.Manufacturer` | `system_profiler SPHardwareDataType` | `dmidecode -s system-manufacturer` |
| コンピュータ名 | `computerName` | `os.hostname()` | 同 | 同 |
| 型番 | `model` | `Win32_ComputerSystem.Model` | `SPHardwareDataType` の Model Identifier | `dmidecode -s system-product-name` |
| CPU | `cpu` | `Win32_Processor.Name` | `sysctl -n machdep.cpu.brand_string` | `/proc/cpuinfo` model name |
| GPU/VRAM | `gpu` | `Win32_VideoController` の Name と AdapterRAM | `SPDisplaysDataType` | `lspci \| grep -i vga` |
| OS | `os` | `Win32_OperatingSystem.Caption` + Version | `sw_vers` | `/etc/os-release` |
| ビット数 | `bits` | `OSArchitecture` | `uname -m` | 同 |
| メモリ種類 | `memoryType` | `Win32_PhysicalMemory.SMBIOSMemoryType` を DDR3/DDR4/DDR5 に変換 | `SPMemoryDataType` | `dmidecode --type 17` |
| メモリ容量(GB) | `memoryGb` | `Win32_PhysicalMemory` の Capacity 合計 | 同 | 同 |
| 空きスロット | `memorySlotsFree` | `Win32_PhysicalMemoryArray.MemoryDevices` − 実装本数 | 同 | 同 |
| メモリ最大容量 | `memoryMaxGb` | `Win32_PhysicalMemoryArray.MaxCapacityEx`(KB) | 取得不能なら空 | `dmidecode --type 16` |
| ストレージ種類 | `diskType` | `MSFT_PhysicalDisk.MediaType` + BusType で NVMe/SSD/HDD | `SPNVMeDataType`/`SPSerialATADataType` | `lsblk -d -o name,rota` |
| ストレージ容量(GB) | `diskGb` | 合計 | 同 | 同 |
| 光学ドライブ | `opticalDrive` | `Win32_CDROMDrive` の有無 | `SPDiscBurningDataType` | `lsblk` の rom |
| 有線LAN | `lan` | `Win32_NetworkAdapter` の PhysicalAdapter かつ 802.3 | `SPEthernetDataType` | `/sys/class/net/*/wireless` の無いもの |
| 無線LAN | `wifi` | 同上で Wireless | `SPAirPortDataType` | 同上で wireless あり |
| HDMI | `hdmi` | `WmiMonitorConnectionParams` / VideoOutputTechnology=5 | `SPDisplaysDataType` の Connection Type | `/sys/class/drm/*HDMI*` |

- **`--json` で機械可読、既定は人が読める表**（kim の指示文にある「ターミナルに表形式で表示」を満たす）。
- 有無系（光学/LAN/無線/HDMI）は `あり` / `なし` / `判定不能` の3値。**取得できないものを「なし」と断定しない**
  （[[feedback_delegation_paths_fail_silently]] と同じ誤り）。
- Web検索での補完は**この場ではやらない**（PC側からの自動実行に外部検索を混ぜない）。
  取れない項目は空にして、`_unresolved` に項目名の配列を入れる。kim が後で埋められる。
- Windows のコマンドは **`wmic` を使わない**（Windows 11 で非推奨・削除済み環境がある）。
  `Get-CimInstance` を使い、PowerShell 呼び出しは1回にまとめて JSON で受け取る（起動コストが大きい）。
- **純関数を分離して export しテストする**: `parseMemoryType(smbiosCode)` /
  `toGb(bytes)` / `classifyDisk({mediaType, busType})` / `formatSpecTable(spec)` /
  `buildSpecPayload(spec, hostname)`。**OS コマンドの実行部分はテストしない**（注入可能にする）。

### A-2. 送信側

`tools/fleet-sheet-report.mjs` に `--specs` を足し、`hardware-spec.mjs` の結果を
既存の POST に `spec` フィールドとして同梱する。既存の送信内容と挙動は変えない。

### A-3. GAS 側 `gas/fleet-status-sheet/PcInventory.gs`（新規）

`doPost` に `kind: 'pc-spec'` を追加（既存の `FLEET_TOKEN` 認証をそのまま使う。新しい鍵は作らない）。

- 対象は Script Property `PC_INVENTORY_SHEET_ID`（値 `1jAOwP41YeF09ftdhCp5RdCcnNW305ewu053HVk7VGBM`）の
  「PC管理表」タブ。**タブ名は Script Property にキャッシュ**する（既存 `SHEET_TAB_NAME` と同じ方式）。
- 列は**ヘッダ文字列で解決**する。列レターをハードコードしない。照合は NFKC 正規化＋空白除去。
- **書き込み許可リスト（これ以外は絶対に書かない）**:
  `メーカー` / `コンピュータ名` / `型番` / `CPU` / `VGA GPU` / `OS` / `ビット` /
  `ﾒﾓﾘ種類` / `ﾒﾓﾘ容量(GB)` / `ﾒﾓﾘ空ｽﾛｯﾄ` / `ﾒﾓﾘ最大容量` /
  `HDD種類` / `HDD(GB)` / `CD/DVDドライブ` / `LAN口` / `無線LAN` / `HDMI` / `情報更新日`
  ※実ヘッダの表記揺れ（半角カナ・全角）に耐えるよう、**正規化後の部分一致**で解決してよいが、
  **許可リストに無い列に一致した場合は書かない**。
- **絶対に書かない列**（許可リストに入れないことで担保。テストでも明示的に検証する）:
  `ユーザ名` / `パスワード` / `購入日` / `商品名` / `購入金額` / `購入店` / `使用カード` /
  `保険の有無` / `保険終了日` / `倉庫場所` / `状態` / `主な使用者・使用用途` / `URL` /
  `デバイス名` / `デバイスID` / `その他`
- 行の突合: `コンピュータ名` 列がホスト名と一致する行。**無ければ最下部に追記**し、
  `PC No.` は既存の `P<数字>` の最大値+1、`情報更新日` に本日(JST)、
  `ﾉｰﾄor ﾃﾞｽｸﾄｯﾌﾟ` に種別を入れる。
  **既に値がある許可列は上書きしてよい（最新のハード情報が正）。空文字で既存値を潰さない**
  （取得できなかった項目は書かない＝セルを触らない）。
- 純ロジックは `PcInventoryLogic.gs` に分け、`fleetPlanPcInventory(headers, rows, payload)` として
  Node 側テストから読み込めるようにする（既存 `UpsertLogic.gs` / `fleetPlanUpsert` と同じ流儀）。

### A-4. テスト `tools/pc-inventory-logic.test.mjs`（新規）

- 許可列だけが書かれ、**禁止列16種が1つも書かれない**こと（列順をシャッフルしても成立すること）
- ホスト名一致で既存行を更新し、行が増えないこと
- 一致なしで追記され `PC No.` が `P<最大+1>` になること
- **取得できなかった項目でセルを空にしないこと**（既存値が保持されること）
- ヘッダが半角カナ/全角混在でも解決できること

---

## B. 開発プロジェクト / 成果物（既存のフリートシート）

### B-1. 収集側 `tools/project-inventory.mjs`（新規）

そのPCの Claude Code の作業実績から、**会話内容は一切読まずに**次を出す。

- `~/.claude/projects/<slug>/*.jsonl` の各バケットについて、直近 N 日（既定7）に更新があるものを選ぶ。
- 各バケットの最新 transcript から `"cwd":"…"` を1つ取り出し（正規表現・JSON全体を parse しない）、
  そのパスを**プロジェクトの実体**とする。表示名は basename。
- そのパスが git リポジトリなら: remote URL からリポジトリ名、現在のブランチ、
  最終コミットの日付と件名、直近N日の**自分のコミット数**（`git log --author=<user.email>`）を取る。
- 出力は `[{ project, repoName, branch, lastCommitAt, lastCommitSubject, commits }]` を
  **直近の活動が多い順**に並べる。上限は既定5件（シートのセルに収める）。

**取ってはいけないもの**: 会話本文・プロンプト・ファイル内容・秘匿値。
**パスは basename だけ**（フルパスにはユーザー名が入る。hostname/OSユーザー名は既に別列にある）。

純関数を export しテストする: `pickActiveBuckets(entries, now, days)` /
`extractCwd(text)` / `summarizeProjects(items, limit)` / `formatProjectsCell(items)`。

### B-2. シート列（既存 `gas/fleet-status-sheet/UpsertLogic.gs` のオプショナル列に追加）

別セッションが `OSユーザー名` / `実ホスト名` / `Gitメール` を追加した仕組みに**そのまま乗る**
（`FLEET_OPTIONAL_HEADERS_` に追加し、無ければ右端に足す方式）。

- `開発プロジェクト(直近7日)` … `プロジェクト名(コミット数)` をカンマ区切りで最大5件
- `成果物(リポジトリ/ブランチ)` … `リポ名@ブランチ` をカンマ区切り
- `直近コミット` … `YYYY-MM-DD 件名`（件名は60字で切る）

`fleet-sheet-report.mjs` がこの3項目を送る。既存の送信内容・行マッチングは変えない。

---

## やらないこと

- シート本文を PC 側 / Claude 側で読むこと
- 禁止列への書き込み（許可リストで構造的に防ぐ）
- 取得できない項目を「なし」と断定すること
- 会話内容・フルパス・秘匿値の送信
- `wmic` の使用
- 新しい鍵・新しい認証の追加（既存 `FLEET_TOKEN` を使う）
- GAS のデプロイ（別作業。デプロイは既存 deploymentId へ `clasp deploy --deploymentId` で URL 維持）
