---
name: wp-performance
description: WordPressサイトの速度改善策を診断・適用する。キャッシュ・画像最適化・DBクエリ・プラグイン棚卸し・テーマ軽量化を点検する。展示会ブース制作サイトの WordPress パフォーマンス改善に使う。「WP速度」「WordPress高速化」「wp-perf」「WP最適化」「WordPressパフォーマンス」と言われたらこのスキルを使う。
---

# WordPress パフォーマンス改善

展示会ブース制作サイトが WordPress で運用されている場合の速度改善。

## 1. 診断項目

- **キャッシュ**: サーバーキャッシュ（Redis/WP Super Cache/FastCGI）・CDN（Cloudflare/Vercel Edge）・ブラウザキャッシュの設定
- **画像最適化**: WebP 配信・遅延読み込み（loading="lazy"）・IMAGINE 等のレスポンシブ画像・画質とファイルサイズのバランス
- **プラグイン棚卸し**: 有効プラグイン一覧を取得し、使っていないもの・重複機能・重いプラグイン（メニュー管理画面の遅延原因）を特定
- **DB クエリ**: インデックス不足・N+1・遅いウィジェットクエリ（最近の投稿・カテゴリー一覧）
- **テーマ**: 子テーマ利用・不要な CSS/JS の enqueue 停止・`functions.php` の autoload

## 2. 改善手順

各項目について:
1. 現状確認: `wp plugin list`・`wp theme list`・クエリモニタリング
2. 改善コード（`functions.php` への追加・設定変更・プラグイン無効化）を提示
3. テスト・ステージングで検証
4. 再診断で改善を確認

## 3. 注意

- `wp` CLI が使える環境では `wp plugin deactivate --uninstalled` で使っていないプラグインを整理
- キャッシュクリアは改善確認時のみ行い、本番では計画的に実行
- プラグインのアップデートは確認環境で先行テストする