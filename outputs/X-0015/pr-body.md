# X-0015: プロンプトキャッシュ漏れ9種の防止 — Claude Codeのキャッシュを無駄にしない実践プラクティス

AIニュース提案 X-0015「Claude Codeのプロンプトキャッシュ漏れ9種の防止」の提案文書。既存のX-0015（6軸効率化＋静的プレフィックス）を補完する第二弾。

## 変更内容

### 新規ファイル
- `docs/ai-news-x0015-prompt-cache-leaks.md` — 9種のキャッシュ漏れ（モデル切替/Fast mode切替/離席TTL/Cold compact/新規セッション/監視不足/動的プレフィックス/コンテキスト肥大/作業境界損失）の実態・対策・コスト影響マトリクス。オージャストのブース設計長期セッションへの適用を含む。

### 更新ファイル
- `outputs/X-0015/README.md` — 新記事の追記

## 既存X-0015との関係

| 文書 | 焦点 | 補完関係 |
|------|------|---------|
| 既存: context-cache-efficiency.md | 6軸積み上げ効率化（静的配置・長期記憶隔離など） | 「どうやって効率を上げるか」 |
| 既存: static-prefix-placement.md | 静的プレフィックス配置の詳細 | 「先頭の固定要素を最適化」 |
| **本記事: prompt-cache-leaks.md** | **9種のキャッシュ漏れ防止** | **「何がキャッシュを壊すか＋どう防ぐか」** |

## 検証

X-0015 の既存内容との重複・矛盾なし。コスト試算は既存の `tools/cache-warm-audit.mjs` および `tools/effort-cost-model.mjs` の前提と整合。

## 残タスク

- [ ] この記事の内容を反映した `~/.claude/claude.md` テンプレート更新（離席前TTL更新・rewind活用・/usage習慣化のデフォルトルール追加）
- [ ] 実際のブース設計セッションでの効果計測（1週間のヒット率推移）
- [ ] `tools/cache-warm-audit.mjs` にキャッシュ漏れ検出機能を追加（9種のうち監視可能なものを自動検出）

🤖 Generated with [Claude Code](https://claude.com/claude-code)