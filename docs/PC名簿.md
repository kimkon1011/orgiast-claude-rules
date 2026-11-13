# PC名簿（Chrome リモートデスクトップ名 → fleet-mail 宛先）

最終更新: 2026-11-02。正本は `fleet-pc-map.json`（証拠付き）。元データは台帳「オージャスト クラウド契約・プロジェクト台帳」の「PC稼働状況」タブ（kim@orgiast.jp 所有）と、kim が撮った各PCの「詳細情報」画面のスクリーンショット。

`fleet-mail --send --to 作業用019 ...` のように、リモートデスクトップ名をそのまま宛先に書ける。全角数字・前後の空白は自動で直る。名簿の番号は **PCのラベル（REPORTER_LABEL）** に変換して送る。hostname には変換しない（PC名と作業用番号がずれている例があるため）。完全一致のみ（作業用番号／ラベル／hostname／all）。解決できない値は送らず、候補は exit 4 で表示する。

## 確定

| 作業用番号 | 担当者 | アカウント | hostname | Claude Code 導入状況 | fleet-mail 宛先の書き方 |
|---|---|---|---|---|---|
| 作業用999 | 未確認 | seisaku-team@orgiast.jp | DESKTOP-BDOAK99 | 導入済み（2026-09-03 実機確認。2026-11-04 利用者申告で作業用999と確定） | `--to 作業用999`（→ DESKTOP-BDOAK99。旧誤登録の `--to 作業用008` も aliases で同じPCへ届く） |
| 作業用019 | nishi | nishi@orgiast.jp | DESKTOP-04U31RG（Precision T3610） | 導入済み（2026-10-08 に fleet-mail で返信あり） | `--to 作業用019`（→ nishi-PC） |
| 作業用004民泊用 | nishi | nishi@orgiast.jp | DESKTOP-PPD5V8I | 導入済み（ラベル kimko-PC で報告。台帳上は 2026-09-17 に停止、最終やり取り 2026-09-30） | `--to 作業用004民泊用`（→ kimko-PC） |
| 作業用011 | cr | cr@orgiast.jp | 作業用011（HP EliteDesk 800 G3 SFF） | ラベル cr-PC（enroll 2026-10-09 発行・fleet 鍵の配布待ち） | `--to 作業用011`（→ cr-PC） |

注意: ラベル「kimko-PC」は作業用011 ではなく作業用004民泊用 のPC。台帳の行「作業用011(=DESKTOP-PPD5V8I)」は誤り。シート側は kim が 2026-10-09 に修正済みかを要確認。

## 番号なし（作業用番号が未割当または不明）

| PC | 担当者 | アカウント | hostname | Claude Code 導入状況 | fleet-mail 宛先の書き方 |
|---|---|---|---|---|---|
| kim-PC（開発機） | 金功勇 | kim@orgiast.jp | DESKTOP-2D0R4LI | 導入済み。OrgiastFleetMail タスクは 2026-10-08 に再有効化（Ready / LastTaskResult 0） | `--to kim-PC` |
| HP（東邦2階HP） | 木下真弓 | 未確認 | 未確認 | 2026-08-18 を最後に停止 | `--to HP` |

## 未確認（宛先解決には使われない）

| 作業用番号 | 担当者 | アカウント | hostname | Claude Code 導入状況 | 未確認の理由 |
|---|---|---|---|---|---|
| 作業用018 | 未確認 | cr@orgiast.jp（kim 回答 2026-10-08） | 未確認 | 未確認 | 011 の誤記と判明（2026-10-09） |
| （番号なし）MacBook Air 13″・macOS 14.8.9・シリアル C02YK73PJK77 | 増田裕子 | cr@orgiast.jp（kim 申告 2026-10-13） | 未確認 | cr@ の Claude Code を使用中（kim 申告） | hostname／ラベル未報告 |

| （番号未確認）cafe015-PC | 未確認 | seisaku-team@orgiast.jp（fleet-status 2026-11-02、自己申告） | 未確認 | 登録候補 | 作業用番号の証拠なし。008には紐付けない |
| （番号未確認）user-PC | 未確認 | seisaku-team@orgiast.jp（fleet-status 2026-11-02、自己申告） | 未確認 | 登録候補 | 作業用番号の証拠なし。008には紐付けない |

作業用999（DESKTOP-BDOAK99）の訂正: 2026-11-02 PR #1401 は作業用008で登録したが、根拠は kim-PC が008前提で送った引継ぎメールへの自己申告返信（`mail-reply-fa9b672e49db7164`・`mail-reply-828ab32aca705b84`・`mail-reply-23b5030901dbd50f`、2026-10-30）で、作業用番号はローカルで検証できない。2026-11-04 に利用者が「このパソコンは999」と申告し訂正。実在の作業用008が別にあるかは kim 確認待ち。

## 確定のしかた

1. Chrome リモートデスクトップ（remotedesktop.google.com/access、kim@orgiast.jp で開く）で対象PCに接続し、そのPCの「設定 → システム → 詳細情報」でデバイス名とデバイスIDを見る。
2. そのPCが fleet-mail を受信するときのラベル（`~/.claude/cost-reporter.env` の REPORTER_LABEL、無ければ hostname）を確認する。そのPCの Claude Code に自己報告させてよい。
3. 両方そろったら、`fleet-pc-map.json` でそのラベルのエントリに `remoteName` を付ける。
