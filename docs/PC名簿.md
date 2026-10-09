# PC名簿（Chrome リモートデスクトップ名 → fleet-mail 宛先）

最終更新: 2026-10-09。正本は `fleet-pc-map.json`（証拠付き）。元データは台帳「オージャスト クラウド契約・プロジェクト台帳」の「PC稼働状況」タブ（kim@orgiast.jp 所有）と、kim が撮った各PCの「詳細情報」画面のスクリーンショット。

`fleet-mail --send --to 作業用019 ...` のように、リモートデスクトップ名をそのまま宛先に書ける。全角数字・前後の空白は自動で直る。名簿の番号は **PCのラベル（REPORTER_LABEL）** に変換して送る。hostname には変換しない（PC名と作業用番号がずれている例があるため）。名簿に無い値は従来どおり部分一致（ラベル／hostname）。

## 確定

| 作業用番号 | 担当者 | アカウント | hostname | Claude Code 導入状況 | fleet-mail 宛先の書き方 |
|---|---|---|---|---|---|
| 作業用019 | nishi | nishi@orgiast.jp | DESKTOP-04U31RG（Precision T3610） | 導入済み（2026-10-08 に fleet-mail で返信あり） | `--to 作業用019`（→ nishi-PC） |
| 作業用004民泊用 | nishi | nishi@orgiast.jp | DESKTOP-PPD5V8I | 導入済み（ラベル kimko-PC で報告。台帳上は 2026-09-17 に停止、最終やり取り 2026-09-30） | `--to 作業用004民泊用`（→ kimko-PC） |
| 作業用011 | 金功勇 | Windows サインインは kimkongyong@gmail.com、Claude のアカウントは未確認 | 作業用011（HP EliteDesk 800 G3 SFF） | 未確認 | `--to 作業用011`（ラベル未設定なら hostname で受信） |
| 作業用999 | 未確認 | 未確認 | 未確認（未報告） | 導入完了を 2026-09-03 に実機確認。以後の報告なし | `--to 作業用999`（ラベルが不明なのでキー名で送る。実機のラベルと一致する保証なし） |

注意: ラベル「kimko-PC」は作業用011 ではなく作業用004民泊用 のPC。台帳の行「作業用011(=DESKTOP-PPD5V8I)」は誤りで、修正が必要。

## 番号なし（作業用番号が未割当または不明）

| PC | 担当者 | アカウント | hostname | Claude Code 導入状況 | fleet-mail 宛先の書き方 |
|---|---|---|---|---|---|
| kim-PC（開発機） | 金功勇 | kim@orgiast.jp | DESKTOP-2D0R4LI | 導入済み。OrgiastFleetMail タスクは 2026-10-08 に再有効化（Ready / LastTaskResult 0） | `--to kim-PC` |
| HP（東邦2階HP） | 木下真弓 | 未確認 | 未確認 | 2026-08-18 を最後に停止 | `--to HP` |

## 未確認（宛先解決には使われない）

| 作業用番号 | 担当者 | アカウント | hostname | Claude Code 導入状況 | 未確認の理由 |
|---|---|---|---|---|---|
| 作業用018 | 未確認 | cr@orgiast.jp（kim 回答 2026-10-08） | 未確認 | 未確認 | hostname・ラベル・報告実績が無い |

## 確定のしかた

1. Chrome リモートデスクトップ（remotedesktop.google.com/access、kim@orgiast.jp で開く）で対象PCに接続し、そのPCの「設定 → システム → 詳細情報」でデバイス名とデバイスIDを見る。
2. そのPCが fleet-mail を受信するときのラベル（`~/.claude/cost-reporter.env` の REPORTER_LABEL、無ければ hostname）を確認する。そのPCの Claude Code に自己報告させてよい。
3. 両方そろったら、`fleet-pc-map.json` でそのラベルのエントリに `remoteName` を付ける。
