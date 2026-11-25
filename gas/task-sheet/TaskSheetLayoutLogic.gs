// 「タスク」タブのレイアウト（row1=健全性サマリ / row2=ヘッダー / row3以降=データ）を
// 維持するための純粋関数群。SpreadsheetApp に依存しないので Node から直接テストできる。

function _tsheetArraysEqual_(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  // '' 区切りで結合して比較する（join('') だと ['ab','c'] と ['a','bc'] が
  // 衝突して誤って「一致」と判定されるおそれがあるため、区切り文字を必ず挟む）。
  return a.join('') === b.join('');
}

// row1 / row2 の現在の中身から、ensureTab が取るべきアクションを決める。
// - insertRowBeforeOne: 旧レイアウト（row1=ヘッダー）からの一回限りの移行。row1をヘッダーごと
//   1行下（row2）にずらす。呼ぶのは「row1がヘッダーで、row2はまだヘッダーではない」ときだけ。
// - clearRow1: row2に既に正しいヘッダーがあるのに、row1にも（別経路で書き込まれた）ヘッダーの
//   コピーが残っている状態。ここで insertRowBeforeOne をやってしまうと、row2 の正しいヘッダーが
//   row3 に押し出されて二重化する（今回の実バグの本体）。なので shift ではなく row1 を掃除するだけにする。
// - writeHeaderAtRow2: row2がヘッダーと一致しないので書き込む（新規シート、または想定外の破損）。
function taskSheetPlanEnsureLayout(row1Values, row2Values, headerConstant) {
  var row1IsHeader = _tsheetArraysEqual_(row1Values, headerConstant);
  var row2IsHeader = _tsheetArraysEqual_(row2Values, headerConstant);

  if (row1IsHeader && !row2IsHeader) {
    return { insertRowBeforeOne: true, clearRow1: false, writeHeaderAtRow2: false };
  }
  if (row1IsHeader && row2IsHeader) {
    return { insertRowBeforeOne: false, clearRow1: true, writeHeaderAtRow2: false };
  }
  if (!row2IsHeader) {
    return { insertRowBeforeOne: false, clearRow1: false, writeHeaderAtRow2: true };
  }
  return { insertRowBeforeOne: false, clearRow1: false, writeHeaderAtRow2: false };
}

// シート全体（row1から）を渡し、row2以外でヘッダーと完全一致してしまっている行を洗い出す。
// rowsFromRow1: [row1Values, row2Values, row3Values, ...]（1始まりでいうrow番号 = 配列index+1）
// 戻り値: 削除すべき1始まり行番号の配列（降順ではない。呼び出し側で降順ソートしてから削除すること）。
function taskSheetPlanRepair(rowsFromRow1, headerConstant) {
  var deleteRows = [];
  (rowsFromRow1 || []).forEach(function(rowValues, index) {
    var rowNumber = index + 1;
    if (rowNumber === 2) return; // row2 は正規のヘッダー行なので消さない
    if (_tsheetArraysEqual_(rowValues, headerConstant)) deleteRows.push(rowNumber);
  });
  return { deleteRows: deleteRows };
}
