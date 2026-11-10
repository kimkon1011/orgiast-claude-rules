# HANDOVER: 官公庁入札プロジェクト

## 目的
株式会社オージャストが官公庁の入札・企画競争（プロポーザル）を自動収集・分析し、
2027年4月までに累計1億円を受注するためのパイプライン。

## ディレクトリ構成
```
C:\Users\kimko\orgiast-bid\
├── tools/
│   ├── collect.mjs        # kkj.go.jp から候補リストを収集（Node.js）
│   ├── awards.mjs         # 落札実績収集（認証後に使用）
│   └── daily-collect.bat  # 日次収集バッチ
├── data/
│   ├── candidates-YYYY-MM-DD.csv  # 候補リスト（日付付き）
│   ├── awards.csv                 # 落札実績
│   └── daily-collect.log          # 収集ログ
├── reports/
│   ├── 01-feasibility.md               # フィージビリティ報告
│   ├── source-check-results.json       # データ源調査結果
│   └── collect-results.json            # 収集結果
├── prompts/
│   └── 01-feasibility-and-first-list.md  # 業務依頼書
├── HANDOVER.md         # 本ファイル
└── .gitignore          # _scratch/ を除外
```

## 実行方法

### 日次収集
```bash
node tools/collect.mjs
```
出力: `data/candidates-YYYY-MM-DD.csv`（337件〜の候補）

### 認証後の追加機能
全省庁統一資格を再取得し、調達ポータルの認証情報を得た後:
1. `awards.mjs` を更新して落札実績をダウンロード
2. `collect.mjs` に調達ポータル検索を追加

## データ源
| 源 | 認証 | 状況 |
|----|------|------|
| kkj.go.jp API | 不要 | ✅ 稼働・337件収集 |
| 調達ポータル | 必要 | ⏳ 資格再申請後 |
| 落札実績 | 必要 | ⏳ 資格再申請後 |
| 大阪府/大阪市 | 不明 | ❌ URL不明 |

## 個人依存値
なし（コード内にID/パスワード不使用）。
kkj.go.jp API は完全公開。

## 次の操作（移管先で最初にやること）
1. `node tools/collect.mjs` を実行して最新の候補を取得
2. CSV を Google スプレッドシートにインポートして共有
3. kim から全省庁統一資格の再申請状況を確認
4. 認証情報入手後、調達ポータル検索を tools/collect.mjs に追加実装