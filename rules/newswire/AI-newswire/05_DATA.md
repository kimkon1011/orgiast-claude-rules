# データ設計

## 入力

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| keyword | string | 必須 | 分析するキーワード |

## 出力（LLM応答をパース後）

| フィールド | 型 | 説明 |
|---|---|---|
| suggestions | string[] | 関連サジェストキーワード（5-10件） |
| searchTerms | string[] | 再検索ワード（3-5件） |
| personas | Persona[] | 読者ペルソナ（2-3人） |
| outlines | Outline[] | 記事構成案（1-3案） |
| qualityChecklist | string[] | 記事品質チェック（5-10項目） |

### Persona

| フィールド | 型 | 説明 |
|---|---|---|
| name | string | ペルソナ名 |
| attributes | string | 属性（年齢・職種等） |
| interests | string | 関心領域 |
| challenges | string | 抱える課題 |

### Outline

| フィールド | 型 | 説明 |
|---|---|---|
| title | string | 記事タイトル |
| headings | string[] | 見出し構成 |