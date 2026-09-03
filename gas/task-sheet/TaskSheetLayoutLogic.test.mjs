import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./TaskSheetLayoutLogic.gs', import.meta.url), 'utf8');
const context = {};
vm.createContext(context);
vm.runInContext(source.replace(/\bconst\s+/g, 'var '), context);

// vm.createContext は別レルムを作るため、そこで生成された配列/オブジェクトは
// このファイル側のArray/Objectとプロトタイプが異なり、deepEqualが
// 「構造は同じだが reference-equal ではない」として失敗する。
// JSON往復でこのファイル側のプレーンな値に正規化してから比較する。
const plain = (value) => JSON.parse(JSON.stringify(value));

const HEADERS = ['taskId', '起票元', '件名', '依頼元', '担当PC', '状態', '次アクション', '成果物リンク', '期限', '最終更新', '備考'];
const BLANK = HEADERS.map(() => '');

test('taskSheetPlanEnsureLayout: brand new sheet (row1/row2 both empty) writes header at row2 only', () => {
  const plan = plain(context.taskSheetPlanEnsureLayout([], [], HEADERS));
  assert.deepEqual(plan, { insertRowBeforeOne: false, clearRow1: false, writeHeaderAtRow2: true });
});

test('taskSheetPlanEnsureLayout: legacy layout (header at row1, row2 blank/data) migrates by shifting down once', () => {
  const plan = plain(context.taskSheetPlanEnsureLayout(HEADERS, BLANK, HEADERS));
  assert.deepEqual(plan, { insertRowBeforeOne: true, clearRow1: false, writeHeaderAtRow2: false });
});

test('taskSheetPlanEnsureLayout: already-healthy layout (row1 blank, row2 header) is a no-op', () => {
  const plan = plain(context.taskSheetPlanEnsureLayout(BLANK, HEADERS, HEADERS));
  assert.deepEqual(plan, { insertRowBeforeOne: false, clearRow1: false, writeHeaderAtRow2: false });
});

// これが今回のバグの核心: row2 に既に正しいヘッダーがあるのに row1 にもヘッダーのコピーが
// 残っている状態で、旧来の「row1==ヘッダーなら無条件でinsertRowBefore」をやってしまうと、
// row2 の正しいヘッダーが row3 に押し出されて二重化する。ここでは shift ではなく row1 の
// クリアだけを計画しなければならない。
test('taskSheetPlanEnsureLayout: row1 AND row2 both already equal the header must NOT shift (would duplicate) — must clear row1 instead', () => {
  const plan = plain(context.taskSheetPlanEnsureLayout(HEADERS, HEADERS, HEADERS));
  assert.deepEqual(plan, { insertRowBeforeOne: false, clearRow1: true, writeHeaderAtRow2: false });
});

test('taskSheetPlanEnsureLayout: running the plan twice in a row converges (idempotent) without ever re-triggering a shift', () => {
  // 1回目: 破損状態(row1=header, row2=header) からの復旧
  let row1 = HEADERS.slice();
  let row2 = HEADERS.slice();
  const plan1 = plain(context.taskSheetPlanEnsureLayout(row1, row2, HEADERS));
  assert.equal(plan1.insertRowBeforeOne, false, '1回目でシフトしてはいけない(二重化するため)');
  assert.equal(plan1.clearRow1, true);
  // plan1を適用した後の状態をシミュレート: row1はクリアされ、row2はそのまま
  row1 = BLANK.slice();
  // 2回目: 健全化されたはずの状態でもう一度実行しても、何も起きない
  const plan2 = plain(context.taskSheetPlanEnsureLayout(row1, row2, HEADERS));
  assert.deepEqual(plan2, { insertRowBeforeOne: false, clearRow1: false, writeHeaderAtRow2: false });
});

test('taskSheetPlanRepair: leaves a healthy sheet (header only at row2) untouched', () => {
  const rows = [BLANK, HEADERS, ['T-1', 'kim', '件名', '', '', '未着手', '', '', '', 'now', '']];
  const plan = plain(context.taskSheetPlanRepair(rows, HEADERS));
  assert.deepEqual(plan.deleteRows, []);
});

// 実測された壊れ方そのもの: row1=空, row2=ヘッダー, row3=ヘッダーの重複, row4=データ
test('taskSheetPlanRepair: removes the duplicated header row (row3) from the observed broken shape, keeps row2 and the data row', () => {
  const dataRow = ['T-VERIFY-0903', 'system', '疎通テスト', 'Claude', 'DESKTOP-2D0R4LI', '完了', 'kim が表で見えることを確認', '', '', '2026-09-03T05:33:06.493Z', ''];
  const rows = [BLANK, HEADERS, HEADERS, dataRow];
  const plan = plain(context.taskSheetPlanRepair(rows, HEADERS));
  assert.deepEqual(plan.deleteRows, [3]);
});

test('taskSheetPlanRepair: removes multiple stray header copies wherever they appear (except row2)', () => {
  const dataRow = ['T-1', 'kim', '件名', '', '', '未着手', '', '', '', 'now', ''];
  const rows = [HEADERS, HEADERS, HEADERS, dataRow, HEADERS];
  const plan = plain(context.taskSheetPlanRepair(rows, HEADERS));
  // row2(index1)は絶対に消えない。row1/row3/row5(index0,2,4)は重複ヘッダーなので削除対象。
  assert.deepEqual(plan.deleteRows.sort((a, b) => a - b), [1, 3, 5]);
});
