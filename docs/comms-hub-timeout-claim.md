# 着手記録
2026-11-02 Codex: comms-hub Drive公開のサイズ別タイムアウト、最大2回の再試行、日別20万文字分割と検証を担当。本番state既定を維持。push/PRなし。Git書込不可ならbundleを再作成。

## 検証結果
- Windows Node v24.22.2: `node --test tools/comms-hub-sync.test.mjs` 26/26成功、exitCode 0。
- Windowsで `node tools/comms-hub-sync.mjs --live` を1回実行。既定の `C:\Users\uers\.claude\comms-hub\state.json` を使用、exitCode 0、publishErrorなし。
- lastSuccess: gmail-kim / gmail-seisaku / discord / line / plaud は全て `2026-11-02T13:56:44.548Z`。tldv は未記録（null）。
- PowerShellパイプの日本語ログと初回の集計は文字コードが不正だったため、liveを再実行せず、Windows NodeでstateをUTF-8として読み直した。exitCodeは初回プロセスの記録、publishError/lastSuccessはstateが根拠。検証ログは reports/comms-hub-timeout/ 配下。
- 元Git領域のaddは `index.lock: Read-only file system` で終了128。別Git領域でコミットし、既存 `.work/comms-hub/comms-hub-sync.bundle` を同じ基点799f04f8で再作成。push/PRなし。

2026-11-03 Codex 着手: Gmail部分保存・5並列取得、全体8分予算、登録15分、Windows検証。push/PRなし。

## Gmail時間予算の検証（2026-11-03）
- 原因: gmail-searchが最大25件をfull形式で直列取得し、途中例外でページ全体を破棄。
- 修正: metadataから必要な本文だけ最大5並列取得、1件ずつ永続化。残件IDと次ページをカーソルに保持。取得はソース上限の5秒前までとし、保存の余裕を確保。
- 全体8分、最後2分はDrive用。残ソースと未公開内容を次回に回し、予算到達時はexit 0。登録とEnsure/read-backは15分。
- Windows指定テスト32件成功。Gmail共用関数・schedule-sync回帰テスト55件も成功。
- 本番stateでliveを1回実行: 60,147ms、exitCode 0。Gmail両方・Discord・LINE・Plaud・tl;dvすべてlastSuccess=2026-11-02T15:31:53.383Z（JST 11/03 00:31:53）、error=null。publishError=null。
- 登録スクリプトの変更のみで、Windowsタスク自体の再登録は未実施（同期mainからの実行を維持）。
- 元Git領域へのaddはindex.lock: Read-only file systemで失敗。指定の.work/comms-hub/hub-gmail.bundleにコミットを保存。push/PRなし。
