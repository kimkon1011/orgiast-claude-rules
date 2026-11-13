# 保存済み出力の回帰fixture

2026-11-04のkim-PC state.batches[*].localAnswerから抽出。自由記述セルは同じ文字列を同じ匿名文字列へ変換し、空文字・数値・行列の長さ・before欠落・document参照は維持した。リンクはファイルIDとラベルを匿名化。manifestのsha256は抽出元localAnswerのハッシュ。

|batch接頭辞|保存済み実出力|修正前の再現|
|---|---|---|
|cdfd|あり|確認事項が6列で寸法エラー|
|e6d7|あり|submission未特定|
|6a7a|あり|専用タブのbefore欠落で寸法エラー|
|8a63|なし|parse前stdout未保存。実出力での再現・適用件数算定はできない|

8a63については、生改行・タブ・NULを含む合成JSONの回帰テストを別途用意した。これは実出力の復元ではない。4件とも実stateのfailedに登録されていることは確認済み。
