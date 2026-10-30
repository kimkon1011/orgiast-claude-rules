# R640 構築の決定記録

2026-10-29 / r640-provision-B-20261029。今回の範囲は handoff B。実機導入・PRマージは未実施。

## 確定構成と既定値

ユーザーの実機確認を正本とする。Dell PowerEdge R640、Xeon Gold 6140×2、PERC **H330 Mini**、前面2.5インチ10ベイ。既存NICは **Intel X520-DA2（10Gb SFP+×2、RJ45なし）**。OS用にI350-T2（RJ45、igb）を増設予定。iDRAC専用RJ45はOS用NICと別物。ラックは取消済みで、棚に横置きする。DIMM・SSD・トレイ・I350は未購入であり、通電だけではOS導入を始められない。

メモリ既定を旧指示の192GBから **16GB RDIMM×8＝128GB、CPUごと4枚**に変更した。UDIMMは不可。192GBへの増設は同容量の計12枚・CPUごと6枚にそろえる（現在の8枚に4枚追加）。以後も両CPU対称で各CPUの6チャネルをそろえる構成を推奨する。装着位置は天板の旧所有者ラベルではなく、[Dell R640マニュアル](https://www.dell.com/support/product-details/en-us/product/poweredge-r640/docs)のメモリ装着規則と実際のスロット表示で確認する。

## RAIDの比較と採用

推奨は **H330のHBAモード＋mdadm RAID1**。理由はLinux側でミラー状態を管理でき、PERC論理ディスク形式への依存を減らせるため。HBAを遠隔で選択できない場合はハードRAID1に切り替える。操作が失敗した後の無条件フォールバックはしない。

| 観点 | H330 Mini ハードRAID1 | H330 HBA＋mdadm RAID1（既定） | H730P（互換分岐のみ） |
| --- | --- | --- | --- |
| 構築 | Redfishで2台から仮想ディスクを1台作成 | HBA変更ジョブ→再起動→読戻し→autoinstallでmd作成 | PERC 9のHBA/RAID分岐を保持、実機はH330で確定 |
| 監視 | iDRACの物理/仮想ディスク状態。smartctlのmegaraid経由取得は実機確認 | mdadmでミラー監視。SMART取得可否は別途実測 | 同様。HBAをeHBAやITファームと同一視しない |
| 流用SSD | 非認定品の警告・互換性・寿命を個別確認 | HBAでも認定品相当の互換性は保証しない | キャッシュ設定を流用せず実機別に確認 |
| カード故障 | 互換PERCで構成のimportが必要 | Linux mdメタデータによる復旧が可能な設計。別コントローラでの起動試験は未実施 | どちらの構成を選んだかに依存 |
| ブート | PERC論理ディスクのESP | 各SSDに独立ESP、rootはmd RAID1、EFI同期あり | 実際に選んだISOと一致させる |

[Dell PERC 9 User's Guide](https://dl.dell.com/topicspdf/poweredge-rc-h330_users-guide_en-us.pdf)のpersonality管理とHBA移行前提を根拠とする。同資料はHBA時のSMART監視無効を明記しているため、「HBAならsmartctlが必ず素直に使える」という旧前提は採用しない。OS側取得の可否と障害通知を実機で確認する。H330/H730PのHBA対応と、搭載iDRACファームウェアでのRedfish変更可否は別問題である。

`--perc auto`は搭載機種を読み取る。今回の導入時は誤機種検出用に`--perc H330`も指定できる。既存仮想ディスク、SSDシリアル不一致、容量不足、不健康状態、未知のPERCは停止。既存データを自動採用・削除しない。HBAへの変更はジョブ完了と再読込を確認する。API形状はモック検証のみで、実機ファームウェア差は未検証。

## メモリと同時利用の上限

以下は実測値ではなく設計予算。OS・DB・キャッシュ等に24GiBを確保し、1人最大5GiBを目安に `min(20, floor((RAM-24)/5))` を設定検証する。

| RAM | 同時上限 | 運用 |
| --- | ---: | --- |
| 192GiB | 20人 | CPUあたり16GB×6枚。余裕を確保 |
| **128GiB** | **20人** | 既定。20人×5GiB＋24GiB＝124GiB。負荷試験で必要なら上限を下げる |
| 96GiB | 14人 | CSVの人数ではなく同時接続を制限 |
| 64GiB | 8人 | 20人同時は不可。Chromeタブ・並行ビルドを制限 |

`site.maxSessions`をxrdpに適用。ユーザーsliceはMemoryHigh=5G / MemoryMax=6Gで、6Gは保護上限であり20人への同時割当保証ではない。Chromeはメモリ節約とバックグラウンド停止を設定。zram=RAMの25%（圧縮率依存）を補助とし、容量計算には加えない。平文パスワードのディスク退避を避けるためディスクswapは無効、プロビジョニング時に検査する。

## リモート方式と認証

主はGuacamole＋PostgreSQL JDBC＋guacdをDocker Composeで固定版運用、副はホストのxrdp/Xorg。公式イメージを採用し、ソースビルドの依存関係管理を避ける。[ApacheのDocker構成説明](https://guacamole.apache.org/doc/gug/guacamole-docker.html)に従いDBだけ永続化し、webは127.0.0.1:8080、guacd/DBはLANへ公開しない。nginxで443を終端する。コンテナからホストへは`host.docker.internal:3389`を使う（コンテナ内localhostはホストではない）。

社員ID/PWをLinuxとJDBCに同じ値で作成し、[Guacamoleのパラメータートークン](https://guacamole.apache.org/doc/gug/configuring-guacamole.html) `${GUAC_USERNAME}` / `${GUAC_PASSWORD}` でRDPに渡す。handoffの`%USERNAME%` / `%PASSWORD%`は実際の構文へ修正した。初回OAuth登録や二重ログインは要求しない。初期PWの受領と通常の初回ログインは必要であり、配布経路は未決定。

| 方式 | 今回 | 理由・残件 |
| --- | --- | --- |
| JDBC ID/PW | 採用 | CSVでアカウントと接続を一括作成。PW変更時はLinux/DB両方をそろえる |
| Google Workspace OIDC | 次フェーズ候補 | orgiast.jp制限・SSOを別途設計。OIDCトークンはLinuxログインPWの代わりにならず、RDP認証の解決が必要 |
| Chromeリモートデスクトップ | 不採用 | 本計画のLinuxホスト登録方式ではユーザーごとのGoogle認証が必要となり、管理者一括作成・初回設定操作ゼロを満たせない |
| code-server | 不採用 | 追加HTTPポート・認証・常駐メモリの運用を増やす。既存Guacamole内のVS Codeを使う |

sesmanは指定どおりPolicy=Default、切断・アイドルで終了しない。[xrdp 0.9.24の正本](https://github.com/neutrinolabs/xrdp/blob/v0.9.24/sesman/sesman.ini.in)ではDefaultはユーザー＋色深度単位である。Guacamoleを24bppに固定し、LAN直接接続も24bppに合わせる。Guacamole側は接続ごと上限1。異なる色深度の直接RDPまで含めた完全な1人1セッション保証は未検証であり、再接続・二重接続試験を必須とする。

## 運用・安全性の判断

- 一般社員とmanagerロールの双方にsudo/dockerグループを付与しない。SSHは管理LANのr640admin鍵認証だけ。
- 初期PWはopensslの256bit乱数。暗号化前の平文はプロセス内とパイプだけで、age公開鍵で暗号化する。保存されるのは暗号文とソルト付きハッシュ。秘密鍵はkeyserve。
- 削除は`--prune --delete --confirm-delete`の明示時のみ。通常のpruneは無効化・セッション終了。通知コードはあるが本タスク中に送信しない。
- バックアップはrestic、02:30 JSTのtimer。保存先はパラメータ必須で、未設定を成功扱いしない。別ホスト保存先の初期化・復元試験は実機待ち。
- Node/CLI/Compose/Guacamole/PostgreSQLは[versions.env](../versions.env)で固定。Chrome/VS Code/Ubuntu aptパッケージはセキュリティ更新のため固定しない。イメージはタグ固定でありdigest固定ではない。更新PRではDB互換性と復元を確認する。
- 実機手順の設計補助に指定された `decisions/DEC-0002-r640-linux-guacamole.md` はこの作業ツリーと確認した共有パスに無かった。提示されたhandoffと今回の確定情報を用いた。

## 未確定事項

社員CSVの正本（候補はWorkspace DWD）、固定IP/DNS名、バックアップ先、初期PW配布経路、購入・装着済みメモリ容量、iDRACファームウェア/Enterpriseライセンス/接続性は未確定。exampleを本番値として自動採用しない。導入条件と人の操作は[first-boot.md](first-boot.md)、復元・再実行は[operations.md](operations.md)を参照。
