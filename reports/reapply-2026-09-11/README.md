# 2026-09-11実装再調査・再適用（2026-09-22）

## 履歴

- `git log --all --oneline -- tools/settings-quality-guard.mjs` と `-S normalizeSessionSettings`（reflog含む）を調査。指定のmodel正規化コミットは見つからず、新規実装した。消失原因を確定できる証拠はない。
- mobile履歴に `74cc2e5`（Remote Control再開）と `e2b3484`（再開の堅牢化）が残っていた。`git branch -a --contains` は両方とも `origin/fix/rc-resume-after-reload` のみ。対応する [PR #358](https://github.com/kimkon1011/orgiast-claude-rules/pull/358) はOPEN、mergedAt=null。関連変更がmainに届いていない理由は未マージ。ただし両コミットとも既定3本のままで、今回指定の待機1本・使用後補充とは異なるためcherry-pickせず実装した。
- 現行の元実装 `8e97384`（PR #338）はmainに含まれる。作業開始時のHEADは別作業の `feat/stall-sweeper`。その変更や未コミットのclaude-cost-reporterは今回のPRに含めない。

## 実装

- SessionStartでmodel未設定・fable（大小無視）・`[1m]`をopusへ正規化。変更時だけ1行。逃げ道は `CLAUDE_MODEL_GUARD_ALLOW=1` のみ。既存effortLevel保護は維持。
- mobile既定待機1本、JSON/envで変更。CLIだけでなく実際に起動するVS Code拡張に使用後・閉鎖後の補充を実装。自然な空タイトルから使用開始を検知、同時呼出しとウィンドウ間を排他化。応答未確認の起動を重ねない。`claude-mobile`のサーバーやタスクは変更しない。
- nightlyの誤名は実装本体でなく `tools/nightly-health-expectations.json` に存在。`OrgiastBoothFeedbackIntake`へ修正。Windows登録一覧との照合は参照6種類すべて一致（修正前は1件不一致）。

## 検証

| テスト対象 | pass | fail |
|---|---:|---:|
| settings-quality-guard | 13 | 0 |
| mobile-sessions | 5 | 0 |
| nightly-health | 39 | 0 |
| nightly-health-remediate | 11 | 0 |
| 拡張route | 8 | 0 |
| 拡張mobile-pool | 6 | 0 |
| 拡張イベント結合 | 1 | 0 |
| 拡張shell-path | 2 | 0 |
| next-session-launch | 69 | 0 |
| tools配布境界 | 2 | 0 |
| 合計 | 156 | 0 |

`node --test`で各ファイルを実行。VSIX 0.3.4は同梱JS・package.jsonとソースのバイト一致も検証。`git diff --check`は対象ファイルで成功。VS Code実機への新版インストール・実スマホからの使用開始は未検証。

一時homeのsettings.jsonに対し `node tools/settings-quality-guard.mjs --mode sessionstart` を実行:

| 入力model | 結果 | stdout | exit |
|---|---|---|---:|
| fable | opus | `[settings-guard] model: fable → opus` | 0 |
| opus[1m] | opus | `[settings-guard] model: opus[1m] → opus` | 0 |
| 未設定 | opus | `[settings-guard] model: 未設定 → opus` | 0 |
| opus | opus | 無出力 | 0 |

実行したdry-run（Windows側homeを明示、状態ファイルを捏造せず実行）:

```text
ORGIAST_HOME=/mnt/c/Users/uers node tools/mobile-sessions.mjs --dry-run
[mobile-sessions] 現在の待機数: 不明（拡張の状態未取得・期限切れ） / 目標: 1 / 起動する本数: 不明 (dry-run: 起動なし)
```

既存インストール版0.3.3には新しい状態出力がないため実機本数は未取得。数値表示・無起動は一時homeの状態ファイルでテストし、1本待機/目標2/追加1を確認した。新VSIX導入後に実機の数値を取得できる。

`verify-nightly.mjs` は実タスク情報と実ログの一時コピーで修正前後を実行（他のヘルス対象は除外、通知・再起動・実homeへの書込なし）:

| 参照名 | 実タスク取得 | nightly結果 |
|---|---|---|
| OrgiastBoothFeedback | 失敗: CmdletizationQuery_NotFound_TaskName | 同期例外で失敗（CLI相当exit 1） |
| OrgiastBoothFeedbackIntake | 成功: Running | exit 0、異常0 |

単なる警告だけでなく、旧名で生じる同期例外が `.catch()` の外へ出る実際の失敗を確認した。修正後はこの失敗が消えた。全ジョブの実機健全性を証明する検証ではない。

## 保存・反映範囲

成果は `/mnt/c/Users/uers/orgiast-main` のworking treeへ直接保存した。`.git`の実体は書込禁止で `git switch -c feat/reapply-2026-09-11` がread-onlyエラーになったため、ローカルcommit/pushは使えない。GitHub APIでmainを親にしたcommitと指定ブランチを作り、PRとして永続化する。隔離リポジトリ・bundle・成果の/tmp退避は使わない。

もう一方の `/mnt/c/Users/uers/orgiast-claude-rules` は書込許可範囲外のため、直接同期できない。同一リポジトリの修正をPRで提供する。実機拡張の新版導入と両ツリーへの反映は未実施。新しいhookは追加しておらずsettings登録も変更していない。PRはマージしない（自動マージ事故防止のためDraft、automergeラベルなし）。

## CI切り分け

初回PR CIでtoolsからpackagesへのimportが配布境界テストに違反したため修正した。CLI共通読取部はtools/libへ置き、独立配布されるVSIXにも同じ内容を収録。両者の一致をテストする。
もう1件の `usage-stats: parse cache hits unchanged files and reparses size/mtime changes` は親main（1a1dc353）の [CI](https://github.com/kimkon1011/orgiast-claude-rules/actions/runs/35675364817) でも同じ失敗を確認した。変更対象外の既存失敗。Windows/POSIXのguard・構文チェックは初回PR CIで成功。
