# 着手記録
2026-11-02 Codex: comms-hub Drive公開のサイズ別タイムアウト、最大2回の再試行、日別20万文字分割と検証を担当。本番state既定を維持。push/PRなし。Git書込不可ならbundleを再作成。

## 検証結果
- Windows Node v24.22.2: `node --test tools/comms-hub-sync.test.mjs` 26/26成功、exitCode 0。
- Windowsで `node tools/comms-hub-sync.mjs --live` を1回実行。既定の `C:\Users\uers\.claude\comms-hub\state.json` を使用、exitCode 0、publishErrorなし。
- lastSuccess: gmail-kim / gmail-seisaku / discord / line / plaud は全て `2026-11-02T13:56:44.548Z`。tldv は未記録（null）。
- PowerShellパイプの日本語ログと初回の集計は文字コードが不正だったため、liveを再実行せず、Windows NodeでstateをUTF-8として読み直した。exitCodeは初回プロセスの記録、publishError/lastSuccessはstateが根拠。検証ログは reports/comms-hub-timeout/ 配下。
- 元Git領域のaddは `index.lock: Read-only file system` で終了128。別Git領域でコミットし、既存 `.work/comms-hub/comms-hub-sync.bundle` を同じ基点799f04f8で再作成。push/PRなし。
