# 記憶索引

記憶索引は **v2 split** を正本とする。予算/グラフ方式 (`memory-index-graph.mjs`) は採用しない。

実セッション24本による A/B 実測では、想起成功率は両方式とも 9/12 だった。一方、v2 はサブ索引を一度も読まなかった（0/12）。同等の想起性能をより単純な構成で得られるため、v2 split を採用する。再測定には `tools/memory-index-ab.mjs` を使う。

夜間バッチは、ディスク上の `index/*.md` と `MEMORY.md` から割当と pin を導出し、`memory-index-split.mjs --apply` で再生成した後、生成側と独立した `memory-index-split-verify.mjs` で照合する。割当ファイルを事前配置する必要はない。

新規 memory がどの `index/*.md` にも掲載されていない場合、夜間ログの `memory-index-split` は `要手当` になる。この場合は、内容に対応する `index/<domainKey>.md` に `- [表題](../ファイル名.md)` を1行追加する。分類を明示的に決めて一度だけ手動適用する場合は、`memory-index-domains.mjs --fallback <domainKey>` で割当 JSON と pins を生成し、それらを `memory-index-split.mjs --apply` に渡す。夜間バッチ自身は誤分類を避けるため fallback を使わない。
