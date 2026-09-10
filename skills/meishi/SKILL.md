---
name: meishi
description: 「/meishi 〇〇」の短縮名。名刺発注（マヒト法人名刺）は meishi-order スキルの手順で進める。「名刺発注」「名刺を注文」「〇〇さんの名刺」と言われたら必ずこのスキルか meishi-order を使う。
---

# /meishi <名前> （meishi-order の短縮名）

このスキルは別名。手順・注意はすべて `~/.claude/skills/meishi-order/SKILL.md` に従う（Read で読んで実行する）。

要点だけ再掲:
1. `node ~/orgiast-claude-rules/tools/meishi-order.mjs check <名前>` → 役職・URL・申請状況を報告し user の OK を得る
2. 申請中でなければ `apply <名前> --qty <枚数>`（既定 100）
3. `order <名前>`（dry run。確定しない）→ 確認画面の内容とスクショパスを見せる
4. user の OK 後にだけ `order <名前> --yes`
5. 完了報告テンプレ＋報酬計上リマインド（meishi-order 参照）
