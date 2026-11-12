# X-0028: Grok Bot + Muse 役割分担リサーチ

**ステータス**: ✅ リサーチ完了（2026-11-12）
**作成日**: 2026-11-12

## 概要

Grok Bot（xAI API / x_search）で毎朝8時 X 重要情報最大5件（重複除外・新規性重視）、Muse（llm-ask / Gemini Flash）で9時公式一次情報調査を設定する役割分担設計。オージャストの競合ブース動向・イベントトレンドリサーチに適用。

## 作成物

| ファイル | 説明 |
|---------|------|
| `docs/ai-news-x0028-grok-muse-role-sharing.md` | AIニュース提案書（設計編） |
| `pr-body.md` | PR 本文 |

## コスト見積もり

| レーン | API | 日額 | 月額（22営業日） |
|--------|-----|------|-----------------|
| Grok Bot（8時） | xAI API (grok-4.6 + x_search) | $0.40 | $8.80 |
| Muse（9時） | Gemini Flash / DeepSeek (llm-ask) | $0.01 | $0.20 |
| **合計** | | **$0.41** | **$9.00** |

## 実装フェーズ

| Phase | 内容 | 優先度 | 依存 |
|-------|------|--------|------|
| 0 | リサーチ完了（本セッション） | ✅ 完了 | — |
| 1 | config トピック追加 + x-ai-tips-collect 拡張 | 次セッション | — |
| 2 | daily-muse-research.mjs 作成 | Phase 1 後 | Phase 1 |
| 3 | 統合レポート・state管理・配送 | Phase 2 後 | Phase 2 |

## 関連タスク

| タスク | 関係 |
|--------|------|
| X-0014 | Grok Bot + Claude Code コーディング手順（Grok Botの基盤設計を流用） |
| X-0013 | 再現可能AIワークフロー（LLM委譲パターンを流用） |
| P-0306 | Muse Credential Handoff（将来の外部AI連携時に利用） |