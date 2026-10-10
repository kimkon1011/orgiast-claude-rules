# deny ゲートの復旧手順

値そのものは記載しない。取得: `node tools/onboarding-sync.mjs --keys-only --force`。

## askuser-selfcheck-gate

質問前に既存権限でファイル/ツール結果を調べ、取得可能な情報を人に聞かない。

## control-group-stop-gate

node tools/control-group-check.mjs --gate <変更したゲート名> で現在のソースに killed 証跡を作る。

## course-correction-gate

tools/course-corrections.json の該当ルールに従い訂正後の手順を実行する。

## doc-link-drive-guard

読む文書は node tools/gdoc-publish.mjs で公開してDocリンクを渡す。

## external-state-claim-gate

対象vendorを直接照会。できない場合は未確認と書き、調査を人へ外注しない。

## feedback-form-gate

`node packages/feedback-kit/install.mjs --app <root> --upgrade` を実行してから再デプロイ（kit 未導入・版が古い・必須6機能の欠落のいずれかで deny）。方式BのリンクをHTMLへ追加、または方式Aのテンプレート/Next FeedbackWidgetを導入。台帳へアプリ名を登録。

## gh-handoff-gate

PR URL と対象ブランチ、CI/マージ状態、次の操作を書く。

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

## handoff-quality-gate

[手渡し判定] に品質理由、試した自動化経路、未試行で却下した経路と証拠を書く。

## handoff-regret-gate

[再発防止] 原因:/対策:/機械化: を実際の変更とともに書く。

## internal-recipient-gmail-guard

社内宛はチャットに宛先/用件/本文を提示。GitHubコメントの内部ハンドルは@を除く。

## lane-abandonment-gate

node tools/lane-doctor.mjs --probe で代替レーンを検査して実行する。

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

## pr-handoff-gate

gh auth status で認証を確認し、既存credential helperまたは gh auth login を使用してPRを作成。URLと状態を本文へ書く。

## pretooluse-bash-delegation

node tools/codex-do.mjs --prompt-file <指示> --cwd <対象> で大規模インライン処理を依頼。

## pretooluse-delegation-warn

node tools/codex-do.mjs --prompt-file <指示> --cwd <対象> で実装を依頼。

## pretooluse-headless-background

run_in_background を外し前景実行、ScheduleWakeup を使わず timeout を指定する。

## pretooluse-lane-guard

node tools/lane-doctor.mjs --probe で状態更新し、node tools/codex-do.mjs --prompt-file <指示> --cwd <対象>。

## report-length-gate

依頼されていない完了報告を3行以内に短縮。必要な詳細のみ参照へ。

## reported-symptom-gate

報告された障害を否定せず未再現/未照会と書く。不可視の証拠は具体的に依頼。

## self-check-before-asking-guard

質問対象を既存のAPI/ファイル/CLIで調べ、取得済み情報を提示する。

## settings-quality-guard

effortLevel を medium/high、model を既定監督モデルに戻す。

## stop-gate

残作業を継続。人の判断が必要なときのみ具体的選択肢と根拠を提示。

## stop-gate-runner

各子ゲートの理由に従って内容を修正し、必要な実行証拠を追加する。

## url-account-gate

URLに開くアカウント名を添える。既定と違う場合はシークレットウィンドウも指定。

## url-format-guard

URLをMarkdownリンクまたは空白で囲み、日本語/全角文字との直接隣接を除く。

## user-burden-gate

手作業は自動化し、不可避なら1クリックの起動手段と確認方法を用意。

## verify-before-done-detector

実行テストとread-backを行い [TESTED]、軽微で不要なら理由付き [NO-TEST-OK]。

