# X-0073: Codex不要機能を--disableで除外しトークン節約

## 概要

Codex CLI 0.169.0 の system prompt にはブラウザ操作・画面操作・画像生成など多くの機能が初期有効で含まれている。オージャストのCodex用途（ブース自動化スクリプト生成・イベント資料制作）には不要なため、`--disable` で明示的に除外し、システムプロンプトの肥大化を防いでトークンを節約する。

## 変更内容

- `tools/codex-do.mjs`: `DISABLE_UNUSED_FEATURES` を追加し、`buildCodexExecArgs()` に組み込み
  - 除外する機能（10個）: `browser_use`, `browser_use_external`, `browser_use_full_cdp_access`, `computer_use`, `image_generation`, `in_app_browser`, `in_app_dictation`, `in_app_voice`, `sleep_tool`, `view_image`
  - 維持する機能: `shell_tool`, `plugins`, `code_mode_host`, `incremental_tools`, `goals`, `hooks`, `fast_mode`, `unified_exec`
- `tools/codex-do.test.mjs`: テスト期待値に `DISABLE_UNUSED_FEATURES` を反映
- `docs/ai-news-x0046-codex-feature-disable-token-save.md`: AIニュース提案書を新規作成

## 期待効果

- システムプロンプト約2,000〜5,000トークン削減（Codex起動のたびに節約）
- 不必要な機能のツール定義・使用例がプロンプトから消える
- プロンプトキャッシュのプレフィックスも短縮

## 検証

- `node --test tools/codex-do.test.mjs`: 全259件pass（変更前と同じ）
- `buildCodexExecArgs` の出力に `--disable` フラグが正しく含まれることをテストで確認
- 各フラグに空白が含まれず Windows の引数分割を壊さないことをテストで確認

🤖 Generated with [Claude Code](https://claude.com/claude-code)