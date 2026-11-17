# 組織指示字数ゲートの着手記録

- 担当: Codex / feat/org-instructions-char-gate
- 着手日: 2026-11-17
- 目的: 組織指示案の全体字数確認を Stop hook で強制する。
- 範囲: この作業ツリー内のゲート、補助 CLI、配布 manifest、修復手順、テスト。
- 制約: コミット・push、実環境への登録・配布は行わない。
- 状態: 実装済み。Linux Node の関連43テスト成功。Windows ネイティブ検証は WSL interop の socket エラーで未完了。
- Windows 実行試行: `C:/Program Files/nodejs/node.exe --test tools/org-instructions-char-gate.test.mjs` → exit 1、`WSL ERROR: UtilBindVsockAnyPort:307: socket failed 1`。cmd.exe 起動も同じエラー。
- 登録: 既存の Stop 集約への仮登録を専用 dispatcher 登録へ統一し、二重評価を回避。setup --converge 用検査と修復定義も追加。
