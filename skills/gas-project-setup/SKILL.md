---
name: gas-project-setup
description: 新規 GAS プロジェクトの立ち上げ標準手順（clasp + コマンドキュー全部入り、kim の手作業は setupOnce ▶実行 1クリックのみ）。「GAS 作って」「スプレッドシートに自動化を仕込んで」「Apps Script 新規」「シートにスクリプトをバインド」など新しい GAS プロジェクトを始める依頼が来たら必ずこのスキルを使う。既存 GAS の修正では不要（rules/gas.md が適用される）。
---

# GAS プロジェクト立ち上げ標準シーケンス

ゴール: **kim の手作業 = `setupOnce` の ▶実行 1クリックだけ**。retrofit 禁止 — キューは最初の push に含める。

## 1. ローカル準備
```
mkdir <project>-gas && cd <project>-gas
clasp create --type sheets --title "<名前>"   # 既存シートにバインドするなら --parentId <SHEET_ID>
```
`.clasp.json` を必ずリポジトリに残す（clasp 統一ルール）。

## 2. 初回 push に含める4点セット（省略禁止）
1. `Setup.gs` — `setupOnce()` 1つだけ。プロジェクト固有初期化（列追加・初回同期など「今すぐ走らせたい処理」も全部ここに畳む）+ `installCommandQueue()` 呼び出し
2. `_COMMANDS_()` ホワイトリスト（関数名→関数の明示 map。eval/動的呼び出し禁止）
3. `installCommandQueue()` / `processCommandQueue()` — `claude-<project>-cmds` フォルダ、Script Property `CMD_FOLDER_ID`、1分トリガー。processCommandQueue は **LockService.tryLock(0) + payload 読込直後 setTrashed** で並走防止
4. `appsscript.json` — `oauthScopes`: `spreadsheets`, `drive`, `script.scriptapp`（+必要なら `script.external_request`）、`executionApi.access: "MYSELF"`

実装テンプレの詳細: memory `feedback_gas_command_queue.md`（cmd/result の JSON 形式、セキュリティ、やってはいけない一覧）。

## 3. kim への依頼（1回だけ・4要素形式で）
- 直URL: `https://script.google.com/a/orgiast.jp/d/<SCRIPT_ID>/edit`（**/a/orgiast.jp/ 必須**）
- 対象 `.gs` ファイル（Setup.gs）を**先に開いてもらう**（関数プルダウンは開いているファイルの関数しか出ない）
- 選ぶ関数名: `setupOnce` → ▶実行 → OAuth「許可」
- 完了判定の見え方: 実行ログに `command queue installed` 等

## 4. 以降の実行（Claude 完結）
Drive MCP `create_file` で `cmd_<unique>.json` → 1分待ち → `read_file_content` で `result_*.txt`。動作検証は read-back まで（`/deploy-verify` skill）。

## 5. 機密値
API キー等は Script Properties へ。コマンド JSON に含めない。別プロジェクトの Vercel env からの自動注入経路は classifier に止められる（3回止められたら手動経路: memory `feedback_credential_injection_classifier_block.md`）。
