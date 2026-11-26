# tl;dv 打合せ後フォローアップ
終了後5分を経た直近72時間の会議を15分間隔で検知し、担当PCへ依頼する。
文字起こし・メモと、kim／制作チームの予定・案件マスターを照合する。
文字起こし未準備は再試行し、初回検知から48時間で対象外にする。
案件一覧の読取失敗は保留する。候補が複数または未特定ならタイトルと参加者ドメインで絞り、なお種別不明なら011へ。
`clientKindHints` は予定・会議・説明・案件顧客名に一致する取引先をキーワードより先に分類する。
案件も分類語もない場合だけ文字起こし冒頭4000文字を集計し、3回以上かつ次点の2倍以上なら種別を推定する。
作業用008は 008XPS8300。受信側の実測は `~/.claude/meeting-prep/receivers.json` に置く。

| 優先順 | 種別 | 担当 |
|---|---|---|
| 1 | 制作アプリ・営業自動化・学会制作の自動化 | 作業用011 |
| 2 | 学会の出展・協賛 | 作業用018 |
| 3 | 展示会ブース | 作業用014（PC未解決時のみ008） |
| 4 | その他のイベント・種別キーワードなしの特定済み案件 | 作業用008 |

受信側の受付実測に従いfleet-mail／fleet-directiveを使う。
担当PC・実行経路が解決しない場合はkim-PCで資料を保存してローカル実行する。
ローカルは既存の他AI providerを使う隔離headless実行。Claude APIへの代替接続はない。
ローカルのREPORTは下書きで、ツール不可のため外部シート更新は未実行と明記する。
社外メール・LINEは送信しない。返却下書きだけを承認待ちの送信待ち台帳に追加する。

設定のパスはユーザーホーム相対。主な保存先:
- `.claude/state/tldv-followup-dispatch.json`: processed／pending／held／skipped／draftsSeen。
- `.claude/state/tldv-followup-dispatch.lock`: 多重起動防止、30分で古いロックを回収。
- `.claude/unsent-ledger/ledger.json` と `bodies/`: 下書き台帳・本文（原子的更新）。
- `gb-reports/YYYYMMDD-顧客名/`: prompt.txt（BOM）・transcript.txt・REPORT.md。
- 同日同顧客の入力は `meetings/<会議ID>/` にも保管する。
- `gb-reports/latest-tldv-followup.md`、`gb-reports/tldv-followup/runs/`、同階層の `STATUS.md`。

試行: `node tools/tldv-followup-dispatch.mjs --dry-run --report-dir ./dry-run-output`
絞込: `--date 2026-11-26`（JST会議日）、`--meeting ID`、`--lookback-hours 96`、`--release-held ID,ID`。
dry-runは送信・ローカル起動・state／ledger／定常レポート保存を行わない。
登録: `powershell -ExecutionPolicy Bypass -File tools/register-tldv-followup-task.ps1`
登録対象は `OrgiastTldvFollowupDispatch` のみ。同期済みrepoへ配置後に登録する。
ログ: `%USERPROFILE%\.claude\logs\tldv-followup-dispatch.log`。
401／403はSTATUSに「TLDV_API_KEY 失効または権限不足」を記録し終了コード2。
キーは環境変数または `~/.claude/tldv.env` から読む。キー値は記録しない。
保留解除は `--release-held` で state.held の該当IDを除き、必要ならlookbackを広げて再実行する。
