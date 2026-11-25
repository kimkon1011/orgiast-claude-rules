# X-0010: Sonnet メイン + Opus アドバイザーでクォータ節約

## 概要

Claude Code のクォータ消費を最適化するため、日常作業は Sonnet（安価）で行い、重要な判断時のみ Opus（高価）をアドバイザーとして呼び出す構成。

## 実装物

### docs/
- `advisor-rule-snippet.md` (C2): Opus 助言の発動条件（大きな計画確定前 / 同一エラー再発時 / 完了宣言前）、禁止事項、Opus へ渡す文脈の最小形
- `advisor-launch.md` (C3): `--advisor` 対応時の起動コマンドと非対応時のフォールバック手順

### tools/
- `advisor-quota-compare.mjs`: usage 集計（aggregateUsage）、2構成比較（compareConfigs）、advisor 呼出回数カウント（countAdvisorCalls）
- `advisor-quota-compare.test.mjs`: 11 テスト

## 根本原因（過去の delivery 失敗）

- **事象**: `Worktree branch changed externally; no push attempted`
- **原因**: X-0010 のコミット (1d27650e) が `quota-sweep/20261107-1909-claude-mw6s2pm7` ブランチに載っていた。quota-sweep プロセスが外部から同ブランチを変更していたため、PR 作成時に「外部から変更された」エラーが発生。
- **修正**: main から独立したクリーンブランチ `auto/20261109-x0010-sonnet-advisor-opus` を作成し、X-0010 コミットのみ cherry-pick。PR #1745 を作成、旧 PR #1711 を close。

## 検証

- テスト 11/11 通過
- PR #1745 automerge ラベル付与済み
