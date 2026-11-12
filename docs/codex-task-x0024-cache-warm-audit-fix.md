# Codex 追補指示: cache-warm-audit の誤検出修正と切替損失の実測

対象: `tools/cache-warm-audit.mjs` と `tools/cache-warm-audit.test.mjs`（この2ファイルだけ編集）。他ファイルは触らない。

## 背景（実データで判明した誤検出）
実セッションの JSONL には `message.model` が `<synthetic>` の行がある（コンパクト要約などの合成メッセージ）。
これをそのままモデル名として扱うと、コンパクトのたびに「モデル切替」が立って誤検出になる（実測 31イベント中、多数が `<synthetic>` との往復）。

## 変更1: 合成プレースホルダをモデルとして扱わない
- `message.model` が `<` で始まり `>` で終わる値、または大文字小文字を無視して `synthetic` を含む値は「モデル不明」として扱う。
- `models` 配列に含めない。`modelSwitches` にも数えない。直前の実モデルを保持したまま次の実モデルと比較する（A → synthetic → A は切替0、A → synthetic → B は A→B の1回）。
- 判定は純関数 `isPlaceholderModel(model)` として export し、テストで固定する。

## 変更2: 切替イベントに前後3ターンのヒット率を持たせる
各 `events[i]` に以下を追加する（実 usage のある assistant 行だけを対象、`<synthetic>` 行は前後ウィンドウから除外）:
- `beforeHitRate`: 切替の直前3アシスタント行の hitRate 平均（0〜1、データ無しは null）
- `afterHitRate`: 切替の直後3アシスタント行の hitRate 平均（同上）
- `hitDrop`: `beforeHitRate !== null && afterHitRate !== null && afterHitRate < beforeHitRate - 0.3`

## 変更3: フラグ追加
- `SWITCH_CACHE_LOSS`: `hitDrop === true` のイベントが1件以上。
- `MODEL_SWITCH` は従来どおり実モデルの切替回数 >= 1。

## 変更4: テスト追加（既存12件は消さない・緩めない）
1. `<synthetic>` 行を挟んでも `modelSwitches` が増えない（A→synthetic→A は0、A→synthetic→B は1で from=A,to=B）。
2. 切替前 hitRate 0.99・切替後 0.1 の合成データで `SWITCH_CACHE_LOSS` が立ち、`hitDrop` が true。
3. 切替後も hitRate 0.95 のままなら `SWITCH_CACHE_LOSS` は立たない。

## 完了条件
`node --test tools/cache-warm-audit.test.mjs` が全て緑（既存12+追加3以上）。`node tools/cache-warm-audit.mjs --top 3` が exit 0 で表示できる。
完了報告に「変更した関数名 / 追加したテスト名 / テスト件数 / 実行結果」を書く。テストを緩めない・指示書を書き換えない・他のファイルを作らない。
