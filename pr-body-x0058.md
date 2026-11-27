# X-0058: Voder（VeriLoop-Governed Recurrence）— Rust検証層を持つAIコーディングハーネス

## 概要

AIニュース提案 [X-0058]: VeriLoop-Governed Recurrence (VGR) アーキテクチャを採用したコーディングエージェントVoderの解説と、オージャスト自社サイトコードへの検証適用ワークフローの提案。

- LLMが変更提案 → SHA-256でファイル・元内容・置換バイトに束縛 → 隔離サンドボックスで検証 → Rustガバナンス層が書込み承認（PASS/FAIL）
- SWE-bench Verified 85.20%（426/500）、Terminal-Bench 2.0 76.40%
- 既存のCI/Code Reviewを補完する新しい検証レイヤ

## 変更内容
- **docs/ai-news-x0058-voder-verified-coding-harness.md**: 提案文書（VGRアーキテクチャ解説・ベンチマーク・オージャスト適用シーン・初期実装ステップ・制約）

## 検証
- Voder公開リポジトリのREADME・技術報告に基づく実現可能性評価
- SWE-bench、Terminal-Bench、DeepSWEの公開スコアとの突合
- オージャスト既存ツールチェーンとの比較表による住み分け分析

🤖 Generated with [Claude Code](https://claude.com/claude-code)