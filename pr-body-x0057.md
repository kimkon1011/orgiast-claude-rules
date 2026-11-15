# X-0057: learn-taste デザイン修正学習スキルの導入

## 概要

emilkowalski/skills の learn-taste スキルをインストールし、AIニュース提案として文書化した。

## 変更内容

- `docs/ai-news-x0057-learn-taste-skill.md` — 新規作成
  - learn-taste スキルの概要・インストール手順・ワークフロー
  - オージャストでの活用シーン（価格表・フォーム・モバイル表示の修正再現性向上）
  - インストール結果・制約事項

## インストール実績

```bash
npx skills@latest add emilkowalski/skills --skill learn-taste
```

- 79エージェント検出 → 1スキル選択
- インストール先: `~/.claude/.agents/skills/learn-taste/`
- セキュリティ: Gen: Safe / Socket: 0 alerts / Snyk: Low Risk
- Claude Code, Codex, Gemini CLI, GitHub Copilot +15環境にsymlink済み

## 初回実行（別セッション必要）

learn-taste はスラッシュコマンド（`/learn-taste`）のため、対話セッションで以下を実行する必要がある:

```
/learn-taste look at my last 3 sessions too, I keep fixing the same things
```

その後、提案されたルールを確認し `write all` で承認する。

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)