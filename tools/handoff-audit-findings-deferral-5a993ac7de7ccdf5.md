# handoff-audit 検証記録: `5a993ac7de7ccdf5`「event-shop.jp の価格を変えるかどうかの返事を待っています」の再発検証（2026-11-03 初版）

対象 TODO: `[handoff-audit:5a993ac7de7ccdf5] 恒久修正の先送り文を検出（2026-11-01T18:02:06.670Z / 91cd4fa3 / W）`。

送信なし・権限変更なし・kim への DM なし。

## 結論

1. **原文の待機は解消済み（実物で確認）**。価格改定は 2026-11-02T13:38:42Z に作業セッション b5ad00e5 が完了報告しており、本番 https://event-shop.jp を直接取得して 3 商品の表示価格が改定前の 1.5 倍になっていることを確認した（下表）。デプロイ HEAD `16517db` に価格改定コミット `f9366c2` が含まれることも `git merge-base --is-ancestor` で確認済み。
2. **同文の再発は 0 件**。`node tools/permanent-fix-deferral-scan.mjs --since 2026-11-01T18:03:00Z` で stop-gate-runner-ledger（2774 行）のヒットは 2 件（どちらも Codex の完了待ちで無関係）、handoff-audit-ledger（3391 行）と handoff-audit-nightly-ledger（471 行）は 0 件。91cd4fa3 の「価格改定の返事待ち」報告は 2026-11-02T07:48:07Z が最後で、以後は出ていない。
3. **検出器の取りこぼしを 1 件直した（恒久修正）**。2026-11-01T03:47:46Z の同セッションの報告「価格改定の返事を待っているセッションも、まだ止まったままです。」は旧 W で素通りしていた。18:02 の検出は `セッション:` が待機語より前にあったため LANE_STATUS_WAIT が偶然拾った形で、語順を変えると同じ先送りが不可視になる。W に「返事／返答を待って(います|いる|おります)」を追加し、外部（お客様・取引先等）とサブエージェントの返事待ちは除外した。テスト 2 本を追加し `node --test tools/permanent-fix-deferral-scan.test.mjs` は 42 件すべて green。
4. 誤検出の実測: 追加パターンを全 3 台帳（6636 行）に当てると新規ヒットは 4 件だけ（2026-10-12 033ef005、2026-10-21 e1fd2c07、2026-10-27 9815974e、2026-11-01 91cd4fa3）。いずれも kim-PC / nishi の返事待ちで、外部の返事待ちは 0 件だった。
5. 検出器・ゲートの変更: `tools/permanent-fix-deferral-scan.mjs`（W の拡張）とそのテストのみ。

## 実物検証（本番表示）

取得: `curl -H "Cache-Control: no-cache" "https://event-shop.jp/products/setsuei?v=20261103a"`（CDN キャッシュ回避のためクエリ付き）。

| 商品 | 改定前（`f9366c2^`） | 改定後（`f9366c2`） | 本番表示 |
|---|---|---|---|
| 4面ガラス冷蔵ショーケース レンタル(卓上型) | 9,900 | 14,850 | ¥14,850 |
| 商談ハイテーブルセット レンタル(ハイテーブル1+ハイチェア2) | 6,600 | 9,900 | ¥9,900 |
| ブース照明セット レンタル(LEDアームスポット4灯) | 8,800 | 13,200 | ¥13,200 |

3 商品とも本番表示 = 改定後の値（改定前の 1.5 倍）。価格改定の未実施・未反映は再現しない。

## 残ったこと（このターンでは直さない）

- `~/.claude/auto-progress-ledger.jsonl` の b5ad00e5 行（`ts 2026-11-02T13:12:33.601Z`）は `status=open` / `verdict=in_progress` のまま。理由欄には「本番反映・価格1.5倍確認済みの最終報告あり」とあり、成果はこの検証でも確認済み。ただし `check` コマンドを持たない行なので、自動で done になるのは次回の自動再開判定のとき。ここを手で書き換えると台帳の不変条件を壊すため触っていない。
- `~/.claude/next-session.md` の Supabase トークン待ちブロック（10 行目）に「別件で判断待ち: 価格1.5倍改定(b5ad00e5…)」という古い記述が残っている。価格は完了済み。この行は別 TODO（Supabase）の備考なので本ターンでは変更していない。

## 検証コマンド

```
node tools/permanent-fix-deferral-scan.mjs --since 2026-11-01T18:03:00Z
node --test tools/permanent-fix-deferral-scan.test.mjs
git -C D:/Claude/event-shop merge-base --is-ancestor f9366c2 16517db
git -C D:/Claude/event-shop show f9366c2^:src/data/products-extra.json
curl -H "Cache-Control: no-cache" "https://event-shop.jp/products/setsuei?v=20261103a"
```
