# T-8400 周18 神原直弥さんの照合（2026-11-21）

- **署名済み雇用契約書の提出記録 — 確認済み（ファイルURLなし）**。社員名簿（オージャスト） ID `1auyUKnwxprFqlOE142ZrE3JaWQ_f4qE4vldaEZ9tX3w` の `Form Responses 2` は、1行目のAB列に「署名済雇用契約書アップロード」がある。2〜280行のC:D列（氏名）に本人の回答行なし。同じシートの `全ﾃﾞｰﾀ` 585行ではB:C列の氏名が一致し、AA585に入力値・リンクなし。別タブ `トライアル通過後雇用契約書アップロード` のB列2〜1013行にも本人の行なし。
- **勤怠用の社員番号反映 — 確認済み（あり）**。社員番号検索 ID `1wjowCNTY6toog2LQOKPrxaNWQsJcL2jl_f0_d5d4O7g` の `シート1` B5に「社員番号」。検索式が参照する `シート2` のM26で氏名を照合し、P26に番号あり。社員名簿（オージャスト）の `全ﾃﾞｰﾀ` A585（「№」）と一致。
- **読み取り経路**。trial-contract-gas、nightly-repo の tools・config、ローカル記憶を検索。既存の `tools/lib/sheets-dwd.mjs` は `Sheets GET HTTP 401`。Drive APIの直接検索は `GWS proxy: kim is calendar-only` または `401 UNAUTHENTICATED: Request had invalid authentication credentials.`。接続済みのGoogle Drive／Sheetsから読み取りで照合した。
