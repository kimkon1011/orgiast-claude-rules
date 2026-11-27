# X-0017: Notion共有メモリで複数AIへの再説明コストを削減

**AIニュース提案 X-0017**: Notion をハブとした共有メモリで、Claude・Gemini・ChatGPT 間の再説明コストを削減する。

## 課題

- 展示会ブース制作の手順書を Claude に覚えさせても、Gemini や ChatGPT で同じ作業をしようとすると 1から説明が必要
- AI ごとに別個に蓄積された記憶は重複メンテナンスになり、バラつきも生む
- 同じことを複数AIに何度も説明する時間的・精神的コストが無視できない

## 解決策: Notion 共有メモリ

### アーキテクチャ

```
[Notion Database]
  ├─ SKILLS（手順書）
  │   Name | Description | Body | Category | AI-Platform | NeedsReview
  └─ MEMORIES（記憶）
      Title | Type | Body | Source | NeedsReview | Tags

       ↕ notion-skill-sync.mjs（同期ブリッジ）

[共有 Drive folder] ← PII フィルタ通過
  ├─ skills/<name>/SKILL.md
  └─ cross-ai-memory/<name>.md

       ↕ pull / push

[各AI ローカル]
  Claude:  skills/ + memory/
  Gemini:  skills/ + memory/（同じ Drive 経由）
  ChatGPT: skills/ + memory/（同じ Drive 経由）
```

### 1. 手順書はスキルに保存

- 展示会ブース制作の各工程（キーワードリサーチ・パース生成・提案書作成など）は `skills/<name>/SKILL.md` に記述
- Notion SKILLS Database と同期し、人間は Notion で編集、AI はローカル skills/ を読む
- Claude・Gemini・ChatGPT のすべてが同じ手順書を参照できる

### 2. 仕様・記憶はメモリに保存

- 過去のブース仕様（サイズ・テイスト・クライアント好みなど）は `memory/<name>.md` に保存
- Notion MEMORIES Database と双方向同期
- AI が新しい記憶を書き足すと自動的に共有 → 他の AI も利用可能に

### 3. 個人情報は Notion に置かない

- PII 検出パターンが共有前にチェック（マイナンバー・案件ID・法人名・APIキー）
- PII を含むメモリ/スキルは同期をブロックし、エラー報告
- 顧客名は抽象化（例: `C0056` → `某建設機械メーカー`）

### 4. AIが書き足した記憶は週1で人が見直す

- AI が生成したメモリは `NeedsReview: true` でマーク
- 週次レビューで人間が正確性・PII不在・重複を確認
- 承認 → NeedsReview 解除 / 却下 → 削除・修正
- 恒久ルールに昇格すべき内容は CLAUDE.md または rules/ へ移行

## 使い方

### 初回セットアップ

```bash
# 1. Notion に SKILLS / MEMORIES Database を作成
node tools/notion-skill-sync.mjs schema --format notion
# → 出力を Notion API で createDatabase に使う

# 2. 既存 skills/ を共有インボックスへ初回プッシュ
node tools/notion-skill-sync.mjs skill push --inbox <Drive-path>

# 3. 全AIで同じ共有先を参照するよう設定
#    NOTION_SYNC_INBOX 環境変数に共有インボックスパス
```

### 日常運用

```bash
# 新しいスキルを作ったら共有
node tools/notion-skill-sync.mjs skill push

# 他のAIが更新したスキルを受け取る
node tools/notion-skill-sync.mjs skill pull

# セッション終了時にメモリを共有
node tools/notion-skill-sync.mjs memory push --source claude

# セッション開始時に共有メモリを受信
node tools/notion-skill-sync.mjs memory pull
```

### 自動化（既存システムとの統合）

既存の `knowledge-upstream.mjs`（全PC毎時実行）が Drive inbox へ自動送信する仕組みと統合：
- `knowledge-upstream.mjs` が送ったメモリを、`notion-skill-sync.mjs memory pull` で他のAIが受信
- 各AIの `SessionEnd` hook で `memory push --source <ai-name>` を呼ぶと自動共有

## コスト試算

| 項目 | 現状 | 導入後 | 削減 |
|------|------|--------|------|
| AI 切替時の再説明時間（月20回×3分） | 60分/月 | 5分/月 | −92% |
| 手順書の重複メンテナンス（月2時間） | 120分/月 | 20分/月 | −83% |
| 記憶のバラつき修正（月1時間） | 60分/月 | 10分/月 | −83% |
| **合計** | **240分/月** | **35分/月** | **−85%** |

## 適用：オージャストの展示会ブース制作

具体的な適用フロー：

1. **手順書のスキル化**: `skills/design-deck/`, `skills/booth-kw-research/`, `skills/rebooth-customer-interview/` を Notion SKILLS に登録 → 全AIで共有
2. **過去ブース仕様のメモリ化**: 各案件の仕様（サイズ・予算・テイスト・クライアントフィードバック）を `memory/` に保存 → 共有 → 次回提案の参考に
3. **複数AI同時作業**: パース生成（Gemini）・提案書作成（Claude）・キーワードリサーチ（ChatGPT）を並行実行 → 同じメモリを参照
4. **週次レビュー**: 毎週月曜朝、Notion の `NeedsReview: true` レコードを kim が確認

## 関連

- `outputs/X-0017/README.md` — 実装詳細・スキーマ定義
- `tools/notion-skill-sync.mjs` — 実装
- `tools/notion-skill-sync.test.mjs` — テスト（20 PASS）
- `docs/ai-ops-playbook.md §27` — 「Notionは60ページ読むのに20分超、ファイル化すれば一瞬」の根拠
- `rules/ai-ops-playbook.md` — AI運用プレイブック
- `skills/share-knowledge/SKILL.md` — ノウハウ共有スキル