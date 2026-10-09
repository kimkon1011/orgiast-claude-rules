# 2026-10-09: 拒否ゲートの復旧手段が配布されていなかった

調査基準: main の導入commit `80482d6e76482f4752b392d1e26cd1a39ab52107`、修正待ちPR #667 の `4898dba150d202775fef48509fd5b86b54c0f571`。調査開始時 #667 は OPEN / mergedAt=null。そのブランチから独立cloneで分岐した。以下はリポ内の履歴・コード・公開PR記録から分かること。ユーザー提供memoryは証拠に使用していない。

## 1. 時系列と配布経路

| 日時 (JST) | 証拠 | 確定事項 |
|---|---|---|
| 2026-09-03 20:41:44 | `55ef30e04fb92c7f090de8076876fc7be4257950` / #251 | INSTALL.md方式Aの中継URL説明に担当者への問い合わせを要求する行を追加。secretも「同上」。 |
| 2026-09-04 02:28:42 | `a20246dfbfc63171491f3fd410670d9e0c29610f` | 方式B、FEEDBACK_SHARED_FORM_URLとローカルenvへの保存を追加した元commit。 |
| 2026-09-04 03:01:13 | `0370b5a6749c7d3782a8aca0344e9d158328c7e8` / #253 | mainに方式Bを復旧。commit本文は「exec URL は public リポには置かず ~/.claude/feedback-relay.env で配る」。各PCにあると書く一方、取得処理/配布登録はこの差分に無い。 |
| 2026-10-08 14:51:34 | `ee3a19136d80cc3477665ec98f02d344cba8fc87` | feedback-form-gate の元commit。 |
| 2026-10-08 14:54:22 | `80482d6e76482f4752b392d1e26cd1a39ab52107` / #648 の mergedAt | mainへゲート追加。commit日時は14:54:21。register-hooksとsetup-manifestへ同時登録したため、この時点から同期対象になった。 |
| 2026-10-09 18:08:01 | `4898dba150d202775fef48509fd5b86b54c0f571` / #667 | 方式B認識、deploy語境界、keyserve取得案内、キー単位マージ回帰テストを追加。 |

配布開始日を「mainで配布可能になった日」と定義すると **2026-10-08**。各PCで初めて実行された日時は、リポ履歴からは分からず **未確認**。

- 新規PC: `tools/install-orgiast.ps1` → リポ取得 → `register-hooks.mjs --hooks-only` → PreToolUseのBash/PowerShellに登録。
- 既存PC: SessionStartの `onboarding-sync.mjs` → `updateRepositoryFiles` で tools/rules-extracted/skills を取得 → `setup.mjs --converge --home <home>` → `register-hooks.mjs --hooks-only`。同期失敗時にも登録へ進む。SessionStart自体にもsetup --convergeが登録される。
- hookのcommandは登録元リポのtoolsを直接参照する。`register-hooks.mjs` は実行中ファイルのリポを基準とし、ORGIAST_REPOで変更可能。`setup-manifest.json` はfeedback-form-gate欠落をrequiredとして修復する。
- `onboarding-sync.mjs` の既定同期先は `~/orgiast-claude-rules`。`orgiast-main` というPC上の別checkoutはこの既定とは異なる。#667本文にはkim-PCの実hookが `C:/Users/uers/orgiast-main` を指したとの実測記載がある。全PCが同じcheckout名・同じ更新処理を使うとは断定しない。各PCのsettingsとcheckout HEADの突合せは未確認。
- `fleet-poller.ps1` にもonboarding-sync呼出しがある。新規installだけを変更しても既存PCへ到達しないため、本変更は既存登録の移行をregister-hooksの冪等処理として実装する。

`FEEDBACK_SHARED_FORM_URL` をローカルenvで扱う理由（publicリポへ置かない）は #253のcommitにある。しかし **keyserveを使わないと決めた記録は未確認**。`git log --all -S FEEDBACK_SHARED_FORM_URL` で #253 と #667を確認した範囲では、「ローカルenvへ保存」と「ローカルにしか配布しない」は同義ではなく、後者の意思決定は証明できない。

## 2. 追加PRの検証で抜けていたもの

[PR #648](https://github.com/kimkon1011/orgiast-claude-rules/pull/648) の本文は、ゲート・台帳・配布登録、33件のhookテスト、カフェアプリでのdenyとnpm run buildのpassを列挙している。取得した `reviews` は空配列（公開レビュー0件）。これを「全ての非公開レビューも無かった」とは解釈しない。

`git show 80482d6:tools/feedback-form-gate.test.mjs` のケースはNext/GAS未搭載、FeedbackWidget、適用除外、npm test、cwd解決、台帳/env map、壊れた入力、Windowsパスである。**クリーンな他PCのhomeでURLを取得→推奨方式Bを導入→同じdeployが通る**ケースはない。GASの検出はFeedbackRelayだけで、既に推奨されていた方式Bリンクを扱わない。非deploy検証もnpm test/git pushに限られ、clasp deploymentsはない。本文・このテストファイルに「他PCで手段を取得できるか」の検証記載は見当たらない。

根本原因は、拒否機能の配布を機械化しながら、その解除に必要なデータ・手順の到達性を契約にしていなかったこと。フォーム搭載を強制する変更と、URL/秘密の配布運用が別々に管理され、推奨手順と判定実装の整合テストも無かった。

## 3. 全denyゲートの復旧手段台帳

範囲: register-hooksのPreToolUse/Stop登録、setup-manifest、Stop runnerの全gate/guard import、およびtools直下でdeny/blockを出すhookを横断。**37本**（集約runnerを含む）。`gate-contract.test.mjs` はこれらを独立探索する。a=リポに手段/手順あり、b=keyserve配布あり、c=ローカル認証/権限だけ、または配布なし。aの手順があることは外部認証の存在を保証しない。repo-fileには専用復旧節を指定し、認可はuser-consentとして区別する。

**cを含む事故候補は4ゲート**: feedback-form、doc-link-drive、live-artifact-read、pr-handoff。最初の1件は今回の事故（#667後は共通URLがbへ）。他3件はコード上の依存から抽出した候補で、他PCの実障害発生は未確認。権限を必要としない本文修正が可能な場合もあるため、4件すべてが必ず停止するとの断定ではない。

| ゲート | 経路 | 通過に必要なremedy | 分類・到達性 |
|---|---|---|---|
| `askuser-selfcheck-gate` | PreToolUse | 質問前に既存権限でファイル/ツール結果を調べ、取得可能な情報を人に聞かない。 | a: tools/gate-remedies.md の同名節。秘密値不要 |
| `control-group-stop-gate` | Stop子 | node tools/control-group-check.mjs --gate <変更したゲート名> で現在のソースに killed 証跡を作る。 | a: tools/gate-remedies.md の同名節。秘密値不要 |
| `course-correction-gate` | Stop子 | tools/course-corrections.json の該当ルールに従い訂正後の手順を実行する。 | a: tools/gate-remedies.md の同名節。秘密値不要 |
| `doc-link-drive-guard` | Stop子 | 読む文書は node tools/gdoc-publish.mjs で公開してDocリンクを渡す。 | a: gdoc-publish.mjs。c: GOOGLE_SA_KEY（既定はローカルDownloads配下のsheets-sa.json）、または接続済みDocs作成権限 |
| `external-state-claim-gate` | Stop子 | 対象vendorを直接照会。できない場合は未確認と書き、調査を人へ外注しない。 | a: tools/gate-remedies.md の同名節。秘密値不要 |
| `feedback-form-gate` | PreToolUse | 方式BのリンクをHTMLへ追加、または方式Aのテンプレート/Next FeedbackWidgetを導入。台帳へアプリ名を登録。 | a: packages/feedback-{gas,widget} と台帳。事故時c: FEEDBACK_SHARED_FORM_URL / 方式A中継秘密。#667後URLはb、方式A未認可時はBを選ぶ |
| `gh-handoff-gate` | Stop子 | PR URL と対象ブランチ、CI/マージ状態、次の操作を書く。 | a: tools/gate-remedies.md の同名節。秘密値不要 |
| `handoff-audit-gate` | Stop子 | tools/automation-routes.json の既存経路を実行してから証拠を示す。 | a: tools/gate-remedies.md の同名節。秘密値不要 |
| `handoff-branch-coverage-gate` | Stop子 | 想定される画面/権限/成功失敗の分岐と各操作を書く。 | a: tools/gate-remedies.md の同名節。秘密値不要 |
| `handoff-detail-guard` | Stop | ツールの開き方・入力場所・正確なボタン名・成功/失敗時の見え方を書く。 | a: tools/gate-remedies.md の同名節。秘密値不要 |
| `handoff-info-guard` | Stop子 | 必要なURL/コマンド/入力値を省略せず同じ手渡し段落に書く。 | a: tools/gate-remedies.md の同名節。秘密値不要 |
| `handoff-investigation-gate` | Stop子 | 試行済み経路、失敗理由、証拠、代替案を手渡し前に調べて書く。 | a: tools/gate-remedies.md の同名節。秘密値不要 |
| `handoff-quality-gate` | Stop子 | [手渡し判定] に品質理由、試した自動化経路、未試行で却下した経路と証拠を書く。 | a: tools/gate-remedies.md の同名節。秘密値不要 |
| `handoff-regret-gate` | Stop子 | [再発防止] 原因:/対策:/機械化: を実際の変更とともに書く。 | a: tools/gate-remedies.md の同名節。秘密値不要 |
| `internal-recipient-gmail-guard` | PreToolUse | 社内宛はチャットに宛先/用件/本文を提示。GitHubコメントの内部ハンドルは@を除く。 | a: internal-recipients.default.json（ローカル台帳が無い場合のfallback）、本文/宛先の変更 |
| `lane-abandonment-gate` | Stop子 | node tools/lane-doctor.mjs --probe で代替レーンを検査して実行する。 | a: codex-do/lane-doctor。b: 代替レーンdeepseek.env#DEEPSEEK_API_KEY。Codexログインは各人に依存 |
| `live-artifact-read-gate` | PreToolUse | Gmail送信前に説明対象のGoogleファイルを接続済みMCPで読む。Sheetsはタブ名/見出し/凡例。権限不足は未確認と報告。 | a: 読取手順。c: 各人のGoogle MCP/OAuthと対象ファイル共有権限（リポ/配布では与えられない） |
| `manual-request-evidence-gate` | 単独hook（標準登録外） | 自動化不可の根拠宣言と、実際のURL/ファイル/エラーの証拠を書く。 | a: tools/gate-remedies.md の同名節。秘密値不要 |
| `manual-request-fullsteps-gate` | Stop子 | 手作業の全工程・所要時間・理由・自動化できない根拠を書く。 | a: tools/gate-remedies.md の同名節。秘密値不要 |
| `model-agent-guard` | PreToolUse | Agent/Task の model を sonnet/haiku に明示。実装は node tools/codex-do.mjs --prompt-file <指示> --cwd <対象>。 | a: codex-do/lane-doctor。b: 代替レーンdeepseek.env#DEEPSEEK_API_KEY。Codexログインは各人に依存 |
| `negative-claim-gate` | Stop子 | 対象vendorを公式CLI/APIで直接照会する。未照会の否定断定をしない。 | a: tools/gate-remedies.md の同名節。秘密値不要 |
| `next-action-gate` | Stop子 | 次にすること・自動進行・セッション終了可否を末尾に明記する。 | a: tools/gate-remedies.md の同名節。秘密値不要 |
| `pr-handoff-gate` | Stop子 | gh auth status で認証を確認し、既存credential helperまたは gh auth login を使用してPRを作成。URLと状態を本文へ書く。 | a: gh auth status/login。c: GitHub認証/PAT。git push成功だけではPR権限を保証しない |
| `pretooluse-bash-delegation` | PreToolUse | node tools/codex-do.mjs --prompt-file <指示> --cwd <対象> で大規模インライン処理を依頼。 | a: codex-do/lane-doctor。b: 代替レーンdeepseek.env#DEEPSEEK_API_KEY。Codexログインは各人に依存 |
| `pretooluse-delegation-warn` | PreToolUse | node tools/codex-do.mjs --prompt-file <指示> --cwd <対象> で実装を依頼。 | a: codex-do/lane-doctor。b: 代替レーンdeepseek.env#DEEPSEEK_API_KEY。Codexログインは各人に依存 |
| `pretooluse-headless-background` | PreToolUse | run_in_background を外し前景実行、ScheduleWakeup を使わず timeout を指定する。 | a: tools/gate-remedies.md の同名節。秘密値不要 |
| `pretooluse-lane-guard` | PreToolUse | node tools/lane-doctor.mjs --probe で状態更新し、node tools/codex-do.mjs --prompt-file <指示> --cwd <対象>。 | a: codex-do/lane-doctor。b: 代替レーンdeepseek.env#DEEPSEEK_API_KEY。Codexログインは各人に依存 |
| `report-length-gate` | Stop子 | 依頼されていない完了報告を3行以内に短縮。必要な詳細のみ参照へ。 | a: tools/gate-remedies.md の同名節。秘密値不要 |
| `reported-symptom-gate` | Stop子 | 報告された障害を否定せず未再現/未照会と書く。不可視の証拠は具体的に依頼。 | a: tools/gate-remedies.md の同名節。秘密値不要 |
| `self-check-before-asking-guard` | Stop子 | 質問対象を既存のAPI/ファイル/CLIで調べ、取得済み情報を提示する。 | a: tools/gate-remedies.md の同名節。秘密値不要 |
| `settings-quality-guard` | 単独hook（標準登録外） | effortLevel を medium/high、model を既定監督モデルに戻す。 | a: tools/gate-remedies.md の同名節。秘密値不要 |
| `stop-gate` | Stop子 | 残作業を継続。人の判断が必要なときのみ具体的選択肢と根拠を提示。 | a: tools/gate-remedies.md の同名節。秘密値不要 |
| `stop-gate-runner` | Stop | 各子ゲートの理由に従って内容を修正し、必要な実行証拠を追加する。 | a: tools/gate-remedies.md の同名節。秘密値不要 |
| `url-account-gate` | Stop子 | URLに開くアカウント名を添える。既定と違う場合はシークレットウィンドウも指定。 | a: tools/gate-remedies.md の同名節。秘密値不要 |
| `url-format-guard` | Stop | URLをMarkdownリンクまたは空白で囲み、日本語/全角文字との直接隣接を除く。 | a: tools/gate-remedies.md の同名節。秘密値不要 |
| `user-burden-gate` | Stop子 | 手作業は自動化し、不可避なら1クリックの起動手段と確認方法を用意。 | a: tools/gate-remedies.md の同名節。秘密値不要 |
| `verify-before-done-detector` | Stop | 実行テストとread-backを行い [TESTED]、軽微で不要なら理由付き [NO-TEST-OK]。 | a: tools/gate-remedies.md の同名節。秘密値不要 |

名前にgate/guardがあっても対象外のもの: `cost-routing-gate`, `session-purpose-gate`, `makimono-gate`, `expensive-session-guard`, `fable-session-guard` は主にSessionStart/UserPromptSubmitの助言・文脈注入。`dirty-worktree-guard` は自動実行前の作業保護、`gemini-budget-guard` / `lib/executor-gate` はexecutorの予算制御、`keyserve-rotation-gate` は管理CLI、`install-handoff-gate` は登録ツール、`selftest-guards` は検証CLI。PreToolUse/Stopのdenyとは分けた。登録中の `pretooluse-codex-invocation`, `pretooluse-serial-investigation`, `session-claim-collision`, `pipe-stage-permissions`, `check-e2e-before-stop`, `purge-sessions` はこの基準commitで拒否を出さない。旧PowerShell版の警告hookはNode版へ収束させる。

## 4. 人に問い合わせるだけの案内の横断結果

基準 #667 HEAD に対して `git grep -n -E 'kim[[:space:]]*(に|へ)[[:space:]]*(確認|聞く|聞いて|訊|尋ね)|分からなければ.*kim' 4898dba -- '*.md' 'tools/*.mjs' 'tools/*.ps1'` を実行。テスト文字列を含め6行、うち実案内5行。SKILL.md内の該当は0。#667より前の方式Bの行は履歴調査で別途捕捉した。

| 基準ファイル:行 | 問題の用途 | 修正 |
|---|---|---|
| packages/feedback-gas/INSTALL.md:71 | 方式Aの中継URL | Script Propertiesを使える場合のみA。未認可なら方式Bと取得コマンドへ |
| rules-extracted/onboarding-setup-prompts.md:126 | 初期通知webhook | `node tools/onboarding-sync.mjs --keys-only --force` |
| tools/install-keyserve-enroll.ps1:88 | 応答形式異常時の稼働確認 | `node tools/keyserve-status.mjs --json` |
| tools/install-keyserve-enroll.ps1:90 | HTTP認証失敗時の稼働確認 | 同上 |
| tools/discord-autoreply.mjs:138 | 未知の事項の返答文 | 未確認を明示して判断事項として転送（このタスクから実際の転送はしていない） |
| tools/feedback-form-gate.test.mjs:238 | 旧案内を含まないことのassert | テスト用の負例として維持 |

禁止lintは全Markdown（SKILL含む）・toolsのmjs/ps1を対象に、同一段落に取得コマンドまたは宣言済みkeyserveキーが無い案内を失敗させる。負例用test/fixtureは除外。単なる担当者への言及や事実の未確認まで禁止しない。

## 5. deploy/writeの読取誤検知

| 判定元 | 確認した問題 | 修正/検証 |
|---|---|---|
| 80482d6:feedback-form-gate DEPLOY_PATTERNS | `clasp\s+deploy`等の末尾に境界がなく、clasp deployments / vercel deployments をdeployと解釈 | #667で\b追加。本PRの全ゲート共通corpusでも確認 |
| pretooluse-lane-guard → usage-stats.classifyBashCommand | 短い読取例外がcat/ls/git等に限られ、clasp deployments、vercel ls、gh pr view、rg --filesはother。block閾値で実測denyになり得る | 全体一致の読取分類を追加。連結・リダイレクト・置換を含むコマンドには適用しない |
| usage-stats.isReadOnlyToolUse | claspをサブコマンド無視で除外、pushを--dry-runでも除外 | 同じ読取分類で修正。これ自体は統計/助言経路 |
| internal-recipient-gmail-guard | GH_WRITEは既に\bがあり、gh pr viewは対象外 | corpusで維持 |
| live-artifact-read-gate | Gmail書込の限定matcher。一般deploy正規表現なし | corpusで維持 |

追加の「語境界欠落によるdeploy/write誤検知」はこの調査範囲では見当たらない。全37本に16コマンド×Bash/PowerShellを入力し、Stop子にはtool-only transcriptも渡す。空homeだけでなく実装レーンblock閾値・cost block・GAS未搭載のfixtureを使う。読取コマンドが通ることと、実際の書込/未搭載が引き続き止まることを別々に検査する。

## 6. 共通防止策・検証と未確認事項

A: 全37本にliteral `GATE_CONTRACT`。CIは独立探索で契約漏れ・repo-file不在・keyserve未宣言・同意理由欠落を失敗させる。実keyserveの認証付きPOSTは2026-10-09にHTTP 200。14ファイルのファイル名/キー名のみmanifestに記載。応答は取得PC向けであり、全PCの受領を証明するものではない。EXTRA_FEEDBACK以外の環境変数→ファイルの個別対応はAPI応答に無く未確認。

B: 禁止lintを追加し実案内5行を修正。C: GASの実テンプレート、Nextの実installer＋台帳、autopilotの推奨codex-do、session-closeの閉じ際、公開Docリンクをfixtureで再現。方式B・新規/既存PCのkeyserve配布は#667の回帰テストを維持。外部Google/Discord本番投稿をCIで行ったとは主張しない。

D: 共通corpusと複合書込の負例。E: register-hooksで新規/既存のPreToolUse・単独Stopを共通wrapperへ収束、集約Stopは各子結果へ適用。新ゲートはmanifestのdistributedAt/denyAfterと各PCの初回受領日時の両方で7日間warn。pilotHostsは `kim-PC` と正本 `fleet-pc-map.json` に実測記録のあるhostname（DESKTOP-2D0R4LI）。既存37本はlegacy denyのまま。未宣言/不正manifestはwarn。

F: PC名・ゲート名・remedy参照とavailable/missing/manualだけを既存notify-kimへ送る。全PC配布のcost-reporter通知経路を優先し、既存webhookをfallbackとして利用。各PCの個人Discord IDをkimのIDと取り違えてDMしない。理由本文・URL・鍵値・会話は送らない。gate×PC×UTC日で排他作成し1日1回、未達はローカル記録と診断コマンドを表示。通知不能のPCで配送成功を保証することはできず、全PCへの実配送は未確認。

G: keyserve remedy欠落時、SessionStartのprovisionKeysを関数として再利用し、制限時間付きで1回取得して判定を再実行する。元の搭載/権限条件が満たされない場合は取得成功だけで免除しない。H: ONBOARDING §1.14.xへ5行で追加。

残る確認: 各PCの稼働settings/同期先HEAD/初回受領日、Google/GitHubの各人認可、全PCの通報配送、keyserveのPC別応答差分。これらをリポやkim-PC単体の確認だけで「全フリート完了」と扱わない。
