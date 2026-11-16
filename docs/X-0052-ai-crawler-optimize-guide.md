## X-0052: AIクローラー最適化 — 実装ガイド

> 対象: orgiast.jp / rebooth.co.jp
> 日付: 2026-11-15

### 概要

AIエージェント（ChatGPT, Perplexity, Claude, Gemini, Bing AI 等）がサイトを正確にクロール・解釈できるよう、以下の4点を実装する：

1. **AIクローラー検出ツール** (`tools/ai-crawler-detect.mjs`) — 22種類のAIクローラーをUser-Agentで分類し、ログ・nginx map生成
2. **Markdown配信パイプライン** (`tools/ai-markdown-gen.mjs`) — サイトコンテンツからAI可読なMarkdown版を生成
3. **llms.txt / ai.txt** — AIエージェント向けサイト概要と利用許諾
4. **自動テスト** — 人間/検索エンジンに影響しない6+6テスト

### 1. AIクローラー検出ツール

**ファイル**: `tools/ai-crawler-detect.mjs`

22種類のAIクローラーを3カテゴリで検出：

| カテゴリ | クローラー |
|----------|-----------|
| training | GPTBot, Google-Extended, CCBot, Claude-Web, Applebot, FacebookBot, CommonCrawl |
| inference | PerplexityBot, ChatGPT-User, Bard, BingAI, YouBot |
| scraping | Bytespider, AmazonBot, DataForSeoBot, Diffbot, Trendiction, SeekerBot, SemifyBot, MozBot, AhrefsBot, SemrushBot |

**使い方**:
```bash
# CLI: User-Agentから検出
node tools/ai-crawler-detect.mjs detect "Mozilla/5.0 (compatible; GPTBot 1.2;)"

# CLI: nginx map生成
node tools/ai-crawler-detect.mjs nginx outputs/ai-crawler-map.conf
```

**プログラム利用**:
```js
import { detectCrawler, classifyLog, logRequest, generateNginxMap } from './tools/ai-crawler-detect.mjs';

const r = detectCrawler(req.headers['user-agent']);
if (r.isAi) {
  logRequest(r, { remoteAddr: req.ip, path: req.path });
}
```

### 2. Markdown配信パイプライン

**ファイル**: `tools/ai-markdown-gen.mjs`

サイトコンテンツをJSONレジストリとして定義し、AIクローラー向けのクリーンなMarkdownを生成する。

**使い方**:
```bash
# Markdownファイル生成
node tools/ai-markdown-gen.mjs render tools/ai-markdown-registry.json outputs/ai-markdown/

# AI Sitemap生成
node tools/ai-markdown-gen.mjs sitemap tools/ai-markdown-registry.json outputs/ai-markdown/AI-MARKDOWN-SITEMAP.md https://www.orgiast.jp/ai-markdown

# llms.txt生成
node tools/ai-markdown-gen.mjs llms tools/ai-markdown-registry.json
```

**nginx設定スニペット**:
```bash
node tools/ai-markdown-gen.mjs middleware
```
→ AIクローラーにMarkdownを、人間にHTMLを配信する設定例を出力。

### 3. llms.txt / ai.txt

**配置**: サイトルート (`/llms.txt`, `/ai.txt`)

ロードバランサー・Webサーバーレベルで静的配信する。詳細は以下のいずれか：

- **WordPress子テーマ**: `functions.php` で動的生成（`tools/ai-markdown-gen.mjs llms registry.json` の出力を利用）
- **nginx**: `location = /llms.txt { alias ...; }` で静的ファイル配信
- **.htaccess**: RewriteRule で `wp-content/` 以下のファイルにリダイレクト

### 4. テスト

```bash
# AIクローラー検出テスト（6 tests）
node --test tools/ai-crawler-detect.test.mjs

# Markdown生成テスト（8 tests / 6 core）
node --test tools/ai-markdown-gen.test.mjs
```

テストは以下を検証：
- 既知のAIクローラーを正しく検出する
- 通常ブラウザを誤検出しない
- combined log format から正しく抽出する
- Markdown frontmatter / body が正しく生成される
- ファイル書き込み / sitemap / llms.txt が機能する

### デプロイ手順

1. WordPressサイトに `ai-markdown-gen.mjs` のレジストリからMarkdownを生成・アップロード
2. AIクローラー検出用のnginx map (`ai-crawler-map.conf`) をサーバーに設置
3. `llms.txt` / `ai.txt` をサイトルートに配置
4. robots.txt にAIクローラーのAllowを追加（`seo/robots-ai-optimized.txt` 参照）
5. テスト実行して動作確認

### 検証

```bash
# llms.txt
curl -s -o /dev/null -w "%{http_code}" https://www.orgiast.jp/llms.txt   # → 200

# AIクローラー用Markdown
curl -s -H "User-Agent: GPTBot/1.0" https://www.orgiast.jp/ai-markdown/index.md | head -5

# 通常ブラウザには影響なし（HTMLが返る）
curl -s -o /dev/null -w "%{http_code}" https://www.orgiast.jp/   # → 200
```

---

*本ガイドは 2026-11-15 時点の情報に基づきます。WordPress / nginx の環境に応じて適宜調整してください。*