# R640 運用手順（管理担当用）

本番実行は未実施。以下は管理担当のコマンドで、kimへの手作業依頼ではない。設定は[decisions.md](decisions.md)、初回の人の操作と未準備条件は[first-boot.md](first-boot.md)を先に確認する。実データ・秘密情報・専用ISOをGit、PR、一般ログへ入れない。

## 初回導入の準備

`site.example.json`から管理用の`site.json`を作る。RAM既定128GiB、同時20人。SSDは2台の正確なシリアルと最低容量を指定する。`minimumDiskGiB`はGiB単位なので、例えば販売表示240GBのSSDに240GiBを指定すると不足として停止する。実際のbytesを見て余裕をもって設定する。

`employees.csv`は `username,display_name,email,role` の4列。roleはemployee/managerだけで、どちらもsudoなし。BOM/引用符/カンマ対応、重複・予約名・不正値は拒否。正本の出所は未確定なのでexampleで本番ユーザーを作成しない。

keyserveの`r640.json`は[keyserve-r640.example.json](../keyserve-r640.example.json)の項目に従う。DB/resticのPWは24文字以上。age秘密鍵は管理側のkeyserve、サーバー側は公開受信鍵だけとする。ホストの登録情報はroot専用 `~/.claude/keyserve.env`。資格情報をコマンド引数や履歴に埋め込まない。外部CAが必要なら検証済みCAを`NODE_EXTRA_CA_CERTS`で指定する。TLS検証を無効にしない。

Ubuntu 24.04のamd64 ISOと公式チェックサム、xorriso、Node、python3-yamlを管理端末に用意する。サイトのstorageModeだけを変えたmdadm/hardwareの2設定から2つのISOを作る。入力操作と消去対象を確認した管理担当だけが次のテンプレートを実値に置換して実行する。

```bash
node provision/r640/bin/build-iso.mjs --iso /secure/ubuntu-24.04-live-server-amd64.iso --iso-sha256 APPROVED_SHA256 --site /secure/site-mdadm.json --csv /secure/employees.csv --enrollment /secure/keyserve.env --output /secure/r640-mdadm.iso --url https://installer.example.test/r640-mdadm.iso --confirm-wipe
node provision/r640/bin/build-iso.mjs --iso /secure/ubuntu-24.04-live-server-amd64.iso --iso-sha256 APPROVED_SHA256 --site /secure/site-hardware.json --csv /secure/employees.csv --enrollment /secure/keyserve.env --output /secure/r640-hardware.iso --url https://installer.example.test/r640-hardware.iso --confirm-wipe
```

生成された2つの`.iso.json`を`mdadm`/`hardware`キーを残して1つの`images.json`へ統合する。ISO内にもstorageModeが含まれるため、設定の手変更だけで片方のISOを流用しない。ISOは登録秘密情報と社員名簿を含む。専用ディレクトリ700・媒体600とし、iDRACだけが取得できるネットワーク制限をHTTPS配信側に設定する。配信内容のSHA256をmanifestと再照合する。bootstrapはmanifestの整合性を検査するが、iDRACが実際にダウンロードしたISOのハッシュまでは検証できない。

```bash
node provision/r640/bin/idrac-bootstrap.mjs --dry-run
node provision/r640/bin/idrac-bootstrap.mjs --site /secure/site-mdadm.json --images /secure/images.json --perc H330 --storage auto --confirm-wipe
```

電源/LANと初期認証が確認される前に後者を実行しない。既存仮想ディスク、既存Virtual Media、シリアル不一致では停止し、自動削除しない。途中失敗時はiDRACのジョブ/ストレージの現在状態を読み戻してから判断し、消去コマンドを反復しない。OS導入後は仮想メディアを取り外し、ISO配信を停止し、登録情報の保持/失効を管理する。この後片付けはbootstrap内では自動化していない。

autoinstallは[CanonicalのNoCloud方式](https://canonical-subiquity.readthedocs-hosted.com/en/latest/howto/autoinstall-quickstart.html)を使う。リンクした物理NICのMACでネットワークを選択し、明示したSSD以外を拒否。空のSSH鍵などが残る配布用テンプレートは、そのまま媒体として使わない。cloud-init schema成功はSubiquity/Curtinでのインストール成功を証明しない。

## 構築・再実行・ユーザー同期

```bash
bash provision/r640/bin/provision.sh --dry-run --csv provision/r640/employees.example.csv
sudo bash /opt/orgiast-r640/bin/provision.sh --csv /etc/orgiast-r640/employees.csv --site /etc/orgiast-r640/site.json
sudo systemctl status orgiast-r640-provision.service --no-pager
sudo cat /var/log/orgiast-provision/verify.txt
```

初回サービスは成功後に `/var/lib/orgiast-r640-provisioned` を作る。再実行は上記provisionコマンドを使う。flockで同時実行を拒否。手順ごとのSTART/PASS/FAILとroot限定ログを残し、第三者コマンドの秘密を含み得る標準出力は保存しない。パッケージ照会・設定再書込はあり、「変更ゼロ」型ではなく同じ状態へ収束させる冪等実装である。既存PWを再発行せず、DB失敗途中は暗号文とpendingハッシュで復旧する。sesmanを毎回再起動せず、変更反映が必要な場合は保守時間に再起動して利用者への影響を確認する。

社員追加はCSVを更新してprovisionを再実行。既存Linuxユーザーを勝手に管理対象にしない。DB接続定義だけの同期は次を使う（OSユーザー作成は行わない）。

```bash
sudo bash /opt/orgiast-r640/bin/sync-guacamole.sh /etc/orgiast-r640/employees.csv
sudo bash /opt/orgiast-r640/bin/provision.sh --csv /etc/orgiast-r640/employees.csv --site /etc/orgiast-r640/site.json --prune
```

pruneはCSVから消えた管理対象だけをロック・ログイン不可にし、JDBCを無効化、既存ユーザーセッションを終了する。guacd再起動は他の接続も一度切断するので保守時間に行う。ホーム削除には別途明示承認と`--prune --delete --confirm-delete`が必要。空CSVでの一括pruneを拒否する。削除済みユーザーの同名再作成は自動では行わない。

初回1人目の暗号文は `/root/provision/initial-passwords.csv.age`、2人目以降は `initial-passwords.<username>.csv.age`。配布文面は `distribution.<username>.txt.age` で宛先/用件/本文を含む。複数ファイルをまとめて取り扱う。復号は配布担当がkeyserveから秘密鍵をメモリ/パイプへ取得して行い、平文ファイルやシェル履歴を作らない。配布経路は未決定で、本コードは送信しない。社員への送付はHUMAN_GATE。

PW変更はLinuxだけ/Guacamoleだけで行うと二重ログイン回避が壊れる。現行実装には一括ローテーションCLIがない。変更が必要なら管理担当が対象を一時無効化し、同一PWを両方へ適用し、暗号化配布物を更新して実ログイン確認後に有効化する。`accounts.json`は初期のハッシュを保持するため、DBを再作成する場合は変更後PWとの整合も確認する。

## 日常点検とバックアップ

```bash
sudo bash /opt/orgiast-r640/bin/verify-on-host.sh
sudo systemctl list-timers orgiast-r640-backup.timer --all
sudo systemctl status orgiast-r640-stack.service orgiast-r640-backup.service --no-pager
```

verifyの終了値は0=全項目完了、1=FAILあり、2=FAILなしだがPENDINGあり。現行では描画・復元・負荷試験をPENDINGとして残すため、systemdがexit 2を失敗表示する場合も合否表を読む。未検証をPASSに書換えて隠さない。通知失敗はFAIL行として記録。ハードRAIDの状態はiDRAC読戻しが別途必要。

backup timerは毎晩02:30 JST＋最大10分の分散、停止中の取り逃しはPersistentで追随する。`/home`、`/root/provision`、`/etc/orgiast-r640`、xrdp/SSH設定、rootのkeyserve登録をresticで暗号化保存し、PostgreSQLはpg_dumpをパイプで別スナップショットに保存する。保存先は必ず別ホスト/NASとし、同じSSD上だけをバックアップと呼ばない。

初回は管理担当が `/run/orgiast-r640/restic-password` を使い、**正しい保存先を確認してから**restic initする。backupは未初期化リポジトリを勝手に作らず停止する。NASを使う場合は`backupMount`を指定し、マウント消失でローカルへ書き込まない。SSH/S3等の保存先別資格情報は別途準備が必要。世代削除は自動化していない。使用量と成功日時を監視し、方針確定後に保持期間を設定する。

## 障害・復元の手順

1. Guacamole障害時は社内LANのWindows「リモートデスクトップ接続」を使い、サーバーの実ホスト名へ接続する。「オプションの表示 → 画面 → 色」を24ビットに合わせ、社員の同じID/PWで入る。直接RDPはLAN限定。Xorgを選ぶ構成にしてあり、sudoは使えない。
2. サーバー障害時は管理担当が別Linuxからバックアップのスナップショット一覧を読み、同じバックアップ実行に属するホーム/設定とDBダンプを選ぶ。両者は別スナップショットで、全体の原子的スナップショットではない。
3. 空の復旧用ディレクトリへrestic restoreし、件数・所有者UID/GID・ファイル内容を確認する。本番の`/`へいきなり展開しない。隔離環境で社員のUID/GIDを合わせ、ホーム・root限定状態を復元する。
4. 同じ固定版のDB/Guacamoleを用意し、web/guacdを止めた保守状態でDBを復元する。pg_dumpをpsqlへパイプし、平文ダンプを一般ディスクに残さない。`accounts.json`だけでは変更後のPWを再現できないため、DBとOSの認証整合を確認する。
5. 代表社員のログイン、復元ファイル、権限、再接続を検証し、復旧先のバックアップtimerと通知も確認してから切替える。復元試験は未実施。

mdadm構成は各SSDのESPを[bin/sync-efi.sh](../bin/sync-efi.sh)で同期する。カーネル更新フックとバックアップ時に実行するが、SSDを1台ずつ外した起動試験・交換後の再構築・UEFI起動順確認は実機必須。RAIDはバックアップの代わりにならない。

## 実機受入れ表（DONE_CRITERIA 11・12）

| 検査 | 合格の証跡 | 現状 |
| --- | --- | --- |
| iDRAC/H330/SSD | モデル、ファーム、ジョブ完了、シリアル、RAID状態の読戻し | 実機待ち |
| OS/アプリ/権限/通信 | verify.txtのPASSと実LAN/他サブネットの到達試験 | 実機待ち |
| Guacamole描画 | テストユーザーでログイン→接続→XFCEのスクリーンショットを `reports/r640-guacamole-e2e/` に保存 | Docker無しのため未検証 |
| 再接続・重複防止 | 開いたウィンドウとXorg PIDが同じ。2ブラウザ/24bpp直接RDP/異色深度も確認 | 未検証 |
| リサイズ/clipboard/Mozc | 実ブラウザ内で日本語入力、双方向コピー、画面追随の記録 | 実機待ち |
| 20人同時 | メモリ、OOM、CPU、I/O待ち、対話遅延。上限20人を承認できる実測 | 実機待ち |
| RAID劣化/復旧 | SSD各片系起動、交換・リビルド、SMART可否の記録 | 実機待ち |
| 証明書/復元 | 社員端末で警告なし、別環境からホームとDB復元 | 実機待ち |

現在のverifyはサービス/設定の自動検査と未検証一覧を出す。Playwrightでの描画や負荷・日本語入力の自動合格判定は含まない。PENDINGを解消する証跡は担当がこの表と対応づけて保存する。
