# X-0018 vibe-testing 評価レポート

実行日: 2026-11-12
環境: Windows Git Bash, Node v24.22.2, vibe-testing v0.4.6

## 概要

AIニュース提案 [X-0018]「vibe-testingでウェブサイト実ブラウザテスト自動化」の評価。
本レポートは前回（2026-11-09）の8試行に続く追加検証として、vibe-testing npmパッケージの実機検証を行った。

## 検証結果

### ✅ 1. vibe-testing init（成功）
- `npx vibe-testing@latest init --no-global --skip-browser-install` で正常動作
- 生成ファイル: VIBE.md, vibe.config.json, CLAUDE.md, AGENTS.md, .mcp.json, .gitignore
- デフォルトURLは `http://localhost:3000`
- `--no-global` でグローバル設定変更なし

### ✅ 2. vibe-testing run（ブラウザテスト成功）
- `npx vibe-testing@latest run --no-headed <url>` でローカルHTMLサイトのテスト正常動作
- フォーム要素・リンクの発見と探索: ✅
- スクリーンショット付きHTMLレポート生成: ✅
- 要素別のworking/broken判定: ✅

### ⚠️ 3. 制約と限界
- **vibe-testingはローカルコードベースを前提に設計されている。** 最初にカレントディレクトリのソースコードをスキャンし、ルート・フォーム・セレクタを抽出してからURLへアクセスする。リモートサイト単体への適用は想定外。
- **フレームワーク未検出時はルート数0になる。** WordPress等の動的サイトのルート解析には対応していない（静的HTML/JSフレームワークが対象）。
- **フォーム送信先の隔離環境が必要。** 本番サイトへのPOST送信を避けるため、テスト専用のWordPressステージング環境またはローカルコピーが別途必要。
- **エージェントに「Test the checkout flow and tell me what's broken.」と指示する使い方はMCP統合用。** CLI run モードではスキャン→探索→レポートの自動フローとなり、エージェント指示による自由形式テストはできない。

## オージャスト適用の現実的評価

| 項目 | 評価 | 備考 |
|------|------|------|
| 自社サイトのテスト | ⚠️ 条件付き可 | ローカルコピー＋隔離環境があれば可能 |
| イベント問い合わせフォーム | ❌ 不可 | 本番送信回避の隔離環境が必要（Google Forms埋込のため特に困難） |
| ブースギャラリーナビゲーション | ✅ 可 | 公開ページのナビゲーションテストは前回Codex実績(試行06-08)で確認済み |
| CI/CD統合 | ⚠️ 要検証 | Playwright依存のためWindows/WSL両対応の設定評価が必要 |

## 前回からの進捗

- 前回(Codex 8試行): vibe-testing init未実行、vibe-testing自体の動作未確認
- 今回: **vibe-testing init + run の初成功確認**。CLIツールとしての動作を実証。
- 未達: 正式ソース＋隔離環境でのend-to-endテスト（C1/C2/C4未達）

## 結論

vibe-testingはローカル開発環境でコードと連動したブラウザテストを行うツールとして有効だが、オージャストのWordPressベース本番サイトへの直接適用は隔離環境とソースコピーが必須。評価の完遂には以下が必要:
1. WordPressテーマ/子テーマのローカルコピー入手
2. ローカルWordPress開発環境（Local WP等）のセットアップ
3. テスト専用フォーム送信先の設定（mailhog等）
4. 上記環境での `npx vibe-testing@latest init --no-global`
5. VIBE.md編集（テスト用URL・資格情報）
6. `vibe-testing run` の実行とレポート確認