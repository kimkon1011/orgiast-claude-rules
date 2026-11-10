# Claude Code キャッシュ効率化設定

> 2026-11-11 作成。X-0016 の設定ファイル実装詳細

---

## 1. `.claude/settings.json` 設定

### 1.1 Idle Compaction 無効化

```json
{
  "idleCompaction": false,
  "memory": {
    "enabled": true,
    "path": ".claude/memory"
  }
}
```

`idleCompaction` を `false` に設定することで:
- アイドル時の自動コンテキスト圧縮を防止
- 圧縮によるキャッシュ無効化を防止
- 必要な時は `/compact` コマンドで手動圧縮可能

### 1.2 設定反映方法

```bash
# グローバル設定
claude config set idleCompaction false

# プロジェクト設定（.claude/settings.json を直接編集）
```

---

## 2. 長期記憶フォルダ構成

```
.claude/memory/
├── MEMORY.md              # 索引（全ファイルへのポインタ）
├── user/                  # ユーザー情報
│   └── preferences.md     # 個人設定・好み
├── project/               # プロジェクト知識
│   ├── architecture.md    # アーキテクチャ決定
│   └── decisions.md       # 設計判断記録
├── feedback/              # 改善フィードバック
│   └── learning-log.md    # 学びの台帳
└── reference/             # 外部参照
    └── links.md           # URL・ドキュメント参照
```

### 2.1 各ファイルの役割

| ファイル | 内容 | 更新頻度 |
|---------|------|---------|
| `MEMORY.md` | 全ファイルへのリンク索引 | ファイル追加時 |
| `user/preferences.md` | ユーザーの作業スタイル・好み | 変更時 |
| `project/architecture.md` | アーキテクチャ上の重要な判断 | 設計変更時 |
| `project/decisions.md` | 設計判断（ADR） | 判断時 |
| `feedback/learning-log.md` | 改善点・注意事項 | 発生時 |
| `reference/links.md` | 外部リソース | 追加時 |

---

## 3. Daily.md スキル

### 3.1 スキル定義

`skills/daily-report/SKILL.md` に定義。
トリガー: `/daily` または `/daily-report`

### 3.2 出力先

```
outputs/daily/
├── 2026-11-09.md
├── 2026-11-10.md
└── 2026-11-11.md
```

### 3.3 自動実行

session-close フックに組み込むことで、セッション終了時に自動生成:

```json
{
  "hooks": {
    "SessionFinish": [
      {
        "command": "node tools/daily-report.mjs",
        "async": true,
        "timeout": 60
      }
    ]
  }
}
```

---

## 4. 並列 Worktree 運用

### 4.1 作成コマンド

```bash
# 案件別 worktree 作成
git worktree add ../worktree-client-a auto/client-a-booth-design
git worktree add ../worktree-client-b auto/client-b-booth-design

# 各 worktree で独立した Claude Code セッション
cd ../worktree-client-a && claude -p "案件Aの作業を開始"
cd ../worktree-client-b && claude -p "案件Bの作業を開始"
```

### 4.2 注意点

- 各 worktree の `.claude/settings.json` は元のリポジトリと独立
- CLAUDE.md は元リポジトリのものを参照（シンボリックリンク推奨）
- キャッシュはプロセス単位で独立 → 各 worktree 内でキャッシュ効率を最大化

---

## 5. CLAUDE.md への追記案

CLAUDE.md に以下の節を追加すると、全セッションで設定が意識される:

```markdown
## 🔴 キャッシュ効率（X-0016）

1. **Idle compaction は無効**: 意図しないコンテキスト圧縮を防止。
   必要な時は `/compact` で手動実行。
2. **長期記憶フォルダを活用**: `.claude/memory/` に判断・feedback を保存。
   AI が能動的に参照する。
3. **Daily.md で復帰コスト削減**: `/daily` で日報出力。
   キャッシュ切れ後のセッション再開時はまず日報を読む。
4. **並列 worktree**: 複数案件は独立 worktree で並列処理。
   キャッシュは worktree 単位で独立。
```
