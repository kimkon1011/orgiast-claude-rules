# Workspace リンクのアカウント指定変更（2026-10-10）

実装済み・未コミット。外部への公開・GASデプロイ・共有設定変更・ブラウザ/API実走は実施していない。

## 新旧比較

| 項目 | 旧 | 新 |
|---|---|---|
| Workspace URL | ドメインパスだけでも通過、一部で authuser を省略 | 開く人のメールを authuser に必須指定。旧ドメインパスは拒否 |
| 本文 | URL内だけの指定でも通過 | URLの同じ行か直前に「<メール> で開いてください」。ゲートは指定どおり前後1行の一致を検査 |
| 他人宛 | authuser を付けない案内が存在 | 相手に共有したうえで相手のメールを URL・本文に指定 |
| Apps Script /home/ | 例外 | 素URL＋アカウント切替案内の例外を維持 |

既存クエリ・フラグメントを保持する共通URL生成関数を追加。番号・空値・重複authuser・メール不一致・URL内のメールによる本文チェックすり抜けを拒否する。全体宣言による従来の他サービスの判定は維持。

## 引数・運用上の変更

- gdoc-publish: `--authuser <開く人のメール>` が必須。
- gdoc-create / gdoc-update: `--authuser` → 明示した `--subject` → `GOOGLE_IMPERSONATE` の順で受け手を取得。従来の認証用固定アカウントを受け手の既定値には使わない。dry/check の既存用途は維持。
- drive-upload: `--authuser` を追加。省略時は既存の操作アカウント解決を使用。JSONに accountInstruction を追加。
- expense-leak-check: 既存の notifyKim 専用通知の受信者と同じメールを指定。汎用URL生成の既定値には使わない。
- GAS台帳: `args.authuser`、省略時は実行中ユーザーのメール。取得不能・不正なら明示指定を要求。通知本文・返却値にもアカウント案内を追加。
- GAS FeedbackRelay: Script Property `FEEDBACK_OPEN_EMAIL` に通知の受け手を設定し、対象シートをその相手へ共有する。未設定時は無指定URLを送らずエラー。旧 `FEEDBACK_WORKSPACE_DOMAIN` のドメイン指定は使用しない。INSTALLも更新済み。設定・デプロイ自体は未実施。
- ONBOARDING/テンプレート/詳細規約に nishi 指示原文と経緯を記載。無関係なブラウザプロファイル指定・手作業の規約は維持。
- 対象文書に生成物はなく、追跡済みの ONBOARDING.compressed.md / CLAUDE.md も無い。したがって対象に対応する --write / --check 生成処理は無し。

## 検証

| 実行 | 変更前 | 変更後 |
|---|---:|---:|
| 関連テスト（個別テスト件数、同一プロセスでimport） | 257件: 250成功 / 7失敗 | 275件: 268成功 / 7失敗 |
| 全 tools JS/MJSテスト（ファイル単位の集計） | 322件: 236成功 / 85失敗 / 1中断 | 324件: 239成功 / 84失敗 / 1中断 |

追加18件はすべて成功。関連テストの失敗名は変更前後で同じ。全スイートにも新しい失敗名なし。fleet-agent の既存失敗1件は変更後には再現せず、今回の修正による改善とは扱わない。

要求された `node --test tools/` は変更前後とも MODULE_NOT_FOUND（ディレクトリをモジュールとして解決）で1件失敗。このため全テストは次で実行した:

```sh
node --test --test-timeout=60000 $(rg --files tools -g '*.test.mjs' -g '*.test.js')
```

変更前は HEAD のアーカイブを /tmp/rules-original に展開して、そのディレクトリで同じコマンドを実行。両方とも gate-readonly.test.mjs が60秒でタイムアウト。他の既存失敗には spawnSync /usr/bin/node EPERM 等の実行環境制約を含む。失敗を成功扱いしていない。

GAS関連5テストファイルは5/5成功。gdoc-update / url-account-gate の構文チェック成功。git diff --check 成功。

検証ログ（この環境内）: /tmp/rules-original-full.log、/tmp/rules-final-full.log、/tmp/rules-related-original.log、/tmp/rules-related-current.log、/tmp/rules-gas.log。

## 旧形式が残る箇所と理由

リポジトリ全体を `docs\.google\.com/a/|/a/orgiast\.jp|authuser` で検索し、隠し設定ディレクトリも確認。旧形式の生成・推奨は残していない。

- CLAUDE.md.template、ONBOARDING.md、rules-extracted/url-and-handoff-format.md: 2026-10-10 の失敗経緯と旧形式の禁止。
- tools/url-account-gate.mjs: remedy内の禁止文。
- tools/url-account-gate.test.mjs: 旧形式・旧形式＋authuser の拒否テスト。
- tools/workspace-url.test.mjs: 旧形式から新形式への正規化テスト。
- tools/doc-link-drive-guard.test.mjs: remedyに旧形式が無いことを検証。
- tools/course-correction-gate.test.mjs: orgiast.jp.evil を拒否する既存の負例。
- tools/live-artifact-read-gate.test.mjs: 過去のURLもID抽出できる既存互換性テスト（提示の許可ではない）。

## 変更ファイル一覧（43ファイル、報告書を含む）

- `CLAUDE.md.template`
- `ONBOARDING.md`
- `README.md`
- `codex-task-feedback-nag-local.md`
- `docs/cloud-ledger-spec.md`
- `docs/fleet-liveness-sheet-spec.md`
- `gas/fleet-status-sheet/CloudLedger.gs`
- `gas/fleet-status-sheet/LedgerUnify.gs`
- `gas/fleet-status-sheet/LedgerUnifyLogic.gs`
- `packages/feedback-gas/INSTALL.md`
- `packages/feedback-gas/templates/FeedbackRelay.js`
- `reports/workspace-url-account-2026-10-10.md`
- `rules-extracted/discord-integration.md`
- `rules-extracted/drive-operations.md`
- `rules-extracted/gas-clasp-workflow.md`
- `rules-extracted/url-and-handoff-format.md`
- `rules/gas.md`
- `skills/design-deck/SKILL.md`
- `skills/design-deck/pipeline/README.md`
- `skills/gas-project-setup/SKILL.md`
- `tools/ai-cost-logic.test.mjs`
- `tools/cloud-ledger-logic.test.mjs`
- `tools/course-correction-gate.test.mjs`
- `tools/course-corrections.json`
- `tools/doc-link-drive-guard.mjs`
- `tools/doc-link-drive-guard.test.mjs`
- `tools/drive-upload.mjs`
- `tools/expense-leak-check.mjs`
- `tools/gas-workspace-url.test.mjs`
- `tools/gate-remedies.md`
- `tools/gdoc-create.mjs`
- `tools/gdoc-create.test.mjs`
- `tools/gdoc-publish.mjs`
- `tools/gdoc-publish.test.mjs`
- `tools/gdoc-update.mjs`
- `tools/handoff-info-guard.mjs`
- `tools/handoff-info-guard.test.mjs`
- `tools/ledger-unify-logic.test.mjs`
- `tools/lib/workspace-url.mjs`
- `tools/report-length-gate.mjs`
- `tools/url-account-gate.mjs`
- `tools/url-account-gate.test.mjs`
- `tools/workspace-url.test.mjs`
