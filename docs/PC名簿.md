# PC名簿（Chrome リモートデスクトップ名 → fleet-mail 宛先）

最終更新: 2026-10-08。正本は `fleet-pc-map.json`（証拠付き）。台帳「オージャスト クラウド契約・プロジェクト台帳」の「PC稼働状況」タブ（kim@orgiast.jp 所有）が元データ。

`fleet-mail --send --to 作業用011 ...` のように、リモートデスクトップ名をそのまま宛先に書ける。全角数字・前後の空白は自動で直る。名簿に無い値は従来どおり部分一致（ラベル／hostname）。

## 確定

| 作業用番号 | 担当者 | アカウント | hostname | Claude Code 導入状況 | fleet-mail 宛先の書き方 |
|---|---|---|---|---|---|
| 作業用011 | 金功勇 | 未確認 | DESKTOP-PPD5V8I（kimko-PC） | 導入済み。ただし台帳上は 2026-09-17 に停止、最終やり取り 2026-09-30 | `--to 作業用011` |
| 作業用999 | 未確認 | 未確認 | 未確認（未報告） | 導入完了を 2026-09-03 に実機確認。以後の報告なし | `--to 作業用999`（hostname が無いのでキー名で照合。実機のラベルと一致する保証なし） |

## 番号なし（作業用番号が未割当または不明）

| PC | 担当者 | アカウント | hostname | Claude Code 導入状況 | fleet-mail 宛先の書き方 |
|---|---|---|---|---|---|
| kim-PC（開発機） | 金功勇 | kim@orgiast.jp | DESKTOP-2D0R4LI | 導入済み。OrgiastFleetMail タスクは 2026-10-08 に再有効化（Ready / LastTaskResult 0） | `--to kim-PC` |
| nishi-PC | 未確認 | seisaku-team@orgiast.jp（git メール） | DESKTOP-04U31RG | 導入済み（2026-08-28/29 に報告実績） | `--to nishi-PC` |
| HP（東邦2階HP） | 木下真弓 | 未確認 | 未確認 | 2026-08-18 を最後に停止 | `--to HP` |

## 未確認（宛先解決には使われない）

| 作業用番号 | 担当者 | アカウント | hostname | Claude Code 導入状況 | fleet-mail 宛先の書き方 |
|---|---|---|---|---|---|
| 作業用019 | nishi | nishi@orgiast.jp（kim 回答 2026-10-08・確定） | 未確認（候補: nishi-PC = DESKTOP-04U31RG） | 未確認 | 現状 `--to 作業用019` は素通しになり届かない。当面は `--to nishi-PC`。hostname 確定後に名簿へ昇格 |
| 作業用004民泊用 | nishi | nishi@orgiast.jp（kim 回答 2026-10-08・確定。台帳の担当欄「金功勇」より優先） | 未確認（候補: nishi-PC = DESKTOP-04U31RG） | 未確認 | 未確認。nishi@ のPCが019と004の2台あり、DESKTOP-04U31RG がどちらかは未確定 |
| 作業用018 | 未確認 | cr@orgiast.jp（kim 回答 2026-10-08・確定） | 未確認 | 未確認 | 未確認 |

## 確定のしかた

1. 対象PCで Chrome リモートデスクトップ名（管理者 PowerShell で `(Get-Content "$env:ProgramData\Google\Chrome Remote Desktop\host.json" -Raw | ConvertFrom-Json).host_name`）と `hostname` を確認する。そのPCの Claude Code に `fleet-mail` で自己報告させてよい（作業用019 は 2026-10-08 に nishi-PC へ照会済み: mail-20261008142734267-9107）。
2. 一致したら、`fleet-pc-map.json` の `_unverified.<作業用番号>` を該当PCのエントリの `remoteName` に移す。
