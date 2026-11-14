# X-0053: llms.txt / ai.txt WordPress デプロイガイド

> 対象サイト: https://www.orgiast.jp
> 対象ファイル: `llms.txt`, `ai.txt`
> 日付: 2026-11-15

## デプロイ方法

WordPress サイトのルートに静的なテキストファイルを設置する必要があります。

### 方法A: 子テーマの functions.php で動的生成（推奨）

```php
// X-0053: llms.txt 動的生成 — AIエージェント向けサイト情報
add_action('init', function() {
    if (isset($_SERVER['REQUEST_URI']) && $_SERVER['REQUEST_URI'] === '/llms.txt') {
        header('Content-Type: text/plain; charset=utf-8');
        $file = __DIR__ . '/x0053-llms.txt';
        if (file_exists($file)) {
            readfile($file);
        } else {
            echo '# 株式会社オージャスト' . "\n";
            echo 'llms.txt が準備されていません。';
        }
        exit;
    }
    if (isset($_SERVER['REQUEST_URI']) && $_SERVER['REQUEST_URI'] === '/ai.txt') {
        header('Content-Type: text/plain; charset=utf-8');
        $file = __DIR__ . '/x0053-ai.txt';
        if (file_exists($file)) {
            readfile($file);
        } else {
            echo '# ai.txt' . "\n";
            echo 'ai.txt が準備されていません。';
        }
        exit;
    }
});
```

1. 子テーマのディレクトリに `x0053-llms.txt` と `x0053-ai.txt` をアップロード
2. 子テーマの `functions.php` に上記コードを追加
3. https://www.orgiast.jp/llms.txt にアクセスして確認

### 方法B: .htaccess に RewriteRule を追加（簡易版）

```apache
# X-0053: llms.txt / ai.txt 静的配信
RewriteEngine On
RewriteRule ^llms\.txt$ /wp-content/x0053/llms.txt [L]
RewriteRule ^ai\.txt$ /wp-content/x0053/ai.txt [L]
```

1. WordPress の `wp-content/x0053/` ディレクトリを作成
2. `llms.txt` と `ai.txt` をアップロード
3. サーバーの `.htaccess` または `nginx.conf` にリライトルールを追加
4. 確認

### 方法C: プラグイン「Insert Headers and Footers」＋静的ページ（最も簡単）

1. WordPress 管理画面 → 固定ページ → 新規追加
2. タイトル: `llms.txt`
3. スラッグ: `llms-txt`（実際のURLは `/llms-txt/` になる）
4. 内容: `ai-visibility/x0053-llms-txt/llms.txt` の内容を「テキスト」エディタに貼り付け
5. 公開後、301リダイレクト（または .htaccess）で `/llms.txt` → `/llms-txt/` にリダイレクト

## 検証方法

デプロイ後、以下のコマンドで確認：

```bash
# llms.txt の存在確認
curl -s -o /dev/null -w "%{http_code}" https://www.orgiast.jp/llms.txt
# → 200 を確認

# ai.txt の存在確認
curl -s -o /dev/null -w "%{http_code}" https://www.orgiast.jp/ai.txt
# → 200 を確認

# robots.txt に AI クローラーの許可が含まれているか確認
curl -s https://www.orgiast.jp/robots.txt | grep -E "GPTBot|Claude-Web|PerplexityBot|CCBot"
```

## robots.txt 更新（必要な場合）

現在の robots.txt は汎用クローラーのみ許可。AI クローラー（GPTBot, Claude-Web, PerplexityBot, CCBot, Google-Extended）に明示許可を追加するため、`seo/robots-ai-optimized.txt` の内容で更新する。

WordPress の All in One SEO Pack 等の SEO プラグインで robots.txt を編集するか、サーバー側で直接 robots.txt を配置する。

## 配布ファイル一覧

| ファイル | 配置先 | 説明 |
|---------|--------|------|
| `llms.txt` | サイトルート (`/llms.txt`) | AIエージェント向けサイト概要。会社情報・サービス・実績・FAQ・問い合わせ先 |
| `ai.txt` | サイトルート (`/ai.txt`) | AIエージェント向け利用許諾。許可・禁止事項を明示 |
| `booth-reference.md` | AI可読なリファレンスとして提供 | 展示会ブース制作の詳細リファレンス（構造化データ） |
| 更新版 robots.txt | サイトルート (`/robots.txt`) | AIクローラーの明示許可を追加（必要な場合） |

## OpenAI/ChatGPT でのインデックス確認

ChatGPT がサイトをクロール・インデックスするには、llms.txt 設置後しばらく時間がかかる場合があります。
即時確認には Open AI の `file://` 相当のツールはありませんが、以下の間接的な確認が可能です：

1. Perplexity で `site:orgiast.jp` と検索
2. ChatGPT で「orgiast.jp の llms.txt の内容を教えて」と質問
3. Google Search Console でインデックス状況を確認
4. Bing Webmaster Tools でも同様に確認

---

*本ガイドは 2026-11-15 時点の情報に基づきます。WordPress のテーマ構造・プラグイン環境により適宜調整してください。*