# スキル実装順（2026-10-31）

<!-- lane: auto -->

## 目的
rules repo（本リポジトリ）へ 5 件のスキル/playbook 変更を実装する。正本: `~/.claude/skill-and-loop-redesign-20261028.md` §1。実測データに基づく定型化であり、一般論で書かない。

## 完了条件
1. 下記 5 件がすべて実装済み
2. 追加・変更は既存の実測内容を壊さない（既存 playbook の実測節は保持）
3. `node --test tools/skills/*.test.mjs`・`node --test tools/*.test.mjs` が緑（既存テストに影響なし）
4. commit は 1 件 = 1 commit で、ファイルをパス指定で add（`git add -A` 禁止）

## 実装対象（本リポジトリ = C:/Users/user/.claude/auto-session-repo）

既存 SKILL.md の書式に合わせる（frontmatter: name / description。description に「〜の合図が来たら必ず使う」のトリガー語。本文は # 見出し＋実測ベース）。playbook は先頭行に `aliases: [..]` を置く。

### 件1: skills/session-start/SKILL.md 強化
既存ファイルを編集する。変更点は2つ:
- **手順2「目的を1件に確定する」の候補源の先頭に business-goals.md を追加**: 候補を集める前に `~/.claude/business-goals.md` を必ず読み、その「売上・利益レバー（上から優先）」の未完了レバー 1 件を候補の **1 番目**に出す。既存の候補源（next-session.md / session-handoffs / memory / promotion-queue）は 2 番目以降。基盤・ツール系の残TODOは、レバーを止めているブロッカーか期限付きの効果確認だけを候補に出す。
- **候補が 1 件に絞れる時は AskUserQuestion せずに着手する**: フィルタ（session-claims --filter）を通した後の候補が 1 件だけなら質問を省略し、着手宣言に「違えば言ってください」の 1 言を添えて進める。複数ある時だけ従来どおり AskUserQuestion。
既存の手順 0（イベント百貨店）・1・1.5・3〜5・注意は変更しない。

### 件2: skills/handoff-report/SKILL.md 新規
完了報告・手渡し・classifier 拒否の報告を、Stop ゲート全項目つきで**最初から**書く型にする skill。
- 発動トリガー語（description）: 「完了しました」「やったよ」「手渡し」「引き継ぎ」「やっておいて」「報告」などの完了報告・手渡し・classifier 拒否の報告を書く直前（description に「〜の合図・報告を書く前に必ず使う」と書く）
- 本文に含める（実測ベース・gate-remedies.md の該当項目を参照）:
  1. 3行フッター（やったこと / 検証したこと / 残ったこと）を最初に書く
  2. 依頼範囲の全要素 × 実データの検証表（要素ごとに実行コマンド・出力・日時）
  3. 恒久策の明記（初回だけの作業は「恒久策: 一回限り: <理由>」）
  4. 「次に kim がすること」は人が一度だけ実行できる具体的手順（参照させない・ラベルで指さない）
  5. 外部状態の主張（入力しました等）は読み戻し証拠つき `[CLAIM-EVIDENCE: ..]`
  6. 否定・未達の断定は直接照会のみ。未照会は「未確認」
  7. classifier 拒否の報告は 1 行で済ませ、言い換え再試行しない（gate-remedies.md の該当節を参照）
- 参照: `tools/gate-remedies.md`（各 deny ゲートの復旧理由）、ONBOARDING §1.1。gate 名は実在のものだけ書く。
- 長すぎないこと（コア 3KB 前後を目安、各節は要点のみ・詳細は gate-remedies.md へ丸投げ）

### 件3: playbooks/GitHub CLI.md 新規（pr-land 追記）
`~/.claude/playbooks/GitHub CLI.md`（この PC にある実測 playbook。リポジトリ未収録）の内容をリポジトリ `playbooks/GitHub CLI.md` として追加し、**pr-land 節を追記**する。
- 既存内容（認証・GH_TOKEN・復旧手順・スコープ表）は保持する。ただし「このPC（DESKTOP-BDOAK99）」「genbateamtoho-ctrl」等の PC 固有記述は、全PC共通の表現に直してよい（対象 PC 名は書かず「このPCの実測」等にする）。出典セッション ID は保持。
- frontmatter 先頭行: `aliases: gh, GitHub, github-cli, gh auth, pr-land, automerge`
- 追記する pr-land 節の内容（実測ベース）:
  1. PR の着地は `gh pr edit <PR番号> --add-label automerge`（CI 緑で GitHub が自動 squash マージ。ポーリング不要）
  2. automerge ラベルを付けられない場合のみ `gh pr merge <PR番号> --squash`（事前に `gh pr checks <番号>` が全 green・スコープ内・非破壊を確認）
  3. マージ確認は `node tools/commit-landed.mjs <sha>`（`git merge-base --is-ancestor` は squash を見落とす。使わない）
  4. gh が無い PC では `where gh` で確認し、無ければ PR 前提の文面を書かない
  5. ラベルが付けられない環境（= push/PR/merge 禁止レーン）では PR を作らず、その制約を報告する
- `tools/pr-merge.mjs <PR番号>` が既存ツールとしてある。参照: `tools/commit-landed.mjs`

### 件4: playbooks/desktop-launcher.md + playbooks/codex-delegate.md + playbooks/secrets-env.md 新規（aliases 付き）
3 本の playbook を追加する。それぞれ先頭行に aliases、本文は実測ベース。

**playbooks/desktop-launcher.md**
- aliases: `desktop-launcher, make-desktop-launcher, ダブルクリック, デスクトップファイル`
- 内容: `node tools/make-desktop-launcher.mjs <name> (--ps-file <abs.ps1> | --command-file <abs.txt>) [--verify-cmd <pwsh>]` の使い方。作成結果（cmdPath の表示）・実行後の成否表示（Exit code/OK/ERROR が出る）・`--remove` での片付け。user の操作が 2 つ以上残る時はこれを 1 個に畳む（ONBOARDING l.466/l.498 参照）。verify-cmd で自動検証を組み込む。

**playbooks/codex-delegate.md**
- aliases: `codex-do, codex, 実装して, 委譲, Codex`
- 内容: `node tools/codex-do.mjs --prompt-file <指示> --cwd <対象> --origin unattended [--timeout <秒>]` の起動・待機・結果回収・Windows 再検証の定型。
  - 指示はファイルで渡す（`--prompt-file`）。argv 直渡し・shell 経由・TTY なし・パイプなし
  - 終了コード 75 = deferred（上限中）。`retryAt` 以降まで再試行しない
  - WSL でテストが pass しても Windows で `node --test` を再実行して確認する
  - 監督は設計・レビュー・検証だけ。実装は Codex へ
  - 参照: ONBOARDING §1.18（l.1003-1039 付近）、tools/codex-do.mjs の usage

**playbooks/secrets-env.md**
- aliases: `APIキー, 環境変数, env, keyserve, Vercel, secret, 鍵, キー`
- 内容: 鍵の所在検索 → Vercel env 登録 → 読み戻しの定型（ONBOARDING §AUTOMATION-FIRST 参照）。
  - 検索順: (1) `node tools/keyserve-status.mjs`（keyserve） (2) `node tools/env-kv.mjs`（env ファイル） (3) production bundle の公開設定値 (4) 専用ツール経由の自動設定のみ。`gh secret set` / `.env.local` 直書き / transcript grep はしない（classifier の Credential 系で止まる）
  - 登録: Vercel は `vercel env add <KEY> <env>`（`vercel env pull` 通っても `vercel env add` が拒否され得る。読み書きは別判定）
  - 読み戻し: 登録後に `vercel env ls` か対象アプリの env 取得で値が入ったことを実測確認
  - 秘匿値そのものは書かない

### 件5: skills/global-rule-rollout/SKILL.md 新規
「全 PC・全アカウントに適用して」の依頼への標準手順 skill。
- 発動トリガー語（description）: 「全パソコン」「全アカウント」「全プロジェクト」「全PC」「全てのPCで」「全部に適用」「rollout」等
- 本文:
  1. 既実装の確認（重複調査をしない）: 対象ルール・ゲートが rules repo / memory / share-knowledge / rules-sync で 既に PR・配布済みかをまず調べ、済んでいれば「✅ 反映済み」と根拠（PR番号・配布日）を出して終える
  2. 未実装なら: 変更を rules repo へ PR（ゲート・ルールはレビュー必需。`workflow`/keyserve/secrets/fleet に触る変更は label を付けず PR 冒頭に手動マージが必要な理由を書く）
  3. 配布確認: `node tools/rules-sync.mjs pull` 相当で各 PC の同期状態を確認し、取り込み待ちは「取り込み予定日」を書く
  4. 1 セッションで同じ文面を受け取ったら、前セッションの結果（PR番号・状態）を参照して重複調査しない
- 専用 skill（share-knowledge・rules-sync）とは別物。参照: skills/rules-sync/SKILL.md、ONBOARDING §3.0（自動取込・巡回）

## 実装順序と commit
1. 件1 を編集 → commit（メッセージ: `feat(session-start): business-goals.md を候補1番目・候補1件なら質問せず着手`）
2. 件2 を作成 → commit（`feat(skills): handoff-report skill 新規`）
3. 件3 を作成 → commit（`feat(playbooks): GitHub CLI playbook に pr-land 追記`）
4. 件4 を 3 本作成 → commit（`feat(playbooks): desktop-launcher/codex-delegate/secrets-env 新規（aliases 付き）`）
5. 件5 を作成 → commit（`feat(skills): global-rule-rollout skill 新規`）
6. `node --test tools/*.test.mjs` を実行し緑を確認

## 禁止事項
- `git add -A` / `git commit -a` / `git stash` / `git checkout -- .`（他セッションと作業ツリーを共有）
- push / PR / merge（監督が行う）
- 秘匿値の記載
- 既存ファイルの実測節・出典セッションIDの削除（件1・件3の既存部分）
- `git config user.name` 等の変更（genbateam-teho 相当の既存コミットユーザーを維持）