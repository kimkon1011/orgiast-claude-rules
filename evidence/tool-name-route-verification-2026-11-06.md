# handoff-audit:tool-name-route 保留候補の検証および完了記録（2026-11-06）

## 概要
`~/.claude/handoff-audit-candidates.jsonl` に `reason: "tool-name-route"` として保留されていた候補について、`tools/handoff-audit-knowledge.json` の登録状況の確認と整理を行いました。

## 対象候補の検証結果

1. **パターン**: `ループ報告で外部状態を直接API照会せずに断定` (元 candidate route: `gh api`)
   - **検証結果**: `tools/handoff-audit-knowledge.json` (L296-302) に手渡し手順文として既に採用済み。
   - **採用経路**: 「ループ・自動進行の報告で、外部システム（GitHub の PR/CI/マージ状態、Drive のファイル、Vercel の本番、Gmail 等）の状態を、自分側のログや記憶だけで「完了した／無い／マージ済み」と断定しない。報告前に当ターンで直接照会して読み戻す。...」

2. **パターン**: `社内スタッフ宛の連絡` (元 candidate route: `チャット表示`)
   - **検証結果**: `tools/handoff-audit-knowledge.json` (L159-164) に手渡し手順文として既に採用済み。
   - **採用経路**: 「Gmail 下書きにしない。チャット本文に宛先/用件/本文を完成形で表示（kim はリモートデスクトップ/LINE/Discord で渡す）。...」

3. **パターン**: `Discord DM 送信を前提にした社内連絡` (元 candidate route: `チャットに本文`)
   - **検証結果**: `tools/handoff-audit-knowledge.json` (L165-170) に手渡し手順文として既に採用済み。
   - **採用経路**: 「2026-10-25 実測（HP）: Discord DM は Bot トークン不在で実送信できない... 社内連絡は宛先/用件/本文をチャット本文に完成形で表示する...」

## 実施した処置
- `~/.claude/handoff-audit-candidates.jsonl` から採用完了済みの `reason: "tool-name-route"` 候補 3 件を削除・更新し、残留件数を 0 件に更新。

## 自動テスト検証
- `node --test tools/handoff-audit-*.test.mjs` を実行し、133 / 133 テスト全件 PASS を確認。
