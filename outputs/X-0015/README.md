# X-0015 出力ディレクトリ解説

AIニュース提案 X-0015「コンテキストキャッシュ効率化で消費を何分の1に削減」の
分析レポートと設計文書です。2026-11-10 包括版で拡充。

## ディレクトリ構造

```
outputs/X-0015/
├── README.md                           # 本解説
├── placement-efficiency-report.md      # 配置効率レポート（2026-11-08 デモ実行結果）
└── combined-efficiency-model.md        # 6軸積み上げ効果の定量モデル（本セッション追加）
```

## 文書体系

| 文書 | 説明 |
|---|---|
| `docs/ai-news-x0015-static-prefix-placement.md` | 軸① 静的先頭配置の詳細（2026-11-09 PR #1769） |
| `docs/ai-news-x0015-context-cache-efficiency.md` | 軸①〜⑥ 包括版（本セッション PR） |
| `outputs/X-0015/placement-efficiency-report.md` | 静的配置ツールデモ結果（2026-11-08） |
| `outputs/X-0015/combined-efficiency-model.md` | 6軸積み上げの価格換算・感度分析 |

## 6軸の関係

```
X-0015 包括版（本記事）
├── ① 静的先頭配置 → 別記事に詳細
├── ② 長期記憶フォルダ隔離
├── ③ Daily.md 自動日報
├── ④ Idle compaction=false
├── ⑤ 人間/AI役割分担（5:3:1+確認項目）
└── ⑥ Worktree最大3制限
```

## 関連タスク

| タスク | 関係 |
|---|---|
| X-0009 | KVキャッシュプレフィックス共有ゲートウェイ実装 |
| X-0016 | サブエージェント進化によるコスト削減（別アプローチ） |
| X-0017 | キャッシュ監視ツール（消費監視） |
| X-0019 | 長期セッション圧縮（保存志向の別解） |
