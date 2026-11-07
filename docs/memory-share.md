# ナレッジの全社双方向同期（2026-11-06 改定）

全PC (auto-memory / playbooks / incident / 学びの台帳)
  ↓ （毎時および SessionEnd: tools/knowledge-upstream.mjs）
Google Drive 受付ハブ (`claude-common-rules/knowledge-inbox/<PC>-<account>/`)
  ↓ （kim-PC 毎時統合: tools/knowledge-merge.mjs）
Google Drive 正本 (`claude-common-rules/knowledge/`)
  ↓ （全PC 毎時および SessionStart: tools/onboarding-sync.mjs -> tools/memory-share.mjs）
各PC `~/.claude/shared-memory/` → CLAUDE.md の `@` 参照

## 概要
- 全PC・全アカウントで生まれたヒヤリハットや改善知見（feedback / project / reference memory, playbooks, incident, 学びの台帳）を、1時間ごとおよびセッション終了時に Google Drive の受付ハブへ差分送信します（`share: false` および `user` 型は除外、資格情報・顧客情報は除外門で排除）。
- kim-PC の統合ジョブ (`knowledge-merge.mjs`) が1時間ごとに受付ハブの新着を読み、同義項目の更新・呼称やパスの汎用化を行って Drive 正本 (`knowledge/`) へ統合します。3回以上の出現で PROMOTE 候補へ載せます。
- 各PCは 1時間ごとに Drive 正本から最新ナレッジを `~/.claude/shared-memory/` へ受信します（Drive API 直接取得優先、フォールバックとして memoryserve HTTP）。手元の新しいファイルを古い正本で上書きしないタイムスタンプガードを備えます。

## 検証コマンド（リポジトリ直下）:

```sh
node tools/knowledge-upstream.mjs --dry-run
node tools/knowledge-merge.mjs --dry-run
node tools/memory-share.mjs --install --json
node --test tools/knowledge-upstream.test.mjs tools/knowledge-merge.test.mjs
```

## 各コンポーネント
- `tools/knowledge-upstream.mjs`: 全PC・全アカウントで差分吸い上げ・Drive inbox 送信（定期タスク `OrgiastKnowledgeUpstream` 毎時:17）
- `tools/knowledge-merge.mjs`: kim-PC のみ実行、Drive inbox から Drive 正本への統合（定期タスク `OrgiastKnowledgeMerge` 毎時:42）
- `tools/memory-share.mjs`: Drive 正本からのダウンストリーム受信 (`installFromDriveMaster`)
