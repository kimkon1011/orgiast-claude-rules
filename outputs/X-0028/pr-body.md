## 概要

AIニュース提案 [X-0028]: Grok Bot + Muse 役割分担リサーチ — Grok Bot に毎朝8時X重要情報最大5件、Muse に9時公式一次情報調査を設定する設計文書。

## 変更内容

- `docs/ai-news-x0028-grok-muse-role-sharing.md` — 役割分担設計書（現状分析 / アーキテクチャ / 詳細設計 / コスト見積もり / 実装フェーズ / 意思決定記録）
- `outputs/X-0028/README.md` — 出力ディレクトリ解説
- `outputs/X-0028/pr-body.md` — 本PR本文

## 設計のポイント

1. **Grok Bot レーン（8時）**: 既存 x-ai-tips-collect.mjs の設定拡張で実現。xAI API (grok-4.6 + x_search) で X の展示会・競合トレンド収集。最大5件、重複除外、likes 10+。日額 $0.40。
2. **Muse レーン（9時）**: llm-ask (Gemini Flash) 経由で公式一次情報（競合HPニュース・展示会協会・業界団体発表）を調査。日額 $0.01。
3. **統合**: クロスソース重複除去 / S/A/B 重要度分類 / 前日差分のみ報告。合計日額 $0.41、月額 $9.00。
4. **オージャスト適用**: 競合ブース動向・イベントトレンドリサーチに適用。Phase 1〜3 で段階的実装。

## 検証

- コスト見積もりは xAI API の実測単価（x-ai-tips-collect の運用実績）と Gemini Flash の公開料金表に基づく
- 既存ツール（x-ai-tips-collect / grok-bot-prompt-bridge / muse-handoff / llm-ask）との差分を分析済み
- ギャップ分析（§1.2）・意思決定記録（§7）を文書化

🤖 Generated with [Claude Code](https://claude.com/claude-code)