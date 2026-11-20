# 業務依頼書: 官公庁入札の「毎朝の自動進行」パイプライン化（2026-11-20）

## 目的
いまは毎朝 6:00 に `tools/collect.mjs` が候補 CSV（約415件）を作るだけで、そこから先は人が Claude に頼んだ日だけ進む。
2026-11-20 16:52〜18:01 に手作業で一周した流れ（名前フィルタ → 公告の取得・テキスト化 → 原文抽出 → 提出可否の判定 → 候補一覧 → 提案書・見積の下書き → 金さんへの確認文）を、**頼まれなくても毎朝自動で回る**ようにする。
社外への送信・申込・ログインは一切しない（それは人の承認後に別の手順で行う）。

## 入力資料（必ず読む）
- `HANDOVER.md`
- 毎朝の収集: `tools/collect.mjs`、`tools/daily-collect.bat`（cmd が CP932 で読むため **ASCII のみ**で書く。日本語コメント禁止）
- 11/20 の手作業で使った一回限りのスクリプト（日付・案件名が直書き。これを一般化する）:
  `tools/process_notices.py`、`tools/candidate_snippets.py`、`tools/build_extract.py`、`tools/build_draft_prompts.mjs`、`tools/run_draft_llms.mjs`、`tools/normalize_and_check_drafts.mjs`、`tools/fetch_verify2_sources.py`、`tools/extract_verify2_pdfs.py`、`tools/xls_to_txt.py`
- 11/20 の指示書と成果物（判定基準・出力形式の手本）:
  `prompts/02-notice-extract-2026-11-20.md`（抽出項目・判定キー・品質基準）、`prompts/03-draft-common.md`（下書き共通ルール）、
  `reports/namefilter-2026-11-20.txt`、`data/notices/2026-11-20/extract.json`、`reports/shortlist-2026-11-20.md`（A/B/C の分け方）、`reports/kim-ask-2026-11-20.md`（金さんへの確認文の形）
- 安いAIの呼び出し: `C:\Users\kimko\.claude\nightly-repo\tools\llm-ask.mjs`（`--provider deepseek|openrouter|kimi --prompt-file <f> --no-fallback --max <n> --per-provider-timeout-ms <ms>`。run_draft_llms.mjs の呼び方を踏襲）
- 金さんへの通知: `C:\Users\kimko\.claude\nightly-repo\tools\kim-inbox.mjs`（`--add --kind ask|info --body-file <f>`。他の引数はソースと `docs/kim-inbox.md` で確認）
- 期限台帳: `C:\Users\kimko\.claude\nightly-repo\tools\deadline-watch.mjs`（登録方法はソースで確認）
- Google シート: `tools/create-sheet-v2.mjs`（サービスアカウント鍵 `~/.claude/keys/aujust-sheets-reader.json` の使い方）

## 作業内容
1. `config/company-profile.json` を新規作成（人が後で書き換える前提の設定。コードに直書きしない）:
   - 全省庁統一資格: `{"status":"expired","expiredOn":"2025-03-31","note":"再申請準備中"}`
   - 登録済みの自治体名簿: `["大阪府","大阪市"]`
   - 対象業務キーワード（namefilter と同じもの。例: 展示会, ブース, 設営, イベント, 式典, 会場, 運営, 映像, 動画, 学会, 出展 など。11/20 のフィルタ処理を探して同じ語を使う）
   - 1日の上限: `maxNoticesPerDay: 40`, `maxLlmCallsPerDay: 60`, `maxDraftsPerDay: 3`
2. `data/state/seen.json` を新規作成（候補ごとの台帳。キーは公告URL）: 初回発見日・名前フィルタ結果・tier（A/B/C/除外）・締切・金さんに確認済みか。
   **2026-11-20 に処理済みの全案件（namefilter・extract.json・shortlist の A/B/C）を初期値として登録**し、明日以降に同じ案件をもう一度金さんへ聞かないようにする。
3. `tools/daily-pipeline.mjs` を新規作成（`--date YYYY-MM-DD` 既定は今日 JST、`--dry-run`、`--limit N`）:
   a. `data/candidates-<date>.csv` を読み、seen.json に無い公告URLだけを対象にする。
   b. 名前フィルタ（キーワード）＋フィルタ外は安いAIで「当社の業務か」を一括分類（11/20 の nov-classify と同じ考え方。1回の呼び出しにまとめる）。
   c. 対象の公告を GET で取得しテキスト化（process_notices.py を日付・入力一覧を引数で受ける形に一般化して呼ぶ。出力は `data/notices/<date>/`。1秒以上・同一ドメイン1.5秒以上の間隔。cookie・ログイン・POST 禁止）。
   d. 安いAIで原文抽出（02 の指示書の項目・判定キー）→ 各引用が txt に実在するかを機械照合（不一致は notes に「引用不一致」）→ `data/notices/<date>/extract.json`。
   e. company-profile と照らして機械的に tier を決める: A=締切前で、必要資格を今の状態で満たす（または名簿不要）／B=金額・適合は良いが資格・地域で今は出せない／C=取得失敗・期限切れ・業務違い。
   f. A のうち適合度 高・中を最大3件、`prompts/03-draft-common.md` のルールで提案書・見積の下書きを作る（build_draft_prompts / run_draft_llms を一般化。deepseek → openrouter → kimi の順で失敗時に次へ）。出力 `reports/drafts/<date>/<slug>/`。会社情報は 03 にあるものだけ。
   g. `reports/shortlist-<date>.md` を 11/20 と同じ形（結論・A表・B表・C表）で出力。
   h. Google シート「官公庁入札 候補台帳」に追記（無ければ1回だけ作成し ID を `config/sheet.json` に保存。以後は同じシートに追記・更新）。列: 発見日・tier・案件名・発注者・金額・参加申込期限・提出期限・必要資格・提出方法・公告URL・下書きの場所・金さんの判断。**kim@orgiast.jp に編集権限を付け、権限一覧を読み戻して確認**する。サービスアカウントで作れない場合（容量・権限エラー）は、エラー本文をログに残し、シート以外の処理は続ける。
   i. 新しい A が1件以上あるときだけ、`kim-inbox.mjs --add --kind ask` で**1件にまとめた**確認を積む。本文は `reports/kim-ask-2026-11-20.md` の形（案件ごとに 案件名・発注者・金額・締切・必要資格・提出方法・下書きの場所・公告URL、選択肢「進める／見送る」、返事の例）。A が0件の日は ask を積まない（info も積まない）。積んだ案件は seen.json に「確認済み」と記録。
   j. A の参加申込期限・提出期限を deadline-watch に登録する（重複登録しない）。
   k. 実行ごとに `data/pipeline-runs.jsonl` に1行（日付・新規件数・各段の件数・LLM呼び出し回数・失敗・所要秒）。
   l. どこかの段が失敗しても次の段に進み、最後に失敗があれば `kim-inbox.mjs --add --kind info` で失敗内容を1件だけ積む。上限（maxNoticesPerDay / maxLlmCallsPerDay）に達したら、その段で止めて記録する。
4. `tools/daily-collect.bat` を変更し、collect の後に `node tools\daily-pipeline.mjs >> data\daily-pipeline.log 2>&1` を実行する（**ASCII のみ**。collect が失敗したら pipeline は実行しない。python・node はタスクスケジューラから見つかる絶対パスか where で確認したものを使う）。
5. `HANDOVER.md` に「毎朝の自動進行」の節を追記（何が・いつ・どこに出るか、company-profile の書き換え方＝資格を取ったら status と名簿を更新する）。

## 最終成果物
- 新規: `tools/daily-pipeline.mjs`、`config/company-profile.json`、`data/state/seen.json`、（作れたら）`config/sheet.json`
- 変更: 一般化した既存スクリプト、`tools/daily-collect.bat`、`HANDOVER.md`
- git commit（このリポジトリは remote なし。commit だけでよい）

## 品質基準・検証（すべて実行して結果を最後に表示）
1. `node tools/daily-pipeline.mjs --date 2026-11-20 --dry-run`: 11/20 分はすべて seen 済みなので新規0件・ask 0件になること。
2. `node tools/daily-pipeline.mjs --date 2026-11-19 --dry-run --limit 5`: LLM・ネットを呼ばずに、対象件数と各段の予定件数を表示すること。
3. 本番実行1回: seen.json を一時的にコピーした別ファイルで、11/20 の CSV から未処理の公告を `--limit 3` だけ実際に取得・抽出・判定・一覧化まで通す（kim-inbox への ask はテスト中は積まない＝`--no-inbox` を用意して使う）。出力ファイルのパスと件数を表示。
4. `daily-collect.bat` に非 ASCII 文字が無いことを機械チェック（バイト値 > 0x7F が0件）。
5. Google シートを作れた場合は URL と、kim@orgiast.jp が writer で付いていることの読み戻し結果を表示。
6. `git log -1 --stat` を表示。

## 禁止事項
- 社外への送信・問い合わせ・申込・ログイン・フォーム送信・POST・メール送信は禁止（公告の GET のみ）。
- ファイルの削除禁止。2026-11-20 の既存成果物（data/notices/2026-11-20、reports/*2026-11-20*、reports/drafts/2026-11-20）を書き換えない。
- Claude API（api.anthropic.com・@anthropic-ai/sdk・claude-*）の呼び出し禁止。LLM は llm-ask.mjs の deepseek / openrouter / kimi だけ。
- タスクスケジューラのタスクの新規作成・削除はしない（既存 `\OrgiastBidDailyCollect` がそのまま bat を呼ぶ）。
- `_scratch/` は使わない・読まない。

## 停止条件
- 検証1〜6をすべて実行したら終了し、各結果をそのまま表示する。途中で直せない失敗があれば、そこで止めてエラー本文を表示する。
