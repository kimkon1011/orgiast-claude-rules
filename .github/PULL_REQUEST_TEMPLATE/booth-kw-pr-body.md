## 概要
`skills/booth-kw-research/process/phase1-crawl.mjs` に実HTTPクローリングを実装。モックから本稼働へ移行。

## 変更内容
### Phase1-crawl 実HTTP化
- `node:https`/`node:http` による実HTTPリクエスト（UA指定・エンコーディング制御）
- 正規表現ベースの軽量HTMLパース: title, h1, meta description, h2-h3見出し, 同一ドメインリンク
- robots.txt パース: User-Agent マッチング（最長一致）、Allow/Disallow パスパターン解決、Crawl-Delay 反映
- 同一ドメイン内リンクの再帰的クロール（最大深度3、全ページ数上限遵守）
- 5MBレスポンス制限、15秒タイムアウト、リダイレクトフォロー（robots.txt用）
- dry-run モード維持: 既存テスト全9件 PASS

### SKILL.md 更新
- 「既知の制約」のTODO(codex)記述をPhase1完了に合わせて更新: Phase2〜4の残TODOのみ記載

## 既知の制約
- 競合サイトリスト (`data/competitors.json`) が空配列のため、現状は自社ドメインのみクロール
- 残り Phase2〜4 に TODO(codex) あり: GSC統合・類似度マージ・内部リンク案

## テスト
```
node --test skills/booth-kw-research/test/dryrun.test.mjs
# 9/9 PASS (dry-run: ネットワーク不使用)
```

## 9ステップ対応状況
| Step | 状態 |
|------|------|
| 1. ワークフロー選定 | ✅ booth-kw-research |
| 2. 人間プロセス文書化 | ✅ SKILL.md |
| 3. 入出力定義 | ✅ SKILL.md出力テーブル |
| 4. データソース接続 | ✅ Phase1実Crawl (Phase2-4未) |
| 5. エージェント指示変換 | ✅ SKILL.md手順 |
| 6. プラットフォーム追加 | ✅ skills/ |
| 7. 関連ファイル追加 | ✅ data/process/test/ |
| 8. テスト調整 | ✅ dry-run PASS (実Crawl検証は次回) |
| 9. デプロイ監視 | ⏳ 監視項目定義済み（監視未実装） |