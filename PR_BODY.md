## 概要

clean-install CI で `setup.mjs --converge` が無言 `exit code 1` になる原因を特定するための診断ログを追加。bootstrap.ps1 の `$ErrorActionPreference='Continue' + 2>&1` では node の stderr が拾えず、原因特定が不可能だった。

## 変更内容

### tools/setup-diag.mjs （新規）
converge 経路の診断モジュール。`$RUNNER_TEMP` が設定されている CI 環境でのみアクティブになる。

- 各 converge ステップの開始・終了・経過ms を `<RUNNER_TEMP>/clean-install-logs/setup-steps.log` へ追記
- `execFileSync` 失敗時は `status` / `signal` / `stderr` 先頭500字を記録（秘密値は含めない）
- `process.on('exit', code)` で終了コードと最後に開始したステップ名を記録
- `process.on('unhandledRejection', ...)` で未処理の Promise reject を記録（本処理に影響させない）
- 書き込み失敗は握りつぶす（本処理に影響させない）

### tools/setup.mjs （変更）
converge 経路の各ステップに `diag.begin()` / `diag.end()` の開始終了マーカーを追加:

| ステップ | 内容 |
|---|---|
| `classifier-settings` | hook登録・allowルール同期 |
| `manifest-repair` | manifest 項目修復ループ |
| `playbooks` | 手作業手順配布 |
| `mobile-standby` | スマホ用待機タブ |
| `node-runtime-security` | Node.js ランタイムセキュリティ |
| `task-hidden-actions` | 隠しタスク検査 |
| `nightly-reload-vscode` | VS Code 夜間再起動 |
| `deadline-watch` | 期限台帳タスク |
| `emit` | 結果出力 |
| `beacon` | fleet ビーコン送信 |

各 try/catch 内で `execFileSync` の失敗詳細（`status`/`signal`/`stderr`）を診断ログへ記録するよう追加。

### tools/setup-diag.test.mjs （新規）
4 テスト:
1. `RUNNER_TEMP` 未設定 → no-op（ファイルを作らない）
2. `RUNNER_TEMP` 設定時 → ファイル作成
3. `begin/end` のログ追記確認
4. `execFileSyncFail` の詳細出力確認

## 検証

- `node --check tools/setup.mjs` → 構文エラーなし
- `node --test tools/setup-diag.test.mjs` → 4/4 pass
- 既存の setup-clean-install-regression.test.mjs → 全件 pass
- CI run の artifact `clean-install-logs` から `setup-steps.log` を回収して解析

## 効果

CI artifact に `setup-steps.log` が含まれるようになる。各ステップの所要時間と終了状態を確認することで、`[mobile-standby] RC接頭辞:` 出力の 約10秒後にどのステップで `exit code 1` になったかが特定できる。