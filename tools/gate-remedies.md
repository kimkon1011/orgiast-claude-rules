# deny ゲートの復旧手順

値そのものは記載しない。取得: `node tools/onboarding-sync.mjs --keys-only --force`。

## askuser-selfcheck-gate

質問前に既存権限でファイル/ツール結果を調べ、取得可能な情報を人に聞かない。

## control-group-stop-gate

node tools/control-group-check.mjs --gate <変更したゲート名> で現在のソースに killed 証跡を作る。

## course-correction-gate

tools/course-corrections.json の該当ルールに従い訂正後の手順を実行する。

## doc-link-drive-guard

読む文書は node tools/gdoc-publish.mjs --authuser <開く人のメール> で公開してDocリンクを渡す。本文にも「<同じメール> で開いてください」を書く。

## external-state-claim-gate

対象vendorを直接照会。できない場合は未確認と書き、調査を人へ外注しない。

## feedback-form-gate

`node tools/feedback-kit/install.mjs --app <root> --upgrade` を実行してから再デプロイ（kit 未導入・版が古い・必須6機能の欠落のいずれかで deny）。方式BのリンクをHTMLへ追加、または方式Aのテンプレート/Next FeedbackWidgetを導入。台帳へアプリ名を登録。

## bihin-kcol-gate

備品管理表（全体）「備品在庫管理表」の K列は K4 の ArrayFormula の展開先。倉庫在庫数は E列へ書き、K を跨ぐ範囲は C:J と L:N に分けるか K 位置を null にする（空文字も禁止）。復旧時は K5 以降だけを clear し、K4 に `=ArrayFormula(IF(E4:E="","",E4:E-J4:J))` を戻せる。緊急時のみ BIHIN_KCOL_GATE_SKIP=1（stderr に記録）。データ破損防止のため全PCで初回から deny。

## handover-doc-gate

リポジトリ直下に HANDOVER.md を置いてから再デプロイ（ひな形: rules-extracted/project-launch-playbook.md §1.12.1。リソース一覧・env の所在・再デプロイ手順・移管チェックリスト）。全プロジェクトは別アカウントへ移管できる前提で作る決まり。緊急時のみ HANDOVER_GATE_SKIP=1。

## gh-handoff-gate

PR URL と対象ブランチ、CI/マージ状態、次の操作を書く。

## handoff-action-gate

手渡す前に、対象システム（メール/Drive/Vercel/GitHub 等）へ実際にアクセスして失敗のエラー本文を確認する。
ローカルの Grep/Glob は証拠にならない。
「元に戻せません」と人に再送・再入力を頼む場合は、第三者向けの引用文も検査対象。Sheets 書き込みなど通常の外部アクセスでは通らない。
当ターンで Drive revisions／Forms API の回答／GitHub Actions＋DWD／制作アプリのコマンドキューから復元を試し、失敗記録を本文に書く。例外は `[RESTORE-TRIED: <10文字以上の理由>]`。

## handoff-audit-gate

tools/automation-routes.json の既存経路を実行してから証拠を示す。

## handoff-branch-coverage-gate

想定される画面/権限/成功失敗の分岐と各操作を書く。

## handoff-detail-guard

ツールの開き方・入力場所・正確なボタン名・成功/失敗時の見え方を書く。

## handoff-info-guard

必要なURL/コマンド/入力値を省略せず同じ手渡し段落に書く。

## handoff-investigation-gate

試行済み経路、失敗理由、証拠、代替案を手渡し前に調べて書く。

WAIT-STALL は返事待ちを手渡し理由にせず、催促・別経路を試し、`恒久経路: <進めた実装/PR> → <結果>` で経路修正の結果を書く。

## handoff-quality-gate

[手渡し判定] に品質理由、試した自動化経路、未試行で却下した経路と証拠を書く。

## handoff-regret-gate

[再発防止] 原因:/対策:/機械化: を実際の変更とともに書く。

## internal-recipient-gmail-guard

社内宛は `node ~/orgiast-claude-rules/tools/discord-dm.mjs "<名前 or メール>" --body "<本文>"` で Discord DM を送る（送れない時だけチャットに宛先/用件/本文を提示）。GitHubコメントの内部ハンドルは@を除く。

## lane-abandonment-gate

node tools/lane-doctor.mjs --probe で代替レーンを検査して実行する。

## gmail-connector-url-gate

claude.ai の Gmail コネクタは、本文や件名の `http://` / `https://` URL を保存時に Google 転送 URL へ書き換えるため使わない。

- URL を含むメールは `node tools/gmail-draft.mjs --to … --subject … --body-file …` で Gmail API へ直接保存する。
- SA 鍵がない PC では、aujust リポジトリの GitHub Actions と DWD を使う（memory: `project-cr-pc-gmail-read-via-gha-secret`）。
- override は、転送 URL への書き換えが起きないことを生 MIME の読み戻しまで含めて確認でき、利用者がそのリスクを明示的に受け入れた場合だけ使う。`~/.claude/gmail-connector-url-gate-override` の1行目に短い有効期限の ISO 8601 時刻を書く。

## live-artifact-read-gate

Gmail送信前に説明対象のGoogleファイルを接続済みMCPで読む。Sheetsはタブ名/見出し/凡例。権限不足は未確認と報告。

## manual-request-evidence-gate

自動化不可の根拠宣言と、実際のURL/ファイル/エラーの証拠を書く。

## manual-request-fullsteps-gate

手作業の全工程・所要時間・理由・自動化できない根拠を書く。

## model-agent-guard

Agent/Task の model を sonnet/haiku に明示。実装は node tools/codex-do.mjs --prompt-file <指示> --cwd <対象>。

## negative-claim-gate

対象vendorを公式CLI/APIで直接照会する。未照会の否定断定をしない。

## next-action-gate

次にすること・自動進行・セッション終了可否を末尾に明記する。
「この後の自動進行」が空・「なし」で始まる値以外なら、CronCreate で毎時の進捗チェックを登録する（:00/:30 を避け、未完了項目を確認し、変化時だけ報告、完了で CronDelete）。現在ターンのバックグラウンド Agent/Bash/PowerShell も可。subagents と CLAUDE_HEADLESS=1 はこの検査の対象外。
人に作業を残す時は、このターンで実装・設定・依頼送信・ルール追加した具体物を `恒久策:` 行に書く。初回だけなら `恒久策: 一回限り: <理由>`。
例外は `[PERMANENT-FIX-OK: <10文字以上の理由>]`。倉庫作業の依頼送信の検査は免除しない。
倉庫の物理作業は `node tools/discord-dm.mjs <倉庫担当> --body-file <本文>` で依頼し、「倉庫担当へ依頼済み」と報告して kim の次の作業から外す。

## pr-handoff-gate

gh auth status で認証を確認し、既存credential helperまたは gh auth login を使用してPRを作成。URLと状態を本文へ書く。

## pretooluse-bash-delegation

node tools/codex-do.mjs --prompt-file <指示> --cwd <対象> で大規模インライン処理を依頼。

## pretooluse-delegation-warn

node tools/codex-do.mjs --prompt-file <指示> --cwd <対象> で実装を依頼。

## pretooluse-headless-background

run_in_background を外し前景実行、ScheduleWakeup を使わず timeout を指定する。

## pretooluse-lane-guard

GUI operator・承認済み送信スクリプトは回数制限の対象外（Codex に委譲できない PC 操作を送信途中で止めないため）。

node tools/lane-doctor.mjs --probe で状態更新し、node tools/codex-do.mjs --prompt-file <指示> --cwd <対象>。

## report-length-gate

依頼されていない完了報告を3行以内に短縮。必要な詳細のみ参照へ。

## reported-symptom-gate

報告された障害を否定せず未再現/未照会と書く。不可視の証拠は具体的に依頼。

## self-check-before-asking-guard

質問対象を既存のAPI/ファイル/CLIで調べ、取得済み情報を提示する。

## japanese-response-gate

同じ内容を日本語で書き直す。コード・コマンド・固有名詞・URL は英字のままでよい。user が英語での返答を明示した場合だけ本文に [EN-OK] を書く。応答言語は settings.json の `"language": "japanese"`（register-hooks が全PCへ配布）でも固定している。

## shallow-answer-gate

件名・一覧・ファイル名だけでなく、候補となるメッセージ・ファイルの中身を開いて確認（read_file_content / get_message / WebFetch 等）した上で回答する。どうしても確認不能な場合は本文に [DEPTH-OK: 理由] を書く。

## settings-quality-guard

effortLevel を medium/high、model を既定監督モデルに戻す。

## stop-gate

残作業を継続。人の判断が必要なときのみ具体的選択肢と根拠を提示。

## stop-gate-runner

各子ゲートの理由に従って内容を修正し、必要な実行証拠を追加する。

## url-account-gate

Workspace の URL は authuser=開く人のメール を付け、本文の同じ行か直前に「<同じメール> で開いてください」と書く。自分宛は userEmail、他人宛は共有済みの相手メール。script.google.com/home/ 系は例外。他サービスはアカウント名を直前の行に書いて URL を単独行に置き、既定と違う場合はシークレットウィンドウも指定。

## decision-research-gate

他メンバーへの DM で再送を頼む案を推奨するだけの比較表は不可。
人に作業・再送・確認を頼む案がある場合は、Claude 自身が実行する案（自動経路）を先頭に置き、試した経路と結果を書く。

費用・プラン・契約・アカウント作成・招待など user の判断や支払いを伴う提案は、user に聞かれる前に Claude が調べる。比較表（現状維持・無料の代替を含む2案以上 × 月額・得られる枠や効果・user の手間）、出典（~/.claude/pricing-brief.md か WebSearch の一次情報 URL）、推奨案と理由を付けてから出す。比較不要な場合だけ [RESEARCH-OK] <理由>。

## url-format-guard

URLを単独行に置くかMarkdownリンクにし、直後に括弧・句読点・全角文字（（）「」、。 ) ] など）を続けない。

## user-burden-gate

手作業は自動化し、不可避なら1クリックの起動手段と確認方法を用意。

## verify-before-done-detector

実行テストとread-backを行い [TESTED]、軽微で不要なら理由付き [NO-TEST-OK]。


## substitute-capability-gate

同能力の生存レーンで実行して結果を示す（ONBOARDING §1.18.5）。user が対象プロバイダを名指しした場合のみ、本文に `[SUBSTITUTE-OK] <user の文言の引用>` を書く。

## past-log-search-gate

- user に渡す手作業手順について、今ターンの過去ログ検索を検査する。
- 対象アプリ名で find-session または ~/.claude/projects の Grep を実行する。
- memory と ~/.claude/playbooks も参照し、成功した実測手順を優先する。
- 該当なしの場合は検索語を明記し、検索しても意味が無い場合のみ `[PASTLOG-OK] <理由>` を書く。
- 返信だけの依頼と完了報告は対象外。

## side-effect-left-gate

「上書きして消してしまいました」「元に戻せません」だけの報告も副作用の放置として差し戻す。
版履歴・フォーム回答などから自分で復元して検証し、同じ行か直後の行に対処結果を書く。

「権限が reader なので招待していません」のように、1経路の権限不足を理由にやらなかったことを報告する文も差し戻す（権限語と未実施語が同じ行にある時）。権限は経路ごとに違うので、登録済みの別経路（DWD 鍵 `~/.claude/keys/*.json`・GAS・CLI・別アカウントのコネクタ）を当ターンに試し、通ればその場で実施して読み戻す。全経路の失敗を記録した時だけ `[SIDE-EFFECT-OK] <試した経路と失敗>` を書く（2026-10-23: Calendar コネクタの accessRole=reader だけで先方招待を残したが、DWD 鍵の calendar.events では通った）。

副作用・影響・残作業はこのターンで修正→検証し、該当行または直後の行に結果を書く。影響なしの場合は実測・確認・読み戻しの根拠も同じ行または直後の行に書く。単なる tool_use や予定は完了の証拠ではない。user の承認・権限・支払いが必要な場合だけ `[SIDE-EFFECT-OK] <理由>` を付ける（空の理由は不可）。コードブロック・引用行は対象外。

既存 Stop runner から呼ぶため Stop hook 設定 の追加登録は不要。`ORGIAST_SIDE_EFFECT_LEFT_GATE=0` で無効化できる。既存 rollout に従い pilot PC は即時 block、他PCは配布日と初回受領から7日間の観察後に block。

## deferral-wait-gate

作業や委譲の完了を待つ旨と、その完了後に行う作業を残したままターンを閉じず、当ターン内に完了まで進める。待機が不要なら、そのまま次の作業へ進めて結果まで報告する。

コードブロック・引用行は対象外。既存 Stop runner から呼ぶため Stop hook 設定の追加登録は不要。`ORGIAST_DEFERRAL_WAIT_GATE=0` で無効化できる。既存 rollout に従い pilot PC は即時 block、他PCは配布日と初回受領から7日間の観察後に block。

## api-billing-guard
`claude /login` で Team シートを選び直す。例外は user の `[API-BILLING-OK]`（同一セッション60分）。

## claude-impl-approval
実装は `node tools/codex-do.mjs` へ委譲する。user の `[CLAUDE-IMPL-OK]` または `[LANE-OK]` のみ同一セッション60分許可。
