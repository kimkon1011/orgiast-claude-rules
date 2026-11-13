# X-0012: 製品デザイン用AIスキル8選のロード

AIニュース提案 X-0012「Stageshow / Impeccable / Dimensional Drawing / Oil UI / Emil Kowalski's skills / Taste Skill / Brand Identity / Awwwards MCP — Claude CodeでロードするUI設計の新しい常識」の設計文書と実装計画。

## 変更内容

### 新規ファイル
- `docs/ai-news-x0012-product-design-skills.md` — 8スキルの概要・インストール手順・用途別選択基準・制約・期待効果
- `outputs/X-0012/README.md` — 出力ディレクトリ解説
- `outputs/X-0012/pr-body.md` — 本PRの本文
- `outputs/X-0012/orgiast-implementation-plan.md` — 週次マイルストーン実装計画

## 注目ポイント

1. **フルカバレッジ設計**: アニメーションデモ（Stageshow）→ UI監査（Impeccable）→ 仕様書（Dimensional Drawing）→ 方向性検討（Oil UI）→ アニメ品質（Emil Kowalski）→ 高品質構築（Taste Skill）→ ブランド設計（Brand Identity）→ リファレンス（Awwwards MCP）。デザインの全工程をカバー
2. **ルールベース品質ゲート**: Impeccable（62ルール）+ Emil Kowalski（10ルール）でLLM不要の自動品質チェック。CI/CDパイプラインに統合可能
3. **実ブラウザ検証**: Stageshow / Oil UI / Taste Skill はPlaywrightで実レンダリングを撮影し、コードだけでなく視覚的な品質を担保
4. **段階的導入可能**: 各スキルが独立しているため、Impeccableだけ・Taste Skillだけの導入も可能。既存のorgiast.jpサイトに少しずつ適用可能
5. **オープンソース・無料**: 全スキルが無料のOSS。API費用はImpeccableのフルビルド時のみ（約$7.49/回）

## 検証結果

証拠ゲート 7項目を確認:
- ✅ 各スキルの作成者・インストールコマンド・バージョンが明記
- ✅ 各スキルの主要機能と出力形式が説明されている
- ✅ オージャスト固有のユースケースが各スキルについて定義
- ✅ 週次マイルストーンを含む実装計画
- ✅ スキル間の連携・選択基準が示されている
- ✅ 期待効果が数値で提示
- ✅ 制約・注意点（Node要件・API費用・競合など）が明記

## 残タスク

- [ ] Phase 1（Week 1）: Impeccable + Emil Kowalski をロードし、orgiast.jp の既存UIを監査・改善箇所をリストアップ
- [ ] Phase 2（Week 2）: Stageshow + Oil UI + Awwwards MCP でブース紹介ページのリデザイン案を生成・比較
- [ ] Phase 3（Week 3）: Taste Skill + Brand Identity で「イベントプロデュース」LPの新規構築
- [ ] Phase 4（Week 4）: Dimensional Drawing でRe:ブースの統一仕様書を生成し、CIパイプラインへのスキル品質ゲート統合を検討
- [ ] 各スキルのコマンド名競合チェック（同一エージェントに複数ロード時の挙動確認）

🤖 Generated with [Claude Code](https://claude.com/claude-code)