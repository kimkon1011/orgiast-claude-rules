# X-0017: Notion共有メモリで複数AIへの再説明コストを削減

## 概要

Notion をハブとした共有メモリシステムで、Claude・Gemini・ChatGPT など複数AI間でスキル（手順書）とメモリ（過去仕様・判断・学び）を共有し、AIを切り替えるたびに同じ説明を繰り返すコストを削減する。

## 原理

```
Notion Database (SKILLS / MEMORIES)
    ↕ 同期（notion-skill-sync.mjs）
共有 Drive inbox (skills/ / cross-ai-memory/)
    ↕ pull/push
各AIのローカル環境（Claude: memory/ + skills/、Gemini: 同、ChatGPT: 同）
```

- **Notion は人間の編集インターフェース** — AI は Notion を直接読まない（60ページ読むのに20分超かかるため）
- **共有 Drive フォルダがバッファ** — Notion API キー未設定時もファイルベースで同期可能
- **各AIはローカルの skills/ + memory/ を読むだけ** — 高速・オフライン動作

## 成果物

| 成果物 | 説明 |
|---|---|
| `tools/notion-skill-sync.mjs` | Notion ↔ ローカル スキル/メモリ 同期ブリッジ |
| `tools/notion-skill-sync.test.mjs` | テスト（20 tests PASS） |
| `outputs/X-0017/` | 出力成果物 |

## コマンド一覧

```bash
# スキル同期
node tools/notion-skill-sync.mjs skill pull    # 共有 → ローカル skills/
node tools/notion-skill-sync.mjs skill push    # ローカル skills/ → 共有

# メモリ同期
node tools/notion-skill-sync.mjs memory pull   # 共有メモリ → ローカル memory/
node tools/notion-skill-sync.mjs memory push   # ローカル memory/ → 共有メモリ

# スキーマ出力
node tools/notion-skill-sync.mjs schema        # Notion Database 定義

# PII バリデーション
node tools/notion-skill-sync.mjs validate <file>
```

## Notion Database スキーマ

### SKILLS（AIスキル／手順書）

| プロパティ | 型 | 説明 |
|---|---|---|
| `Name` | title | スキル名（skills/\<name\>/SKILL.md の name） |
| `Description` | rich_text | 1行説明（frontmatter description） |
| `Category` | select | booth-design / seo / gas / automation / communication / research / other |
| `Body` | markdown | スキル本文 |
| `AI-Platform` | multi_select | claude / gemini / chatgpt / copilot |
| `LastSynced` | date | 最終同期日時 |
| `Version` | number | バージョン |
| `NeedsReview` | checkbox | 週次レビュー待ち |
| `Source` | select | human / claude / gemini / chatgpt / copilot |

### MEMORIES（共有メモリ）

| プロパティ | 型 | 説明 |
|---|---|---|
| `Title` | title | メモリタイトル |
| `Type` | select | user / feedback / project / reference |
| `Body` | markdown | メモリ本文 |
| `Source` | select | human / claude / gemini / chatgpt / copilot |
| `Created` | date | 作成日 |
| `NeedsReview` | checkbox | 週次レビュー待ち（AI生成は初期 true） |
| `Tags` | multi_select | タグ |

## セキュリティルール

- **個人情報・マイナンバー・パスポート番号** を Body に直接書かない
- **顧客案件ID（C0xxx）** は抽象化して記述（例: `C0056` → `某建設機械メーカー`）
- **API キー・シークレット** は Script Properties や secrets 経由で参照
- **AI生成メモリは NeedsReview: true** でマーク → 週次レビューで人が確認

## 週次レビューワークフロー

1. `NeedsReview: true` のレコードを Notion でフィルタ
2. 内容の正確性・PII不在・重複を人間が確認
3. 承認 → `NeedsReview: false` に設定
4. 却下 → 削除または修正を依頼
5. 恒久ルールに昇格すべき内容は CLAUDE.md または rules/ へ移行

## PII 検出パターン

| パターン | 検出名 |
|---|---|
| マイナンバー・個人番号・基礎年金番号 | 個人識別番号 |
| パスポート・旅券番号 | パスポート番号 |
| C0xxx 形式の案件ID | 案件ID |
| 株式会社・有限会社・合同会社 | 法人名 |
| Apps Script ID（URL） | Apps Script ID |
| API キーパターン（AIza... / sk-...） | API キー |

## テスト

```bash
node --test tools/notion-skill-sync.test.mjs
# 20 tests pass / 0 fail
```

## 前提条件

- **Notion API キー未設定時**: 共有 Drive フォルダ（knowledge-inbox 配下）を経由したファイルベース同期
- **Notion API キー設定時**: `NOTION_API_KEY` 環境変数 + 該当 Database を共有 → 直接读写

## 既存連携

- `tools/knowledge-upstream.mjs` — ローカル memory/ → Drive inbox への自動吸い上げ（全PC毎時）
- `tools/memory-share.mjs` — セッション間メモリ共有
- `tools/portable-knowhow-push.mjs` — ポータブルノウハウ同期
- `skills/share-knowledge/` — ノウハウの上り投稿スキル