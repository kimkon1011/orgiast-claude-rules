# 指示書A2: ai-receipt-scan の実測で見つかった4点を直す（同じブランチへの追加コミット用）

実機（kim-PC）で `node tools/ai-receipt-scan.mjs --days 14` を実行した結果:

```
🚨 seisaku-team@orgiast.jp|anthropic|-: 48時間の支払い集中: $159.18 / 11回
🚨 cr@orgiast.jp|anthropic|-: 48時間の支払い集中: $159.18 / 11回      ← 同じ領収書が cr@ の受信箱にも転送されていて二重計上
seisaku-team@orgiast.jp / anthropic / -: 48h $159.18 (11回) / MTD $328.14
seisaku-team@orgiast.jp / anthropic / よろしくお願いします。‘s Individual Org: 48h $0.00 / 最終 autoreload_other_card   ← 組織名が分かる行と領収書の行が別ソースに割れる
kim@orgiast.jp / google / -: 48h $0.00 (0回) / MTD $0.00 / 最終 other   ← 領収書でもイベントでもない行がノイズ
```

## 直すこと（`tools/ai-receipt-scan.mjs` と `tools/ai-receipt-scan.test.mjs`）

1. **受信箱をまたぐ重複排除**: `parseReceiptMail` は `account`（impersonate した受信箱）に加えて `recipient`（メールの To ヘッダの先頭アドレス、小文字）を持つ。`summarizeReceipts` は同じ `vendor` + `receiptNo`（receiptNo が無いときは `vendor` + `kind` + `subject` + 日付(JST)）の行を **1件として数え**、帰属先は `recipient` が `config.accounts` に含まれればその受信箱、含まれなければ最初に見つかった `account`。転送で cr@ に同じ領収書があっても cr@ の source には足さない。台帳（jsonl）には両方の行を残してよい（dedupe は集計時）。
2. **組織名の補完**: 同じ帰属先 + vendor の行のうち `org` が分かる行（autoreload_other_card / api_off 等）が **ちょうど1種類** なら、`org` が null の receipt 行もその org に帰属させて source を1つにまとめる。2種類以上なら従来どおり `-` のまま。
3. **ノイズ行の非表示**: `formatReceiptReport` は、当月の receipt が0件 かつ 48h のイベント（failed_payment / autoreload_paused / autoreload_other_card / api_off / spend_limit_* / limit_increased / usage_request）が0件の source を出力しない（`other` だけの行を消す）。alerts 判定には影響させない。
4. **Unicode の引用符**: 実メールの組織名は `よろしくお願いします。‘s Individual Org`（U+2018）で来ることがある。org 抽出の正規表現で `'` / `’` / `‘` を同一視し、保存する org 名は ASCII `'` に正規化する（テストに `‘s Individual Org` のケースを足す）。

## テスト
- 上の4点それぞれに node:test を追加（cr@ への転送コピー、org 補完、ノイズ非表示、U+2018）。
- `node --test tools/ai-receipt-scan.test.mjs tools/budget-status.test.mjs tools/cost-improve-loop.test.mjs`（cwd=repo）が全部 pass。
- commit / push はしない。完了報告は変更ファイル一覧とテスト件数だけ。
