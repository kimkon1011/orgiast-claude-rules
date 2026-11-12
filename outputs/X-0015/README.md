# X-0015 出力ディレクトリ解説

AIニュース提案 X-0015「コンテキストキャッシュ効率化で消費を何分の1に削減」および
「プロンプトキャッシュ漏れ9種の防止」の分析レポートと設計文書です。

## ディレクトリ構造

```
outputs/X-0015/
├── README.md                           # 本解説
├── placement-efficiency-report.md      # 配置効率レポート（2026-11-08 デモ実行結果）
├── combined-efficiency-model.md        # 6軸積み上げ効果の定量モデル
└── pr-body.md                          # PR 本文（本セッション追加）
```

## 文書体系

| 文書 | 説明 |
|---|---|
| `docs/ai-news-x0015-static-prefix-placement.md` | 軸① 静的先頭配置の詳細（2026-11-09 PR #1769） |
| `docs/ai-news-x0015-context-cache-efficiency.md` | 軸①〜⑥ 包括版（6軸積み上げ） |
| **`docs/ai-news-x0015-prompt-cache-leaks.md`** | **9種のキャッシュ漏れ防止（2026-11-12 本セッション追加）** |
| `outputs/X-0015/placement-efficiency-report.md` | 静的配置ツールデモ結果（2026-11-08） |
| `outputs/X-0015/combined-efficiency-model.md` | 6軸積み上げの価格換算・感度分析 |
| `outputs/X-0015/pr-body.md` | PR 本文 |

## 2本立ての関係

```
X-0015
├── ① context-cache-efficiency.md（6軸効率化）
│   ├── 静的先頭配置
│   ├── 長期記憶フォルダ隔離
│   ├── Daily.md 自動日報
│   ├── Idle compaction=false
│   ├── 人間/AI役割分担（5:3:1+確認項目）
│   └── Worktree最大3制限
│
└── ② prompt-cache-leaks.md（9種漏れ防止）【本セッション追加】
    ├── モデル切替
    ├── Fast mode切替
    ├── 離席TTL切れ
    ├── Cold compact
    ├── /rewind未活用
    ├── /usage未監視
    ├── 動的プレフィックス
    ├── コンテキスト肥大
    └── 作業境界損失
```

①が「どうやって効率を上げるか」、②が「何がキャッシュを壊すか」という表裏の関係。
両方を実施することで初めて最大のコスト削減効果が得られる。

## 関連タスク

| タスク | 関係 |
|---|---|
| X-0009 | KVキャッシュプレフィックス共有ゲートウェイ実装 |
| X-0016 | サブエージェント進化によるコスト削減（別アプローチ） |
| X-0017 | キャッシュ監視ツール（消費監視） |
| X-0019 | 長期セッション圧縮（保存志向の別解） |
| X-0021 | effort調整とHaikuサブエージェント（costモデル共有） |
| X-0024 | キャッシュウォーム監査ツール（cache-warm-audit.mjs） |
| X-0035 | APIレベルプロンプトキャッシング（3社比較） |