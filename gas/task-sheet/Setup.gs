const TASK_SHEET_TAB_NAME_ = 'タスク';
const TASK_SHEET_HEADERS_ = ['taskId', '起票元', '件名', '依頼元', '担当PC', '状態', '次アクション', '成果物リンク', '期限', '最終更新', '備考'];

// 初回の準備はこの関数だけを実行する（トークンは setTaskSheetToken で別途設定する）。
function setupOnce() {
  const sheet = _taskSheetEnsureTab_();
  installCommandQueue();
  installJobWatchTrigger();
  console.log('task sheet read-back OK; tab=' + sheet.getName() + '; command queue installed');
  return { ok: true, tabName: sheet.getName(), headerCount: sheet.getLastColumn() };
}

// 共有シークレットは Claude 側で生成してここに流し込む。GAS から外へ出さない(戻り値もマスクする)。
function setTaskSheetToken(args) {
  const token = (args && typeof args.token === 'string' ? args.token : (typeof args === 'string' ? args : '')).trim();
  if (token.length < 32) throw new Error('token is too short');
  PropertiesService.getScriptProperties().setProperty('TASK_SHEET_TOKEN', token);
  return { ok: true, tokenLength: token.length };
}

// 設定の健全性確認用。秘匿値そのものは返さない。
function describeTaskSheetConfig() {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('TASK_SHEET_TOKEN') || '';
  return {
    cmdFolderId: props.getProperty('CMD_FOLDER_ID') || null,
    tokenSet: !!token,
    tokenLength: token.length
  };
}

function _taskSheetSpreadsheet_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function _taskSheetEnsureTab_() {
  const ss = _taskSheetSpreadsheet_();
  let sheet = ss.getSheetByName(TASK_SHEET_TAB_NAME_);
  if (!sheet) sheet = ss.insertSheet(TASK_SHEET_TAB_NAME_);
  const lastColumn = sheet.getLastColumn();
  const row1 = lastColumn > 0 ? sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0] : [];
  const row2 = lastColumn > 0 ? sheet.getRange(2, 1, 1, lastColumn).getDisplayValues()[0] : [];
  const plan = taskSheetPlanEnsureLayout(row1, row2, TASK_SHEET_HEADERS_);
  if (plan.insertRowBeforeOne) {
    // 旧レイアウト（row1=ヘッダー）からの一回限りの移行: row2がまだヘッダーでないときだけ、
    // row1のヘッダーをそのままrow2へ1行下げる。
    sheet.insertRowBefore(1);
  } else if (plan.clearRow1) {
    // row2に既に正しいヘッダーがあるのに row1 にもヘッダーのコピーが残っているケース。
    // ここで insertRowBefore すると row2 の正しいヘッダーが row3 に押し出されて二重化するので、
    // シフトはせず row1 を空にするだけにする（サマリ行として空けておく）。
    sheet.getRange(1, 1, 1, lastColumn).clearContent();
  }
  if (plan.writeHeaderAtRow2) {
    sheet.getRange(2, 1, 1, TASK_SHEET_HEADERS_.length).setValues([TASK_SHEET_HEADERS_]);
  }
  return sheet;
}

// 既存シートの破損（row2以外にヘッダーの完全コピーが紛れ込んで二重化した状態）を正規化する。
// 手順:
//  1. _taskSheetEnsureTab_() でrow1/row2の関係を先に正しくする
//  2. シート全体を走査し、row2以外でヘッダーと完全一致する行を（データではなくヘッダーの
//     コピーだと判断できるので）削除する
// 何回実行しても収束するよう、削除対象が無ければ何もしない。
function repairTaskSheetLayout() {
  return _taskLedgerWithLock_(function() {
    const sheet = _taskSheetEnsureTab_();
    const lastRow = sheet.getLastRow();
    const lastColumn = sheet.getLastColumn();
    const allRows = lastRow > 0 ? sheet.getRange(1, 1, lastRow, lastColumn).getDisplayValues() : [];
    const plan = taskSheetPlanRepair(allRows, TASK_SHEET_HEADERS_);
    // 行番号がずれないよう、下の行から順に削除する。
    plan.deleteRows.slice().sort(function(a, b) { return b - a; }).forEach(function(rowNumber) {
      sheet.deleteRow(rowNumber);
    });
    const afterLastColumn = sheet.getLastColumn();
    return {
      ok: true,
      deletedRowCount: plan.deleteRows.length,
      deletedRows: plan.deleteRows,
      layout: {
        row1: afterLastColumn > 0 ? sheet.getRange(1, 1, 1, afterLastColumn).getDisplayValues()[0] : [],
        row2: afterLastColumn > 0 ? sheet.getRange(2, 1, 1, afterLastColumn).getDisplayValues()[0] : [],
        lastRow: sheet.getLastRow()
      }
    };
  });
}
